// Marketplace routes (only when MULTIVENDOR_ENABLED=true).
// /api/shops: public approved shops and one shop's page data.
// /api/vendor: a seller's own area (apply, products, orders, earnings, profile).
const express = require('express');
const rateLimit = require('express-rate-limit');
const Vendor = require('../models/Vendor');
const Product = require('../models/Product');
const Order = require('../models/Order');
const User = require('../models/User');
const marketplace = require('../services/marketplace');
const emailService = require('../services/emailService');
const productRules = require('../services/productRules');
const Review = require('../models/Review');
const { cleanImageInput, cleanImageList, publicProduct } = require('../services/images');
const { storageMode, storeImageValue, applyPictures, removeUnusedUploads, picturesOf, storedPictureCount, MAX_PICTURES_PER_VENDOR, UPLOAD_URL } = require('../services/uploads');
const { fromMinor } = require('../services/money');
const sameOrigin = require('../middleware/sameOrigin');
const { plainName } = require('../services/plainText');

const vendorRouter = express.Router();
const shopsRouter = express.Router();

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const { CATEGORIES, canonicalCategory, CATEGORY_MESSAGE } = require('../services/categories');
const { parsePreviousStock } = require('../services/stock');
const { isUsablePhone } = require('../services/cod');
const { cleanSizeStock, sizeStockTotal } = require('../services/sizes');
const { planStockChange, applyStockChange, savePictures } = require('../services/productUpdate');
const MAX_PRODUCTS_PER_VENDOR = 500;
const NEXT_STEP = { PENDING: ['SHIPPED'], SHIPPED: ['DELIVERED'] };

const text = (v, max) => (typeof v === 'string' ? v.trim().substring(0, max) : '');
const applyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
  message: { message: 'Too many applications. Please try again later.' }
});
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false,
  message: { message: 'Too many requests. Please wait a few minutes.' }
});

// Both routers 404 while the marketplace is off.
const needMarketplace = (req, res, next) =>
  marketplace.enabled() ? next() : res.status(404).json({ message: 'The marketplace is not enabled.' });
shopsRouter.use(needMarketplace);
vendorRouter.use(needMarketplace);
// Writes must come from this site (see middleware/sameOrigin.js).
vendorRouter.use(sameOrigin);

const publicShop = (v, productCount) => ({
  name: v.name, slug: v.slug, description: v.description,
  since: v.approvedAt || v.createdAt, ...(productCount === undefined ? {} : { productCount })
});

shopsRouter.get('/', async (req, res) => {
  try {
    const vendors = await Vendor.find({ status: 'approved' }).sort({ approvedAt: 1 }).limit(24).lean();
    const out = [];
    for (const v of vendors) out.push(publicShop(v, await Product.countDocuments({ vendorId: v._id })));
    res.json(out);
  } catch (err) {
    console.error('Shops list error:', err.message);
    res.status(500).json({ message: 'Could not load the shops.' });
  }
});

shopsRouter.get('/:slug', async (req, res) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase().slice(0, 60);
    const vendor = await Vendor.findOne({ slug, status: 'approved' }).lean();
    if (!vendor) return res.status(404).json({ message: 'Shop not found.' });
    res.json(publicShop(vendor, await Product.countDocuments({ vendorId: vendor._id })));
  } catch (err) {
    console.error('Shop error:', err.message);
    res.status(500).json({ message: 'Could not load the shop.' });
  }
});

const requireUser = (req, res, next) => {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ message: 'Please log in first.' });
};

// Loads the logged-in customer's shop into req.vendor.
async function requireVendor(req, res, next) {
  try {
    const user = await User.findById(req.session.userId).select('vendorId');
    if (!user || !user.vendorId) return res.status(403).json({ message: 'You do not have a shop yet.', notVendor: true });
    const vendor = await Vendor.findById(user.vendorId);
    if (!vendor) return res.status(403).json({ message: 'You do not have a shop yet.', notVendor: true });
    req.vendor = vendor;
    next();
  } catch (err) {
    console.error('Vendor lookup error:', err.message);
    res.status(500).json({ message: 'Something went wrong.' });
  }
}
function requireApproved(req, res, next) {
  if (req.vendor.status === 'approved') return next();
  res.status(403).json({
    message: req.vendor.status === 'pending' ? 'Your shop is waiting for approval.' : 'Your shop is suspended. Please contact the store.'
  });
}

