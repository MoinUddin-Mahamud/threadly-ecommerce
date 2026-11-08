// Extra admin routes: product import from CSV and two-factor login setup.
const rateLimit = require('express-rate-limit');
const Product = require('../models/Product');
const AdminTwoFactor = require('../models/AdminTwoFactor');
const { logAudit } = require('../services/auditService');
const csvImport = require('../services/csvImport');
const twoFactor = require('../services/twoFactor');
const totp = require('../services/totp');
const marketplace = require('../services/marketplace');
const { brandName } = require('../services/brand');
const Vendor = require('../models/Vendor');
const Payout = require('../models/Payout');
const User = require('../models/User');
const { fromMinor, fixedAmount } = require('../services/money');
const { adjustStock, applySizeStockChange } = require('../services/stock');
const { tracksSizes } = require('../services/sizes');

const normTitle = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();

module.exports = function attachAdminExtras(router, h) {
  const { requireAuth, requireCsrf, requirePermission, getAccessContext, verifyOwnPassword } = h;

  const importLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
    message: { message: 'Too many import requests. Please wait a few minutes.' }
  });
  const twoFactorLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
    message: { message: 'Too many attempts. Please wait a few minutes.' }
  });


  router.get('/products/import/template', requireAuth, requirePermission('product.create'), (req, res) => {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="products-template.csv"');
    res.send(csvImport.TEMPLATE_CSV);
  });

  // POST { csv, mode: 'create' | 'update' | 'upsert', dryRun }
  // Only dryRun === false saves anything; every other request is a preview.
  router.post('/products/import', requireAuth, requireCsrf, importLimiter, async (req, res) => {
    try {
      const { csv, mode, dryRun } = req.body || {};
      if (!csvImport.MODES.includes(mode)) {
        return res.status(400).json({ message: 'Choose an import mode: create, update or upsert.' });
      }

      const ctx = await getAccessContext(req);
      if (!ctx) return res.status(401).json({ message: 'Unauthorized. Please login.' });
      const needs = mode === 'create' ? ['product.create'] : mode === 'update' ? ['product.edit'] : ['product.create', 'product.edit'];
      if (!ctx.isSuper && !needs.every((p) => ctx.permissions.has(p))) {
        return res.status(403).json({ message: 'You do not have permission to do this.' });
      }

      const read = csvImport.readProductCsv(csv);
      if (!read.ok) return res.status(400).json({ message: read.message });

      // Only the store's OWN products can be matched (vendorId empty). A vendor's product that
      // happens to have the same title is never updated by an admin import: that would change
      // another seller's listing. In "add" mode such a title creates a store product.
      const existing = new Map();
      const stockWhenRead = new Map();   // the stock each product had when the file was read
      const sizesWhenRead = new Map();   // the stock per size of products that keep it per size
      for (const p of await Product.find({ vendorId: null }).select('title stock sizeStock').lean()) {
        const key = normTitle(p.title);
        if (!existing.has(key)) {
          existing.set(key, p._id); stockWhenRead.set(String(p._id), Number(p.stock) || 0);
          if (tracksSizes(p)) sizesWhenRead.set(String(p._id), { ...p.sizeStock });
        }
      }
      const plan = csvImport.planImport(read.rows, existing, mode);
      const apply = dryRun === false;

      if (apply) {
        for (const r of plan.results) {
          if (r.action === 'create') {
            try {
              const doc = await Product.create(r.values);
              r.id = String(doc._id);
            } catch (err) {
              r.action = 'error';
              r.message = err && err.name === 'ValidationError'
                ? 'Not saved: ' + Object.values(err.errors).map((e) => e.message).join(', ')
                : 'Not saved: database error.';
              if (!(err && err.name === 'ValidationError')) console.error('CSV import create error:', err);
            }
          } else if (r.action === 'update') {
            try {
              // vendorId stays in the filter, so a product handed to a vendor during the import is
              // not touched.
              const { stock: newStock, sizeStock: newSizes, ...otherValues } = r.values;
              const doc = await Product.findOneAndUpdate({ _id: r.id, vendorId: null }, otherValues, { returnDocument: 'after', runValidators: true });
              if (!doc) { r.action = 'skip'; r.message = 'The product was deleted while importing.'; }
              else if (newSizes) await applySizeStockChange(doc._id, sizesWhenRead.get(String(r.id)) || {}, newSizes);
              else if (newStock !== undefined && sizesWhenRead.has(String(r.id))) r.message = 'The stock cell was ignored: this product keeps its stock per size (use the sizes column).';
              else if (newStock !== undefined) await adjustStock(doc._id, newStock - (stockWhenRead.get(String(r.id)) || 0));
            } catch (err) {
              r.action = 'error';
              r.message = err && err.name === 'ValidationError'
                ? 'Not saved: ' + Object.values(err.errors).map((e) => e.message).join(', ')
                : 'Not saved: database error.';
              if (!(err && err.name === 'ValidationError')) console.error('CSV import update error:', err);
            }
          }
        }
        // recount: a row may have turned into an error while saving
        plan.counts = { create: 0, update: 0, skip: 0, error: 0 };
        plan.results.forEach((r) => { plan.counts[r.action]++; });

        if (plan.counts.create + plan.counts.update > 0) {
          const io = req.app.get('io');
          if (io) io.emit('productUpdate');
        }
        logAudit({
          actor: req.session.username,
          action: 'IMPORT_PRODUCTS',
          targetType: 'Product',
          after: { mode, rows: plan.results.length, ...plan.counts },
          ip: req.ip
        });
      }

      res.json({
        dryRun: !apply,
        mode,
        counts: plan.counts,
        results: plan.results.map(({ line, title, action, message }) => ({ line, title, action, message }))
      });
    } catch (err) {
      console.error('CSV import error:', err);
      res.status(500).json({ message: 'The import failed. Nothing more was changed after the error.' });
    }
  });

  // Two-factor routes (ADMIN_2FA_ENABLED=true)
  const keyOf = (req) => twoFactor.keyFor(req.session.source, req.session.username);
  const notOn = (res) => res.status(400).json({ message: 'Two-factor login is not turned on for this store (set ADMIN_2FA_ENABLED=true in .env and restart).' });

  router.get('/2fa/status', requireAuth, async (req, res) => {
    try {
      if (!twoFactor.featureEnabled()) return res.json({ featureEnabled: false, enabled: false });
      const doc = await AdminTwoFactor.findOne({ key: keyOf(req) });
      res.json({
        featureEnabled: true,
        enabled: !!(doc && doc.enabled),
        backupCodesLeft: doc && doc.enabled ? (doc.backupCodeHashes || []).length : 0
      });
    } catch (err) {
      console.error('2FA status error:', err);
      res.status(500).json({ message: 'Could not load the two-factor status.' });
    }
  });

  // Step 1: make a secret. It does nothing until step 2 proves the phone works.
  router.post('/2fa/setup', requireAuth, requireCsrf, twoFactorLimiter, async (req, res) => {
    try {
      if (!twoFactor.featureEnabled()) return notOn(res);
      const key = keyOf(req);
      const existing = await AdminTwoFactor.findOne({ key });
      if (existing && existing.enabled) {
        return res.status(400).json({ message: 'Two-factor login is already on. Turn it off first to set it up again.' });
      }
      const secret = totp.generateSecret();
      await AdminTwoFactor.updateOne(
        { key },
        { $set: { secret: twoFactor.encryptSecret(secret), enabled: false, lastStep: 0, backupCodeHashes: [], failedAttempts: 0, lockedUntil: null } },
        { upsert: true }
      );
      res.json({ secret, otpauthUrl: totp.otpauthUrl(secret, req.session.username, brandName()) });
    } catch (err) {
      console.error('2FA setup error:', err);
      res.status(500).json({ message: 'Could not start the two-factor setup.' });
    }
  });

  // Step 2: the admin types the first code from the app. Backup codes are shown once.
  router.post('/2fa/enable', requireAuth, requireCsrf, twoFactorLimiter, async (req, res) => {
    try {
      if (!twoFactor.featureEnabled()) return notOn(res);
      const key = keyOf(req);
      const doc = await AdminTwoFactor.findOne({ key });
      if (!doc || doc.enabled) return res.status(400).json({ message: 'Start the setup first.' });

      const step = totp.verifyTotp(twoFactor.decryptSecret(doc.secret), (req.body || {}).code, { lastStep: 0 });
      if (step === null) {
        return res.status(400).json({ message: 'That code is not correct. Check the code in your app and the time on your phone, then try again.' });
      }
      const backupCodes = totp.generateBackupCodes(8);
      await AdminTwoFactor.updateOne({ _id: doc._id }, {
        $set: { enabled: true, lastStep: step, backupCodeHashes: backupCodes.map(totp.hashBackupCode), failedAttempts: 0, lockedUntil: null }
      });
      logAudit({ actor: req.session.username, action: 'ENABLE_2FA', targetType: 'Admin', targetId: req.session.username, ip: req.ip });
      res.json({ enabled: true, backupCodes });
    } catch (err) {
      console.error('2FA enable error:', err);
      res.status(500).json({ message: 'Could not turn on two-factor login.' });
    }
  });

  // Turning it off needs the password AND a current code (or a backup code).
  router.post('/2fa/disable', requireAuth, requireCsrf, twoFactorLimiter, async (req, res) => {
    try {
      if (!twoFactor.featureEnabled()) return notOn(res);
      const { password, code } = req.body || {};
      const doc = await twoFactor.findActive(keyOf(req));
      if (!doc) return res.status(400).json({ message: 'Two-factor login is not on.' });
      if (!(await verifyOwnPassword(req, password))) {
        return res.status(400).json({ message: 'Your password is not correct.' });
      }
      const check = await twoFactor.verifyLogin(doc, code);
      if (!check.ok) return res.status(400).json({ message: check.message });
      await AdminTwoFactor.deleteOne({ _id: doc._id });
      logAudit({ actor: req.session.username, action: 'DISABLE_2FA', targetType: 'Admin', targetId: req.session.username, ip: req.ip });
      res.json({ enabled: false });
    } catch (err) {
      console.error('2FA disable error:', err);
      res.status(500).json({ message: 'Could not turn off two-factor login.' });
    }
  });

  // Vendors, commissions and payouts (MULTIVENDOR_ENABLED=true)
  const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
  const needMarketplace = (req, res, next) =>
    marketplace.enabled() ? next() : res.status(404).json({ message: 'The marketplace is not enabled (set MULTIVENDOR_ENABLED=true in .env).' });
  const vendorLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false,
    message: { message: 'Too many requests. Please wait a few minutes.' }
  });

  router.get('/vendors', requireAuth, requirePermission('vendor.view'), needMarketplace, async (req, res) => {
    try {
      const vendors = await Vendor.find().sort({ createdAt: -1 }).limit(200).lean();
      const owners = await User.find({ _id: { $in: vendors.map((v) => v.ownerUserId).filter(Boolean) } }).select('name email').lean();
      const ownerById = new Map(owners.map((u) => [String(u._id), u]));
      const out = [];
      for (const v of vendors) {
        const owner = ownerById.get(String(v.ownerUserId));
        out.push({
          id: String(v._id), name: v.name, slug: v.slug, status: v.status, phone: v.phone,
          commissionPercent: v.commissionPercent, createdAt: v.createdAt,
          ownerName: owner ? owner.name : '', ownerEmail: owner ? owner.email : '',
          products: await Product.countDocuments({ vendorId: v._id })
        });
      }
      res.json(out);
    } catch (err) {
      console.error('Admin vendors error:', err);
      res.status(500).json({ message: 'Could not load the vendors.' });
    }
  });

  // Approve / suspend a vendor and set their commission (applies to new orders only).
  router.patch('/vendors/:id', requireAuth, requireCsrf, requirePermission('vendor.edit'), needMarketplace, vendorLimiter, async (req, res) => {
    try {
      if (!OBJECT_ID.test(req.params.id)) return res.status(400).json({ message: 'Invalid vendor.' });
      const { status, commissionPercent } = req.body || {};
      const vendor = await Vendor.findById(req.params.id);
      if (!vendor) return res.status(404).json({ message: 'Vendor not found.' });

      const set = {};
      if (status !== undefined) {
        if (!['pending', 'approved', 'suspended'].includes(status)) return res.status(400).json({ message: 'Invalid status.' });
        set.status = status;
        if (status === 'approved' && !vendor.approvedAt) set.approvedAt = new Date();
      }
      if (commissionPercent !== undefined) {
        const text = String(commissionPercent).trim();
        const n = Number(text);
        if (!/^\d+(\.\d{1,2})?$/.test(text) || n > 90) return res.status(400).json({ message: 'Commission must be between 0 and 90 percent.' });
        set.commissionPercent = n;
      }
      if (Object.keys(set).length === 0) return res.status(400).json({ message: 'Nothing to change.' });

      await Vendor.updateOne({ _id: vendor._id }, { $set: set });
      const io = req.app.get('io');
      if (io && set.status) io.emit('productUpdate');   // storefronts refresh: a suspended shop's products disappear
      logAudit({
        actor: req.session.username, action: 'UPDATE_VENDOR', targetType: 'Vendor', targetId: String(vendor._id),
        before: { status: vendor.status, commissionPercent: vendor.commissionPercent }, after: set, ip: req.ip
      });
      res.json({ id: String(vendor._id), ...set });
    } catch (err) {
      console.error('Admin vendor update error:', err);
      res.status(500).json({ message: 'Could not update the vendor.' });
    }
  });

  router.get('/vendors/:id/earnings', requireAuth, requirePermission('vendor.view'), needMarketplace, async (req, res) => {
    try {
      if (!OBJECT_ID.test(req.params.id)) return res.status(400).json({ message: 'Invalid vendor.' });
      if (!(await Vendor.exists({ _id: req.params.id }))) return res.status(404).json({ message: 'Vendor not found.' });
      res.json(await marketplace.earningsFor(req.params.id));
    } catch (err) {
      console.error('Admin vendor earnings error:', err);
      res.status(500).json({ message: 'Could not load the earnings.' });
    }
  });

  // Record that the vendor was paid everything that is payable now (delivered orders
  // not paid out before). The money itself is sent outside the app.
  router.post('/vendors/:id/payouts', requireAuth, requireCsrf, requirePermission('vendor.edit'), needMarketplace, vendorLimiter, async (req, res) => {
    try {
      if (!OBJECT_ID.test(req.params.id)) return res.status(400).json({ message: 'Invalid vendor.' });
      const vendor = await Vendor.findById(req.params.id);
      if (!vendor) return res.status(404).json({ message: 'Vendor not found.' });

      // Every delivered, unpaid order (not only the newest ones), minus clawbacks for
      // orders cancelled after an earlier payout.
      const fullPlan = await marketplace.payoutPlan(vendor._id);
      // One payout record holds at most MAX_PAYOUT_ORDERS orders (the oldest first), so a record
      // cannot grow past the database's document size limit.
      const byAge = (a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
      const due = [...fullPlan.payable].sort(byAge).slice(0, marketplace.MAX_PAYOUT_ORDERS);
      const clawbacks = [...fullPlan.clawbacks].sort(byAge).slice(0, marketplace.MAX_PAYOUT_ORDERS);
      const sum = (lines) => lines.reduce((a, l) => a + l.net, 0);
      const plan = {
        payable: due, clawbacks,
        payableMinor: sum(due), clawbackMinor: sum(clawbacks), amountMinor: sum(due) - sum(clawbacks),
        remaining: fullPlan.payable.length - due.length
      };
      if (due.length === 0) {
        return res.status(400).json({ message: plan.clawbackMinor > 0
          ? `Nothing is payable. This vendor owes ${fixedAmount(fromMinor(plan.clawbackMinor))} back for cancelled orders; it will be taken off their next payout.`
          : 'Nothing is payable to this vendor right now.' });
      }
      if (plan.amountMinor <= 0) {
        return res.status(400).json({ message: `The clawback for cancelled orders (${fixedAmount(fromMinor(plan.clawbackMinor))}) is not smaller than what is payable (${fixedAmount(fromMinor(plan.payableMinor))}). No payout was recorded; it stays against future earnings.` });
      }
      const amountMinor = plan.amountMinor;

      const note = typeof (req.body || {}).note === 'string' ? req.body.note.trim().slice(0, 300) : '';
      let payout;
      try {
        payout = await Payout.create({
          vendorId: vendor._id, amount: fromMinor(amountMinor), note, paidBy: req.session.username,
          orderIds: due.map((l) => l.orderId), clawbackOrderIds: plan.clawbacks.map((l) => l.orderId),
          lineKeys: [
            ...due.map((l) => l.paidOutCount ? `${vendor._id}:${l.orderId}:${l.paidOutCount}` : `${vendor._id}:${l.orderId}`),
            ...plan.clawbacks.map((l) => l.settledCount ? `${vendor._id}:${l.orderId}:clawback:${l.settledCount}` : `${vendor._id}:${l.orderId}:clawback`)
          ]
        });
      } catch (err) {
        // The unique index refused an order that is already in another payout.
        if (err && err.code === 11000) return res.status(409).json({ message: 'Some of these orders were just paid out. Refresh and check again.' });
        throw err;
      }
      logAudit({
        actor: req.session.username, action: 'CREATE_PAYOUT', targetType: 'Vendor', targetId: String(vendor._id),
        after: { amount: payout.amount, orders: due.length, clawbacks: plan.clawbacks.length }, ip: req.ip
      });
      res.status(201).json({ id: String(payout._id), amount: payout.amount, orders: due.length, remaining: plan.remaining });
    } catch (err) {
      console.error('Admin payout error:', err);
      res.status(500).json({ message: 'Could not record the payout.' });
    }
  });
};
