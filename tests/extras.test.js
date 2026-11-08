// Tests for shipping rates, wishlist, CSV product import and two-factor admin login.
// Also checks that every feature is off by default.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const SSLCommerzPayment = require('sslcommerz-lts');
const { app, OWNER, addAccount } = require('./helpers');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const AdminTwoFactor = require('../models/AdminTwoFactor');
const { fakeTwoFactorStore } = require('./fakeDb');
const emailService = require('../services/emailService');
const { shippingSettings, quoteShipping, publicShippingOptions } = require('../services/shipping');
const totp = require('../services/totp');
const csvImport = require('../services/csvImport');

const PRODUCT_ID = '64b7f0c2a1b2c3d4e5f60999';
const ORDER_ID = '64b7f0c2a1b2c3d4e5f60718';
const USER_ID = '64b7f0c2a1b2c3d4e5f60aaa';
const quiet = [console, 'error', () => {}];

async function withStubs(stubs, fn) {
  const saved = stubs.map(([target, name]) => [target, name, target[name]]);
  stubs.forEach(([target, name, impl]) => { target[name] = impl; });
  try { await fn(); } finally { saved.forEach(([target, name, original]) => { target[name] = original; }); }
}
async function withEnv(vars, fn) {
  const saved = Object.keys(vars).map((k) => [k, process.env[k]]);
  Object.entries(vars).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  try { await fn(); } finally { saved.forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; }); }
}
async function ownerLogin(extra = {}) {
  const agent = request.agent(app);
  const res = await agent.post('/admin/login').send({ ...OWNER, ...extra });
  return { agent, res, csrf: res.body.csrfToken };
}

test('shipping and 2FA are all off by default', async () => {
  assert.equal(shippingSettings({}).enabled, false);
  assert.deepEqual(publicShippingOptions(shippingSettings({})), { enabled: false });
  assert.deepEqual(quoteShipping(500, 'Dhaka', shippingSettings({})), { fee: 0, free: false, zone: null });
  assert.equal((await request(app).get('/api/shipping-options')).body.enabled, false);
  const { agent, res } = await ownerLogin();
  assert.equal(res.status, 200);
  assert.equal((await agent.get('/admin/2fa/status')).body.featureEnabled, false);
});

test('shipping: flat rate, home-city rate, free over a limit, and bad settings are ignored', () => {
  const on = shippingSettings({ SHIPPING_ENABLED: 'TRUE', SHIPPING_FLAT_RATE: '120', SHIPPING_FREE_OVER: '5000', SHIPPING_HOME_CITY: 'Dhaka', SHIPPING_HOME_RATE: '60' });
  assert.equal(quoteShipping(1000, 'Chattogram', on).fee, 120);
  assert.equal(quoteShipping(1000, '  DHAKA ', on).fee, 60);
  assert.equal(quoteShipping(1000, '', on).fee, 120);
  assert.deepEqual(quoteShipping(5000, 'Dhaka', on), { fee: 0, free: true, zone: 'free' });
  assert.equal(quoteShipping(4999.99, 'Dhaka', on).fee, 60);
  // a home rate without a home city does nothing; junk values never become a fee
  const odd = shippingSettings({ SHIPPING_ENABLED: 'true', SHIPPING_FLAT_RATE: '-5', SHIPPING_HOME_RATE: '50', SHIPPING_FREE_OVER: 'abc' });
  assert.equal(odd.flatRate, 0); assert.equal(odd.homeRate, null); assert.equal(odd.freeOver, 0);
  assert.equal(shippingSettings({ SHIPPING_ENABLED: '1' }).enabled, false);
});