const privateShop = (v) => ({
  id: String(v._id), name: v.name, slug: v.slug, description: v.description, phone: v.phone,
  status: v.status, commissionPercent: v.commissionPercent
});

// Whether this customer is a seller yet (also tells the page if selling is open).
vendorRouter.get('/me', requireUser, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId).select('vendorId');
    const vendor = user && user.vendorId ? await Vendor.findById(user.vendorId) : null;
    res.json({ vendor: vendor ? privateShop(vendor) : null, categories: CATEGORIES, defaultCommission: marketplace.defaultCommission() });
  } catch (err) {
    console.error('Vendor me error:', err.message);
    res.status(500).json({ message: 'Something went wrong.' });
  }
});

// A customer applies for a shop; an admin approves it.
vendorRouter.post('/apply', requireUser, applyLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    const name = plainName(text(b.shopName, 60));   // plain text: no < > or control characters
    const description = text(b.description, 500);
    const phone = text(b.phone, 30);
    if (name.length < 2) return res.status(400).json({ message: 'Shop name must be at least 2 characters.' });
    if (phone && !isUsablePhone(phone)) return res.status(400).json({ message: 'Phone number is not valid.' });

    const user = await User.findById(req.session.userId).select('vendorId');
    if (!user) return res.status(401).json({ message: 'Please log in first.' });
    if (user.vendorId) return res.status(409).json({ message: 'You already have a shop.' });

    const base = marketplace.slugify(name);
    let vendor = null;
    for (let i = 1; i <= 20 && !vendor; i++) {
      const slug = i === 1 ? base : `${base}-${i}`;
      if (await Vendor.exists({ slug })) continue;
      try {
        vendor = await Vendor.create({
          name, slug, description, phone, status: 'pending',
          commissionPercent: marketplace.defaultCommission(), ownerUserId: user._id
        });
      } catch (err) {
        if (!(err && err.code === 11000)) throw err;   // slug taken a moment ago: try the next one
      }
    }
    if (!vendor) return res.status(409).json({ message: 'Please choose a different shop name.' });

    // Claim the account only if it has no shop yet (guards against two simultaneous applications).
    const claim = await User.updateOne({ _id: user._id, vendorId: null }, { $set: { vendorId: vendor._id } });
    if (!(claim.modifiedCount || claim.nModified)) {
      await Vendor.deleteOne({ _id: vendor._id });
      return res.status(409).json({ message: 'You already have a shop.' });
    }
    res.status(201).json({ vendor: privateShop(vendor) });
  } catch (err) {
    console.error('Vendor apply error:', err.message);
    res.status(500).json({ message: 'Could not send your application.' });
  }
});

vendorRouter.use(requireUser, requireVendor);

vendorRouter.put('/profile', writeLimiter, async (req, res) => {
  try {
    // Only fields that were sent change; omitted ones keep their value and wrong types are refused.
    const b = req.body || {};
    const set = {};
    if (b.description !== undefined) {
      if (typeof b.description !== 'string') return res.status(400).json({ message: 'Description must be text.' });
      set.description = text(b.description, 500);
    }
    if (b.phone !== undefined) {
      if (typeof b.phone !== 'string') return res.status(400).json({ message: 'Phone number must be text.' });
      set.phone = text(b.phone, 30);
      if (set.phone && !isUsablePhone(set.phone)) return res.status(400).json({ message: 'Phone number is not valid.' });
    }
    if (Object.keys(set).length === 0) return res.status(400).json({ message: 'Nothing to change.' });
    await Vendor.updateOne({ _id: req.vendor._id }, { $set: set });
    res.json({ vendor: privateShop({ ...req.vendor.toObject(), ...set }) });
  } catch (err) {
    console.error('Vendor profile error:', err.message);
    res.status(500).json({ message: 'Could not save your shop details.' });
  }
});

vendorRouter.get('/dashboard', async (req, res) => {
  try {
    const vid = req.vendor._id;
    const [products, toShip, earnings] = await Promise.all([
      Product.countDocuments({ vendorId: vid }),
      // PLACED orders await store confirmation, so they cannot ship yet and are not counted.
      Order.countDocuments({ fulfillment: { $elemMatch: { vendorId: vid, status: 'PENDING' } }, status: { $nin: ['PENDING', 'PLACED', 'CANCELLED'] } }),
      marketplace.earningsFor(vid, { maxLines: 0 })
    ]);
    res.json({ vendor: privateShop(req.vendor), products, ordersToShip: toShip, earnings: earnings.totals });
  } catch (err) {
    console.error('Vendor dashboard error:', err.message);
    res.status(500).json({ message: 'Could not load your dashboard.' });
  }
});