const address = { address: '1 Main St', city: 'Dhaka', postcode: '1200', country: 'Bangladesh' };
const orderBody = (extra = {}, city = 'Dhaka', qty = 2) => ({
  customerName: 'Buyer', customerEmail: 'buyer@example.com', customerPhone: '01700000000',
  deliveryAddress: { ...address, city }, paymentGateway: 'cod',
  items: [{ productId: PRODUCT_ID, quantity: qty, size: 'M' }], ...extra
});
function store(log) {
  log.created = []; log.gateway = [];
  return [
    quiet,
    [Product, 'findById', async () => ({ _id: PRODUCT_ID, title: 'Bomber', price: 100, stock: 500 })],
    [Product, 'findOneAndUpdate', async () => ({})],
    [Product, 'updateOne', async () => ({})],
    [Order, 'create', async (doc) => { log.created.push(doc); return { _id: ORDER_ID, ...doc }; }],
    [Order, 'updateOne', async () => ({})],
    [emailService, 'sendOrderConfirmation', () => Promise.resolve()],
    [SSLCommerzPayment.prototype, 'init', async (d) => { log.gateway.push(d); return { GatewayPageURL: 'https://pay.example/x' }; }]
  ];
}
const SHIP_ENV = { COD_ENABLED: 'true', SHIPPING_ENABLED: 'true', SHIPPING_FLAT_RATE: '120', SHIPPING_FREE_OVER: '1000', SHIPPING_HOME_CITY: 'Dhaka', SHIPPING_HOME_RATE: '60' };