function readProduct(body) {
  const b = body || {};
  const title = plainName(text(b.title, 200));   // plain text: no < > or control characters
  if (title.length < 2) return { error: 'Title must be at least 2 characters.' };
  const description = text(b.description, 1000);
  const priceRule = productRules.parsePrice(b.price);
  if (!priceRule.ok) return { error: priceRule.message };
  // Optional stock per size; the total is then the sum of the sizes.
  const sizes = cleanSizeStock(b.sizeStock);
  if (!sizes.ok) return { error: sizes.message };
  const stockText = sizes.value
    ? String(sizeStockTotal(sizes.value))
    : String(b.stock === undefined || b.stock === null || b.stock === '' ? 0 : b.stock).trim();
  if (!/^\d+$/.test(stockText) || Number(stockText) > 100000) return { error: 'Stock must be a whole number from 0 to 100000.' };
  const category = canonicalCategory(b.category);
  if (!category) return { error: CATEGORY_MESSAGE };
  const image = cleanImageInput(b.imageUrl);
  if (!image.ok) return { error: image.message };
  const gallery = cleanImageList(b.images, { allowUploads: storageMode() === 'disk' });
  if (!gallery.ok) return { error: gallery.message };
  const data = { title, description, price: priceRule.value, stock: Number(stockText), category };
  if (sizes.value) data.sizeStock = sizes.value;
  // The picture changes only when one was sent. This app's own uploaded-picture address means "keep the stored picture", as in the admin panel.
  if (b.imageUrl !== undefined && !image.keep) data.imageUrl = image.value || '';
  return { data, sizes, gallery };
}

vendorRouter.get('/products', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const [products, total] = await Promise.all([
      Product.find({ vendorId: req.vendor._id }).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Product.countDocuments({ vendorId: req.vendor._id })
    ]);
    res.json({
      products: products.map(publicProduct),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (err) {
    console.error('Vendor products error:', err.message);
    res.status(500).json({ message: 'Could not load your products.' });
  }
});

// Stores one picture as a file and returns its address (see the admin route of the same name).
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false,
  message: { message: 'Too many uploads. Please wait a few minutes.' }
});
vendorRouter.post('/upload-image', requireApproved, uploadLimiter, async (req, res) => {
  try {
    if (storageMode() !== 'disk') return res.status(400).json({ message: 'Picture files are switched off on this store.' });
    const image = cleanImageInput((req.body || {}).data);
    if (!image.ok || !String(image.value || '').startsWith('data:')) {
      return res.status(400).json({ message: image.ok ? 'Send the picture as an upload.' : image.message });
    }
    if (await storedPictureCount(req.vendor._id) >= MAX_PICTURES_PER_VENDOR) {
      return res.status(429).json({ message: `A shop can keep at most ${MAX_PICTURES_PER_VENDOR} pictures. Remove pictures you no longer use.` });
    }
    const url = await storeImageValue(image.value);
    if (!UPLOAD_URL.test(url)) return res.status(500).json({ message: 'The picture could not be saved.' });
    res.status(201).json({ url });
  } catch (err) {
    console.error('Vendor upload picture error:', err.message);
    res.status(500).json({ message: 'Could not save the picture.' });
  }
});

vendorRouter.post('/products', requireApproved, writeLimiter, async (req, res) => {
  try {
    const parsed = readProduct(req.body);
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    if (await Product.countDocuments({ vendorId: req.vendor._id }) >= MAX_PRODUCTS_PER_VENDOR) {
      return res.status(400).json({ message: `A shop can have at most ${MAX_PRODUCTS_PER_VENDOR} products.` });
    }
    await applyPictures(parsed.data, parsed.gallery);   // uploads become files
    const product = await Product.create({ imageUrl: '', ...parsed.data, vendorId: req.vendor._id });
    const io = req.app.get('io');
    if (io) io.emit('productUpdate');
    res.status(201).json(publicProduct(product));
  } catch (err) {
    if (err && err.name === 'ValidationError') return res.status(400).json({ message: Object.values(err.errors).map((e) => e.message).join(', ') });
    console.error('Vendor create product error:', err.message);
    res.status(500).json({ message: 'Could not add the product.' });
  }
});