test('checkout with shipping on: the fee is added to the total that is charged', async () => {
  const log = {};
  await withEnv(SHIP_ENV, () => withStubs(store(log), async () => {
    let res = await request(app).post('/api/orders').send(orderBody({}, 'Dhaka'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(log.created[0].totalAmount, 260);       // 200 goods + 60 inside Dhaka
    assert.equal(log.created[0].shippingAmount, 60);
    assert.equal(log.created[0].subtotalAmount, 200);

    res = await request(app).post('/api/orders').send(orderBody({}, 'Chattogram'));
    assert.equal(res.status, 200);
    assert.equal(log.created[1].totalAmount, 320);       // 200 + 120 elsewhere

    // 10 shirts = 1000 goods = free shipping (card gateway: Cash on Delivery limits items per line)
    res = await request(app).post('/api/orders').send(orderBody({ paymentGateway: 'sslcommerz' }, 'Chattogram', 10));
    assert.equal(res.status, 200);
    assert.equal(log.created[2].totalAmount, 1000);
    assert.equal('shippingAmount' in log.created[2], false);
  }));
});

test('checkout with shipping on: online payment is charged the total including shipping', async () => {
  const log = {};
  await withEnv({ ...SHIP_ENV }, () => withStubs(store(log), async () => {
    const res = await request(app).post('/api/orders').send(orderBody({ paymentGateway: 'sslcommerz' }, 'Dhaka'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(log.gateway[0].total_amount, 260);
  }));
});

test('checkout: an expected total without the shipping fee is refused, with the real total', async () => {
  const log = {};
  await withEnv(SHIP_ENV, () => withStubs(store(log), async () => {
    const stale = await request(app).post('/api/orders').send(orderBody({ expectedTotal: 200 }, 'Dhaka'));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.priceChanged, true);
    assert.equal(stale.body.serverTotal, 260);
    assert.equal(log.created.length, 0, 'nothing was created');
    const right = await request(app).post('/api/orders').send(orderBody({ expectedTotal: 260 }, 'Dhaka'));
    assert.equal(right.status, 200);
  }));
});

test('checkout with shipping off is unchanged: no fee, no shippingAmount field', async () => {
  const log = {};
  await withEnv({ COD_ENABLED: 'true', SHIPPING_ENABLED: undefined }, () => withStubs(store(log), async () => {
    const res = await request(app).post('/api/orders').send(orderBody({ expectedTotal: 200 }, 'Dhaka'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(log.created[0].totalAmount, 200);
    assert.equal('shippingAmount' in log.created[0], false);
  }));
});

test('the Order model stores shippingAmount, defaulting to 0', async () => {
  const base = { customerName: 'A', customerEmail: 'a@b.com', totalAmount: 5, paymentGateway: 'cod' };
  assert.equal(new Order(base).shippingAmount, 0);
  assert.equal(new Order({ ...base, shippingAmount: 60 }).shippingAmount, 60);
  await assert.rejects(new Order({ ...base, shippingAmount: -1 }).validate());
});

test('the public shipping endpoint reflects the settings', async () => {
  await withEnv({ ...SHIP_ENV }, async () => {
    const s = (await request(app).get('/api/shipping-options')).body;
    assert.deepEqual(s, { enabled: true, flatRate: 120, freeOver: 1000, homeCity: 'Dhaka', homeRate: 60 });
    assert.equal((await request(app).get('/api/currencies')).status, 404, 'the display-currency endpoint is gone');
  });
});

test('wishlist: needs login, validates ids, adds, lists and removes', async () => {
  assert.equal((await request(app).get('/api/users/wishlist')).status, 401);
  assert.equal((await request(app).post('/api/users/wishlist').send({ productId: PRODUCT_ID })).status, 401);

  const agent = request.agent(app);
  const user = { _id: USER_ID, name: 'Buyer', email: 'buyer@example.com', wishlist: [] };
  const calls = [];
  await withStubs([
    quiet,
    [console, 'log', () => {}],
    [User, 'findOne', async () => null],
    [User, 'create', async (d) => ({ _id: USER_ID, name: d.name, email: d.email })],
    [User, 'findById', async () => user],
    [User, 'updateOne', async (f, u) => { calls.push(u); if (u.$addToSet) { const v = u.$addToSet.wishlist; (v && v.$each ? v.$each : [v]).forEach((x) => { if (!user.wishlist.includes(x)) user.wishlist.push(x); }); } if (u.$pull) user.wishlist = user.wishlist.filter((x) => x !== u.$pull.wishlist); return {}; }],
    [Product, 'exists', async () => ({ _id: PRODUCT_ID })],
    [Product, 'find', () => {
      const rows = [{ _id: PRODUCT_ID, title: 'Bomber', price: 100, stock: 3, toObject() { return { _id: PRODUCT_ID, title: 'Bomber', price: 100, stock: 3 }; } }];
      rows.select = () => ({ lean: async () => rows });   // the merge route reads ids with .select().lean()
      return rows;
    }]
  ], async () => {
    assert.equal((await agent.post('/api/users/register').send({ name: 'Buyer', email: 'buyer@example.com', password: 'LongEnough123' })).status, 201);

    assert.equal((await agent.post('/api/users/wishlist').send({ productId: 'nope' })).status, 400);
    assert.equal((await agent.post('/api/users/wishlist').send({ productId: { $gt: '' } })).status, 400);
    assert.equal((await agent.post('/api/users/wishlist').send({ productId: PRODUCT_ID })).status, 200);
    assert.deepEqual(user.wishlist, [PRODUCT_ID]);
    // saving the same product again changes nothing
    assert.equal((await agent.post('/api/users/wishlist').send({ productId: PRODUCT_ID })).status, 200);
    assert.equal(calls.filter((c) => c.$addToSet).length, 1);

    const list = await agent.get('/api/users/wishlist');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.ids, [PRODUCT_ID]);
    assert.equal(list.body.products[0].title, 'Bomber');

    assert.equal((await agent.delete('/api/users/wishlist/not-an-id')).status, 400);
    assert.equal((await agent.delete(`/api/users/wishlist/${PRODUCT_ID}`)).status, 200);
    assert.deepEqual(user.wishlist, []);

    assert.equal((await agent.post('/api/users/wishlist/merge').send({ ids: 'x' })).status, 400);
    const merged = await agent.post('/api/users/wishlist/merge').send({ ids: ['bad', PRODUCT_ID, PRODUCT_ID] });
    assert.equal(merged.status, 200);
    assert.deepEqual(merged.body.ids, [PRODUCT_ID], 'the bad id was ignored and the duplicate counted once');
    assert.deepEqual(user.wishlist, [PRODUCT_ID]);
  });
});

test('the User model has a wishlist that starts empty', () => {
  assert.deepEqual([...new User({ name: 'A', email: 'a@b.co', password: 'x'.repeat(8) }).wishlist], []);
});

test('CSV reading handles quotes, semicolons, a BOM, line breaks inside quotes and aliases', () => {
  const r = csvImport.readProductCsv('\uFEFFName;Price;Qty\r\n"Shirt; Red";1299;5\r\n"Say ""hi""";10;1\r\n');
  assert.equal(r.ok, true);
  assert.deepEqual(r.columns, ['title', 'price', 'stock']);
  assert.equal(r.rows[0].cells.title, 'Shirt; Red');
  assert.equal(r.rows[1].cells.title, 'Say "hi"');
  assert.equal(csvImport.readProductCsv('').ok, false);
  assert.equal(csvImport.readProductCsv('price,stock\n1,2').ok, false);          // no title column
  assert.equal(csvImport.readProductCsv('title,price\n"open,1').ok, false);      // quote never closed
  assert.equal(csvImport.readProductCsv('title\n' + 'x\n'.repeat(501)).ok, false); // too many rows
});

test('CSV planning: modes, bad values, duplicates, and blank cells keep current values', () => {
  const rows = csvImport.readProductCsv(
    'title,price,stock,category\nNew One,100,5,Men\nOld One,,7,\nBad Price,12abc,1,\nNo Price,,1,\nnew one,5,5,\nX,1,1,\n').rows;
  const existing = new Map([['old one', 'id1']]);

  const upsert = csvImport.planImport(rows, existing, 'upsert');
  const byLine = Object.fromEntries(upsert.results.map((r) => [r.line, r]));
  assert.equal(byLine[2].action, 'create');
  assert.equal(byLine[3].action, 'update');
  assert.deepEqual(byLine[3].values, { stock: 7 });                 // empty price: left as it is
  assert.equal(byLine[4].action, 'error');                          // bad price
  assert.equal(byLine[5].action, 'error');                          // new product needs a price
  assert.match(csvImport.checkRow({ title: 'Ok', price: '5', category: 'Shoes' }).error, /Category must be one of/);
  assert.equal(csvImport.checkRow({ title: 'Ok', price: '5', category: ' women ' }).values.category, 'Women');
  const noCategory = csvImport.planImport(csvImport.readProductCsv('title,price\nPlain Tee,100\n').rows, new Map(), 'create');
  assert.match(noCategory.results[0].message, /Category is required/);   // no more silent "General"
  assert.match(byLine[6].message, /Same title as line 2/);          // duplicate in the file
  assert.equal(byLine[7].action, 'error');                          // title too short

  assert.equal(csvImport.planImport(rows, existing, 'create').results.find((r) => r.line === 3).action, 'skip');
  assert.equal(csvImport.planImport(rows, existing, 'update').results.find((r) => r.line === 2).action, 'skip');
});

test('CSV rows refuse embedded image data and absurd numbers', () => {
  assert.match(csvImport.checkRow({ title: 'Ok', price: '5', imageUrl: 'data:image/png;base64,AAAA' }).error, /not embedded data/);
  assert.match(csvImport.checkRow({ title: 'Ok', price: '99999999' }).error, /above/);
  assert.match(csvImport.checkRow({ title: 'Ok', price: '-5' }).error, /valid number/);
  assert.match(csvImport.checkRow({ title: 'Ok', price: '0' }).error, /above 0/);          // no free products
  assert.match(csvImport.checkRow({ title: 'Ok', price: '0.00' }).error, /above 0/);
  assert.equal(csvImport.checkRow({ title: 'Ok', price: '10', currency: 'ignored' }).values.currency, undefined, 'a currency column is ignored: no currency is stored');
  assert.match(csvImport.checkRow({ title: 'Ok', stock: '1.5' }).error, /whole number/);
});

const CSV = 'title,price,stock,category\nCSV Parka,2500,4,Men\nExisting Coat,3000,9,\nBroken,abc,1,\n';
function importStore(log) {
  log.created = []; log.updated = [];
  return [
    quiet,
    // Only products without a seller may be matched: the filter is recorded so a test can check it.
    [Product, 'find', (filter) => { log.findFilter = filter; return { select: () => ({ lean: async () => [{ _id: '64b7f0c2a1b2c3d4e5f60111', title: 'Existing Coat', stock: 5 }] }) }; }],
    [Product, 'create', async (v) => { log.created.push(v); return { _id: '64b7f0c2a1b2c3d4e5f60222', ...v }; }],
    [Product, 'findOneAndUpdate', async (filter, v) => { if (!log.updateFilter) log.updateFilter = filter; log.updated.push([filter._id, v]); return { _id: filter._id }; }]
  ];
}

test('CSV import: preview changes nothing, import saves, and the audit log hears about it', async () => {
  const log = {};
  const o = await ownerLogin();
  await withStubs(importStore(log), async () => {
    const preview = await o.agent.post('/admin/products/import').set('X-CSRF-Token', o.csrf).send({ csv: CSV, mode: 'upsert' });   // dryRun omitted = preview
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.dryRun, true);
    assert.deepEqual(preview.body.counts, { create: 1, update: 1, skip: 0, error: 1 });
    assert.equal(log.created.length + log.updated.length, 0, 'a preview never saves');

    const real = await o.agent.post('/admin/products/import').set('X-CSRF-Token', o.csrf).send({ csv: CSV, mode: 'upsert', dryRun: false });
    assert.equal(real.status, 200);
    assert.equal(real.body.dryRun, false);
    assert.equal(log.created.length, 1);
    assert.equal(log.created[0].title, 'CSV Parka');
    assert.equal(log.created[0].currency, undefined);
    // The stock in the file is applied as a CHANGE (9 - 5 = +4), never as an overwrite.
    assert.equal(log.updated.length, 2);
    assert.deepEqual(log.updated[0][1], { price: 3000 });   // empty category cell left alone
    assert.ok(Array.isArray(log.updated[1][1]), 'the stock change is an atomic pipeline update');
    assert.equal(log.updated[1][1][0].$set.stock.$min[1].$max[1].$add[1], 4);
    // a seller's product with the same title is never matched or changed
    assert.deepEqual(log.findFilter, { vendorId: null });
    assert.deepEqual(log.updateFilter, { _id: '64b7f0c2a1b2c3d4e5f60111', vendorId: null });
  });
});

test('CSV import: needs a login, a CSRF token, a valid mode and a readable file', async () => {
  assert.equal((await request(app).post('/admin/products/import').send({ csv: CSV, mode: 'create' })).status, 401);
  const o = await ownerLogin();
  assert.equal((await o.agent.post('/admin/products/import').send({ csv: CSV, mode: 'create' })).status, 403);   // no CSRF header
  const post = (body) => o.agent.post('/admin/products/import').set('X-CSRF-Token', o.csrf).send(body);
  assert.equal((await post({ csv: CSV, mode: 'delete' })).status, 400);
  assert.equal((await post({ csv: '', mode: 'create' })).status, 400);
  assert.equal((await post({ csv: { a: 1 }, mode: 'create' })).status, 400);
  assert.equal((await o.agent.get('/admin/products/import/template')).status, 200);
});

test('CSV import: respects permissions (create needs product.create, update needs product.edit)', async () => {
  const Role = require('../models/Role');
  await Role.create({ name: 'LookOnly', permissions: ['product.view'] });                                  // may see products, nothing else
  await Role.create({ name: 'CreateOnly', permissions: ['product.view', 'product.create'] });              // may add, not change
  await addAccount('viewer1', 'ViewerPass123', ['LookOnly']);
  await addAccount('adder1', 'AdderPass123', ['CreateOnly']);
  const log = {};
  await withStubs(importStore(log), async () => {
    const as = async (username, password) => {
      const agent = request.agent(app);
      const login = await agent.post('/admin/login').send({ username, password });
      assert.equal(login.status, 200);
      return (mode, dryRun) => agent.post('/admin/products/import').set('X-CSRF-Token', login.body.csrfToken).send({ csv: CSV, mode, dryRun });
    };
    const viewer = await as('viewer1', 'ViewerPass123');
    for (const mode of ['create', 'update', 'upsert']) assert.equal((await viewer(mode, false)).status, 403, `viewer / ${mode}`);

    const adder = await as('adder1', 'AdderPass123');
    assert.equal((await adder('create', false)).status, 200);          // allowed: creates only
    assert.equal((await adder('update', false)).status, 403);          // not allowed: changes existing products
    assert.equal((await adder('upsert', false)).status, 403);          // upsert needs both
    assert.equal(log.updated.length, 0, 'nothing was changed without product.edit');
    assert.equal(log.created.length, 1);
  });
});

test('TOTP matches the RFC 6238 test vectors and refuses replays and bad codes', () => {
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totp.totpAt(secret, 59000), '287082');
  assert.equal(totp.totpAt(secret, 1111111109000), '081804');
  assert.equal(totp.verifyTotp(secret, '287082', { nowMs: 59000 }), 1);
  assert.equal(totp.verifyTotp(secret, '287 082', { nowMs: 59000 }), 1);              // spaces are fine
  assert.equal(totp.verifyTotp(secret, '287082', { nowMs: 59000, lastStep: 1 }), null); // already used
  assert.equal(totp.verifyTotp(secret, '287082', { nowMs: 59000 + 3 * 30000 }), null);  // too old
  for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined, { a: 1 }]) assert.equal(totp.verifyTotp(secret, bad, { nowMs: 59000 }), null, String(bad));
  assert.match(totp.generateSecret(), /^[A-Z2-7]{32}$/);
});