vendorRouter.put('/products/:id', requireApproved, writeLimiter, async (req, res) => {
  try {
    if (!OBJECT_ID.test(req.params.id)) return res.status(400).json({ message: 'Invalid product.' });
    const parsed = readProduct(req.body);
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    // With previousStock only the change is applied, so units sold while the form was open are not restocked (see services/stock.js).
    const previousStock = parsePreviousStock((req.body || {}).previousStock);
    const data = { ...parsed.data };
    let stockDelta = 0;
    if (parsed.sizes.provided) {
      delete data.stock; delete data.sizeStock;
    } else {
      if (previousStock === null) return res.status(400).json({ message: 'Reload the product before saving it (previousStock is required).' });
      stockDelta = data.stock - previousStock; delete data.stock;
    }
    const mine = { _id: req.params.id, vendorId: req.vendor._id };
    // Stock per size: `sizeStock` is what the form saved, `previousSizeStock` what it was loaded with.
    const plan = await planStockChange({
      findCurrent: () => Product.findOne(mine).select('sizeStock stock'),
      body: req.body || {}, sizes: parsed.sizes, stockDelta, reload: 'it'
    });
    if (plan.error) return res.status(plan.error.status).json({ message: plan.error.message });
    const picturesBefore = await savePictures(data, parsed.gallery, () => Product.findOne(mine).select('imageUrl images').lean());
    // The shop is part of the filter, so another vendor's product is not found.
    let product = await Product.findOneAndUpdate(mine, data, { returnDocument: 'after', runValidators: true });
    if (!product) return res.status(404).json({ message: 'Product not found.' });
    product = await applyStockChange(product, plan);
    if (picturesBefore.length) await removeUnusedUploads(picturesBefore);   // pictures that were replaced or removed
    const io = req.app.get('io');
    if (io) io.emit('productUpdate');
    res.json(publicProduct(product));
  } catch (err) {
    console.error('Vendor update product error:', err.message);
    res.status(500).json({ message: 'Could not save the product.' });
  }
});

vendorRouter.delete('/products/:id', requireApproved, writeLimiter, async (req, res) => {
  try {
    if (!OBJECT_ID.test(req.params.id)) return res.status(400).json({ message: 'Invalid product.' });
    const product = await Product.findOneAndDelete({ _id: req.params.id, vendorId: req.vendor._id });
    if (!product) return res.status(404).json({ message: 'Product not found.' });
    await removeUnusedUploads(picturesOf(product));   // the product's picture files, unless another product uses them
    try { await Review.deleteMany({ productId: product._id }); } catch (e) { /* the product is gone either way */ }
    const io = req.app.get('io');
    if (io) io.emit('productUpdate');
    res.json({ deleted: true });
  } catch (err) {
    console.error('Vendor delete product error:', err.message);
    res.status(500).json({ message: 'Could not delete the product.' });
  }
});

vendorRouter.get('/orders', async (req, res) => {
  try {
    const vid = req.vendor._id;
    // Customer contact details go only to shops in good standing.
    const showCustomers = req.vendor.status === 'approved';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const query = { 'items.vendorId': vid, status: { $ne: 'PENDING' } };
    // ?needs=ship lists only orders this shop can ship now (confirmed, its part not yet shipped).
    if (req.query.needs === 'ship') {
      query.status = { $nin: ['PENDING', 'PLACED', 'CANCELLED'] };
      query.fulfillment = { $elemMatch: { vendorId: vid, status: 'PENDING' } };
    }

    const [orders, total] = await Promise.all([
      Order.find(query)
        .select('items status fulfillment createdAt customerName customerPhone deliveryAddress paymentGateway')
        .sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Order.countDocuments(query)
    ]);
    
    const mapped = orders.map((o) => {
      const mine = (o.items || []).filter((i) => String(i.vendorId) === String(vid));
      const share = marketplace.vendorShare(o, vid);
      const f = (o.fulfillment || []).find((x) => String(x.vendorId) === String(vid));
      const hideCustomer = !showCustomers || ['PLACED', 'CANCELLED'].includes(o.status);
      return {
        id: String(o._id), createdAt: o.createdAt, orderStatus: o.status, paymentGateway: o.paymentGateway,
        ...(hideCustomer
          ? { customerName: !showCustomers ? 'Hidden while your shop is suspended' : (o.status === 'PLACED' ? 'Visible after store confirmation' : 'Order cancelled'), customerPhone: '', deliveryAddress: {}, customerHidden: true }
          : { customerName: o.customerName, customerPhone: o.customerPhone, deliveryAddress: o.deliveryAddress }),
        // Only this shop's items; other vendors' items in the same order stay private.
        items: mine.map((i) => ({ title: i.title, quantity: i.quantity, size: i.size, price: i.price })),
        earnings: { gross: fromMinor(share.gross), commission: fromMinor(share.commission), net: fromMinor(share.net) },
        fulfillment: f ? { status: f.status, note: f.note } : { status: 'PENDING', note: '' }
      };
    });

    res.json({
      orders: mapped,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) }
    });
  } catch (err) {
    console.error('Vendor orders error:', err.message);
    res.status(500).json({ message: 'Could not load your orders.' });
  }
});