test('backup codes: 8 distinct, hashed, case/dash/space insensitive', () => {
  const codes = totp.generateBackupCodes(8);
  assert.equal(new Set(codes).size, 8);
  assert.ok(codes.every((c) => /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/.test(c)));
  assert.equal(totp.hashBackupCode(codes[0]), totp.hashBackupCode(codes[0].toUpperCase().replace(/-/g, ' ')));
  assert.equal(totp.isBackupCodeShape('123456'), false);
});

// In-memory fake for the AdminTwoFactor collection.
test('two-factor login: setup, code at login, replay refused, backup code works once, turn-off', async () => {
  await withEnv({ ADMIN_2FA_ENABLED: 'true' }, () => withStubs([quiet, ...fakeTwoFactorStore()], async () => {
    // not set up yet: password alone still works
    const first = await ownerLogin();
    assert.equal(first.res.status, 200);
    assert.equal((await first.agent.get('/admin/2fa/status')).body.featureEnabled, true);
    assert.equal((await first.agent.get('/admin/2fa/status')).body.enabled, false);

    // setup needs CSRF; a wrong first code does not turn it on
    assert.equal((await first.agent.post('/admin/2fa/setup')).status, 403);
    const setup = await first.agent.post('/admin/2fa/setup').set('X-CSRF-Token', first.csrf);
    assert.equal(setup.status, 200);
    assert.match(setup.body.secret, /^[A-Z2-7]{32}$/);
    assert.match(setup.body.otpauthUrl, /^otpauth:\/\/totp\//);
    const bad = await first.agent.post('/admin/2fa/enable').set('X-CSRF-Token', first.csrf).send({ code: '000000' });
    assert.equal(bad.status, 400);

    const enable = await first.agent.post('/admin/2fa/enable').set('X-CSRF-Token', first.csrf).send({ code: totp.totpAt(setup.body.secret) });
    assert.equal(enable.status, 200, JSON.stringify(enable.body));
    assert.equal(enable.body.backupCodes.length, 8);
    const secret = setup.body.secret;

    // now the login needs a code
    const none = await request(app).post('/admin/login').send(OWNER);
    assert.equal(none.status, 401);
    assert.equal(none.body.twoFactorRequired, true);
    const wrong = await request(app).post('/admin/login').send({ ...OWNER, otp: '111111' });
    assert.equal(wrong.status, 401);

    // the code already used at setup is not accepted again; the next one is
    const replay = await request(app).post('/admin/login').send({ ...OWNER, otp: totp.totpAt(secret) });
    assert.equal(replay.status, 401, 'a code that was already used cannot be used again');
    const next = await ownerLogin({ otp: totp.totpAt(secret, Date.now() + 30000) });
    assert.equal(next.res.status, 200);
    assert.equal((await next.agent.get('/admin/auth/status')).body.isAuthenticated, true);

    // a backup code works once
    const backup = enable.body.backupCodes[0];
    const viaBackup = await ownerLogin({ otp: backup });
    assert.equal(viaBackup.res.status, 200);
    const again = await request(app).post('/admin/login').send({ ...OWNER, otp: backup });
    assert.equal(again.status, 401);

    // turning it off needs the password and a code
    const noPw = await next.agent.post('/admin/2fa/disable').set('X-CSRF-Token', next.csrf).send({ password: 'wrong', code: enable.body.backupCodes[1] });
    assert.equal(noPw.status, 400);
    const off = await next.agent.post('/admin/2fa/disable').set('X-CSRF-Token', next.csrf).send({ password: OWNER.password, code: enable.body.backupCodes[1] });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal((await ownerLogin()).res.status, 200, 'password alone works again');
  }));
});

test('two-factor endpoints refuse to work while ADMIN_2FA_ENABLED is not true', async () => {
  const o = await ownerLogin();
  const res = await o.agent.post('/admin/2fa/setup').set('X-CSRF-Token', o.csrf);
  assert.equal(res.status, 400);
  assert.equal((await request(app).post('/admin/2fa/setup').send({})).status, 401);
});

test('the pages load the new scripts and contain the new controls', () => {
  const root = path.join(__dirname, '..', 'public');
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const admin = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  assert.ok(index.indexOf('/js/app.js') < index.indexOf('/js/app-extras.js'), 'app-extras.js loads after app.js');
  for (const id of ['viewWishlistLink', 'wishlistModal', 'cartShippingRow']) assert.ok(index.includes(`id="${id}"`), id);
  for (const id of ['otpCode', 'importModal', 'securityModal', 'importCsvBtn']) assert.ok(admin.includes(`id="${id}"`), id);
  assert.ok(admin.includes('/js/admin-extras.js'));
  for (const f of ['public/js/app-extras.js', 'public/js/admin-extras.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/\son(click|error|load)\s*=/.test(src), `${f} has no inline handlers (the CSP forbids them)`);
  }
});

test('the two-factor secret is stored encrypted and decrypts to the one shown at setup', async () => {
  const twoFactor = require('../services/twoFactor');
  const store = fakeTwoFactorStore();
  await withEnv({ ADMIN_2FA_ENABLED: 'true' }, () => withStubs([quiet, ...store], async () => {
    const o = await ownerLogin();
    const setup = await o.agent.post('/admin/2fa/setup').set('X-CSRF-Token', o.csrf);
    const stored = store.docs[0].secret;
    assert.ok(twoFactor.isEncrypted(stored));
    assert.ok(!stored.includes(setup.body.secret));
    assert.equal(twoFactor.decryptSecret(stored), setup.body.secret);
    assert.notEqual(twoFactor.encryptSecret('ABC'), twoFactor.encryptSecret('ABC'), 'each encryption uses a new nonce');
    const enable = await o.agent.post('/admin/2fa/enable').set('X-CSRF-Token', o.csrf).send({ code: totp.totpAt(setup.body.secret) });
    assert.equal(enable.status, 200);
  }));
});