// Moves PENDING, SHIPPED, DELIVERED one step at a time.
vendorRouter.patch('/orders/:id/fulfillment', requireApproved, writeLimiter, async (req, res) => {
  try {
    if (!OBJECT_ID.test(req.params.id)) return res.status(400).json({ message: 'Invalid order.' });
    const next = String((req.body || {}).status || '');
    const note = text((req.body || {}).note, 200);
    const vid = req.vendor._id;

    const order = await Order.findOne({ _id: req.params.id, 'items.vendorId': vid }).select('status fulfillment');
    if (!order) return res.status(404).json({ message: 'Order not found.' });
    if (order.status === 'PLACED') {
      return res.status(409).json({ message: 'This order is awaiting store confirmation.' });
    }
    if (['PENDING', 'CANCELLED'].includes(order.status)) {
      return res.status(409).json({ message: 'This order is not ready to ship (unpaid or cancelled).' });
    }
    const entry = (order.fulfillment || []).find((x) => String(x.vendorId) === String(vid));
    const current = entry ? entry.status : 'PENDING';
    if (!(NEXT_STEP[current] || []).includes(next)) {
      return res.status(400).json({ message: `Your part of this order is ${current.toLowerCase()}; the next step is ${(NEXT_STEP[current] || ['none'])[0].toLowerCase()}.` });
    }
    // Only applies if nothing changed it since we read it (double click) and the order was not
    // cancelled or taken back meanwhile (its status is checked again in the same update).
    const result = await Order.updateOne(
      { _id: order._id, status: order.status, fulfillment: { $elemMatch: { vendorId: vid, status: current } } },
      { $set: { 'fulfillment.$.status': next, 'fulfillment.$.note': note, 'fulfillment.$.updatedAt': new Date() } }
    );
    if (!(result.modifiedCount || result.nModified)) return res.status(409).json({ message: 'This order was just updated. Please refresh.' });

    // Whole-order status follows seller progress, but only for orders made entirely of sellers' items; staff move mixed orders.
    const fullOrder = await Order.findOne({ _id: order._id });
    if (fullOrder && ['CONFIRMED', 'SHIPPED', 'DELIVERED'].includes(fullOrder.status)) {
      const newStatus = marketplace.derivedStatus(fullOrder);
      if (newStatus && newStatus !== fullOrder.status) {
        const moved = await Order.updateOne(
          { _id: fullOrder._id, status: fullOrder.status },
          { $set: { status: newStatus } }
        );
        if (moved.modifiedCount || moved.nModified) {
          const io = req.app.get('io');
          if (io) io.emit('orderUpdate');
          fullOrder.status = newStatus;
          emailService.sendStatusUpdate(fullOrder).catch((e) => console.error('Status email error:', e.message));
        }
      }
    }

    res.json({ status: next, note });
  } catch (err) {
    console.error('Vendor fulfillment error:', err.message);
    res.status(500).json({ message: 'Could not update the order.' });
  }
});

vendorRouter.get('/earnings', async (req, res) => {
  try {
    res.json(await marketplace.earningsFor(req.vendor._id));
  } catch (err) {
    console.error('Vendor earnings error:', err.message);
    res.status(500).json({ message: 'Could not load your earnings.' });
  }
});

module.exports = { vendorRouter, shopsRouter, CATEGORIES };
