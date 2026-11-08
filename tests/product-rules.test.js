// Product rules, order list privacy, earnings at any size, clawbacks, picture and redirect safety.
const { test } = require('node:test');
const assert = require('node:assert/strict');
// These tests are about earnings and payouts, not the hold (the 7-day default is tested in
// currency-decimals and chat-retry-safety), so they run without it.
process.env.PAYOUT_HOLD_DAYS = '0';
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { app, OWNER, addAccount } = require('./helpers');
const Role = require('../models/Role');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Vendor = require('../models/Vendor');
const AdminTwoFactor = require('../models/AdminTwoFactor');
const emailService = require('../services/emailService');
const marketplace = require('../services/marketplace');
const productRules = require('../services/productRules');
const twoFactor = require('../services/twoFactor');
const totp = require('../services/totp');
const { quiet, withStubs, withEnv, oid, wrap, chain, newWorld, stubsFor, seedVendor, seedProduct, fakeTwoFactorStore } = require('./fakeDb');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const ON = { MULTIVENDOR_ENABLED: 'true', MARKETPLACE_COMMISSION_PERCENT: '10', COD_ENABLED: 'true' };

async function ownerLogin() {
  const agent = request.agent(app);
  const res = await agent.post('/admin/login').send(OWNER);
  assert.equal(res.status, 200);
  return { agent, csrf: res.body.csrfToken };
}
async function staffLogin(username, password) {
  const agent = request.agent(app);
  const res = await agent.post('/admin/login').send({ username, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { agent, csrf: res.body.csrfToken };
}
async function shopper(w, n) {
  const agent = request.agent(app);
  await withStubs(stubsFor(w), async () => {
    const res = await agent.post('/api/users/register').send({ name: `Seller ${n}`, email: `rf${n}@example.com`, password: 'LongEnough123' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });
  return agent;
}
const address = { address: '1 Main St', city: 'Dhaka', postcode: '1200', country: 'Bangladesh' };
function paidOrder(w, vendor, over = {}) {
  const o = wrap({ _id: oid(), status: 'CONFIRMED', paidAt: new Date(), createdAt: new Date(), customerName: 'Buyer One', customerPhone: '01711111111', deliveryAddress: address, paymentGateway: 'cod',
    items: [{ title: 'Tee', price: 500, quantity: 2, size: 'M', vendorId: vendor._id, commissionPercent: 10 }],
    fulfillment: [{ vendorId: vendor._id, status: 'PENDING', note: '' }], ...over });
  w.orders.push(o); return o;
}
const delivered = (o) => { o.fulfillment[0].status = 'DELIVERED'; return o; };

test('price rules: above 0, at most 2 decimals', () => {
  for (const bad of [0, '0', '0.00', -1, '-5', '12abc', '1e3', '10.999', 10000001, '', null, undefined, NaN, Infinity, {}]) {
    assert.equal(productRules.parsePrice(bad).ok, false, `price ${JSON.stringify(bad)}`);
  }
  assert.equal(productRules.parsePrice('0.01').value, 0.01);
  assert.equal(productRules.parsePrice(1799.99).value, 1799.99);
  assert.equal(productRules.parsePrice(0.1 + 0.2).value, 0.3, 'floating-point noise is tidied');
  assert.equal(productRules.parsePrice(' 50 ').value, 50);
  assert.equal(productRules.parsePrice(10000000).ok, true);
});

test('admin product create and edit apply the rules; the model is the last safety net', async () => {
  const o = await ownerLogin();
  const created = [];
  const updated = [];
  await withStubs([
    quiet,
    [Product, 'create', async (d) => { created.push(d); return { _id: oid(), ...d, toObject() { return { ...d }; } }; }],
    [Product, 'findByIdAndUpdate', async (id, d) => { updated.push(d); return { _id: id, ...d }; }],
    [Product, 'findOneAndUpdate', async (f, d) => { updated.push(d); return { _id: f._id, ...d }; }]
  ], async () => {
    const make = (extra) => o.agent.post('/admin/products').set('X-CSRF-Token', o.csrf).send({ title: 'Free Tee', description: 'x', price: '100', stock: '5', category: 'Men', ...extra });
    assert.equal((await make({ price: '0' })).status, 400, 'a free product is refused');
    assert.equal((await make({ price: 0 })).status, 400);
    assert.equal((await make({ price: '12abc' })).status, 400, '"12abc" is refused, not read as 12');
    assert.equal((await make({ price: '-1' })).status, 400);
    assert.equal(created.length, 0, 'nothing was saved');
    const ok = await make({});
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(created[0].currency, undefined);
    assert.equal(created[0].price, 100);

    const id = oid();
    const edit = (body) => o.agent.put(`/admin/products/${id}`).set('X-CSRF-Token', o.csrf).send(body);
    assert.equal((await edit({ price: '0' })).status, 400);
    assert.equal((await edit({ price: '1e3' })).status, 400);
    assert.equal(updated.length, 0);
    assert.equal((await edit({ price: '250.5' })).status, 200);
    assert.equal(updated[0].price, 250.5);
  });

  await assert.rejects(new Product({ title: 'x', price: 0 }).validate(), /Price must be above 0/);
  await assert.rejects(new Product({ title: 'x', price: 10.005 }).validate(), /at most 2 decimals/);
  await assert.rejects(new Product({ title: 'x', price: 10000001 }).validate(), /too high/);
  await new Product({ title: 'x', price: 10 }).validate();
});

test('staff with only order.view do not get customer or payment details from the order list', async () => {
  await Role.create({ name: 'OrderViewOnly', permissions: ['order.view'] });
  await Role.create({ name: 'OrderFull', permissions: ['order.view', 'order.details'] });
  await addAccount('viewonly1', 'ViewOnlyPass123', ['OrderViewOnly']);
  await addAccount('full1', 'FullDetailPass123', ['OrderFull']);
  const row = {
    _id: oid(), status: 'CONFIRMED', createdAt: new Date(), paidAt: new Date(), paymentGateway: 'stripe', transactionId: 'pi_SECRET_REF', valId: 'val_SECRET',
    customerName: 'Nusrat Jahan', customerEmail: 'nusrat@example.com', customerPhone: '01811111111',
    deliveryAddress: { address: '12 Lake Road', city: 'Dhaka', postcode: '1212', country: 'Bangladesh' },
    items: [{ productId: oid(), title: 'Tee', price: 500, quantity: 2, size: 'M', vendorId: oid() }],
    subtotalAmount: 1000, totalAmount: 1000, discountAmount: 0
  };
  await withStubs([quiet, [Order, 'find', () => chain([row])], [Order, 'countDocuments', async () => 1]], async () => {
    const limited = await staffLogin('viewonly1', 'ViewOnlyPass123');
    const res = await limited.agent.get('/admin/orders');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const text = JSON.stringify(res.body);
    for (const secret of ['nusrat@example.com', '01811111111', '12 Lake Road', 'pi_SECRET_REF', 'val_SECRET', 'Nusrat']) {
      assert.ok(!text.includes(secret), `the list leaked "${secret}"`);
    }
    const o = res.body.orders[0];
    assert.equal(o.detailsHidden, true);
    assert.equal(o.totalAmount, 1000);                        // money and items stay visible
    assert.equal(o.items[0].title, 'Tee');
    assert.equal(o.items[0].vendorId, undefined);
    assert.ok(Array.isArray(o.allowedStatuses));

    const full = await staffLogin('full1', 'FullDetailPass123');
    const all = await full.agent.get('/admin/orders');
    assert.equal(all.body.orders[0].customerEmail, 'nusrat@example.com');
    assert.equal(all.body.orders[0].transactionId, 'pi_SECRET_REF');
    const owner = await ownerLogin();
    assert.equal((await owner.agent.get('/admin/orders')).body.orders[0].customerPhone, '01811111111');
  });
});

test('deleting a staff account deletes its two-factor record', async () => {
  await addAccount('gone2', 'GonePass12345', ['Staff']);
  const o = await ownerLogin();
  const removed = [];
  await withStubs([quiet, [AdminTwoFactor, 'deleteOne', async (f) => { removed.push(f); return { deletedCount: 1 }; }]], async () => {
    const res = await o.agent.delete('/admin/staff/gone2').set('X-CSRF-Token', o.csrf);
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });
  assert.deepEqual(removed, [{ key: 'staff:gone2' }]);
});

test('two-factor lockout holds under parallel requests', async () => {
  const fake = fakeTwoFactorStore();
  const secret = totp.generateSecret();
  const doc = { _id: 'tf-race', key: 'env:owner', secret, enabled: true, lastStep: 0, backupCodeHashes: [], failedAttempts: 0, lockedUntil: null };
  fake.docs.push(doc);
  await withStubs(fake, async () => {
    const results = await Promise.all(Array.from({ length: 60 }, () => twoFactor.verifyLogin(doc, '000000')));
    const checked = results.filter((r) => r.message === 'That code is not correct.').length;
    const refused = results.filter((r) => /Too many wrong codes/.test(r.message)).length;
    assert.equal(checked, twoFactor.MAX_FAILED, 'only the first 10 parallel guesses were ever looked at');
    assert.equal(checked + refused, 60);
    assert.ok(doc.lockedUntil && doc.lockedUntil > new Date(), 'the account is paused');

    const good = await twoFactor.verifyLogin(doc, totp.totpAt(secret));
    assert.equal(good.ok, false, 'even the right code is refused while paused');

    doc.lockedUntil = new Date(Date.now() - 1000);            // the pause is over
    const later = await twoFactor.verifyLogin(doc, totp.totpAt(secret));
    assert.equal(later.ok, true);
    assert.equal(doc.failedAttempts, 0);
  });
});

test('Cash on Delivery limit: an order that exceeds it after creation is cancelled and its stock returned', async () => {
  const log = { restocked: [], cancelled: [] };
  const PRODUCT = '64b7f0c2a1b2c3d4e5f60999';
  const ORDER = '64b7f0c2a1b2c3d4e5f60718';
  const body = { customerName: 'Buyer', customerEmail: 'buyer@example.com', customerPhone: '01700000000', deliveryAddress: address, paymentGateway: 'cod', items: [{ productId: PRODUCT, quantity: 2, size: 'M' }] };
  const stubs = (earlierOpen) => [
    quiet,
    [Product, 'findById', async () => ({ _id: PRODUCT, title: 'Tee', price: 100, stock: 500 })],
    [Product, 'findOneAndUpdate', async () => ({})],
    [Product, 'updateOne', async (f, u) => { log.restocked.push(u); return {}; }],
    // The first count (before the order exists) sees nothing; the second (with _id: {$lt: this
    // order}) sees the limit already full.
    [Order, 'countDocuments', async (f) => (f._id ? earlierOpen : 0)],
    [Order, 'create', async (d) => ({ _id: ORDER, ...d })],
    [Order, 'updateOne', async () => ({})],
    [Order, 'findOneAndUpdate', async (f, u) => { log.cancelled.push([f, u]); return { _id: ORDER, items: [{ productId: PRODUCT, quantity: 2 }], couponId: null }; }],
    [emailService, 'sendOrderConfirmation', () => Promise.resolve()]
  ];
  await withEnv({ COD_ENABLED: 'true' }, async () => {
    await withStubs(stubs(2), async () => {
      const res = await request(app).post('/api/orders').send(body);
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.match(res.body.message, /open Cash on Delivery orders/);
      assert.equal(log.cancelled.length, 1, 'the extra order was cancelled');
      assert.equal(log.cancelled[0][1].status, 'CANCELLED');
      assert.deepEqual(log.restocked, [{ $inc: { stock: 2 } }], 'its stock went back on sale');
    });
    log.cancelled.length = 0; log.restocked.length = 0;
    await withStubs(stubs(1), async () => {
      const res = await request(app).post('/api/orders').send(body);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(log.cancelled.length, 0, 'within the limit: kept');
    });
  });
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const PNG_URI = 'data:image/png;base64,' + PNG.toString('base64');
test('the picture endpoint never redirects off-site and respects suspension', async () => {
  const w = newWorld();
  const ok = seedVendor(w); const bad = seedVendor(w, { name: 'Bad', slug: 'bad', status: 'suspended' });
  const local = seedProduct(w, null, { imageUrl: '/img/products/tee.svg' });
  const external = seedProduct(w, null, { imageUrl: 'https://evil.example/phish.png' });
  const slash = seedProduct(w, null, { imageUrl: '/\\evil.example' });
  const protoRel = seedProduct(w, null, { imageUrl: '//evil.example/x.png' });
  const upload = seedProduct(w, ok, { imageUrl: PNG_URI });
  const hidden = seedProduct(w, bad, { imageUrl: PNG_URI });
  await withEnv(ON, () => withStubs(stubsFor(w), async () => {
    const get = (p) => request(app).get(`/api/products/${p._id}/image`).redirects(0);
    const l = await get(local);
    assert.equal(l.status, 302); assert.equal(l.headers.location, '/img/products/tee.svg');
    for (const p of [external, slash, protoRel]) {
      const r = await get(p);
      assert.equal(r.status, 404, `${p.imageUrl} must not be followed`);
      assert.equal(r.headers.location, undefined);
    }
    assert.equal((await get(upload)).status, 200);
    assert.equal((await get(hidden)).status, 404, 'a suspended shop\u2019s picture is not served');
    bad.status = 'approved';
    assert.equal((await get(hidden)).status, 200);
  }));
});

test('the product list is paged and asks the database for a marker instead of pictures', async () => {
  const w = newWorld();
  for (let i = 0; i < 5; i++) seedProduct(w, null, { title: `P${i}`, imageUrl: i === 0 ? PNG_URI : '/img/products/x.svg' });
  await withStubs([...stubsFor(w), [Product, 'find', () => { throw new Error('the list must not read whole products with find()'); }]], async () => {
    const first = await request(app).get('/api/products?limit=2');
    assert.equal(first.status, 200);
    assert.equal(first.body.length, 2);
    assert.equal(first.headers['x-has-more'], 'true');
    assert.equal(first.body[0].imageUrl, `/api/products/${w.products[0]._id}/image?v=${first.body[0].imageUrl.split('v=')[1]}`);
    assert.ok(!JSON.stringify(first.body).includes('base64'), 'no picture data in the list');

    const last = await request(app).get('/api/products?limit=2&skip=4');
    assert.equal(last.body.length, 1);
    assert.equal(last.headers['x-has-more'], 'false');

    const all = await request(app).get('/api/products');
    assert.equal(all.body.length, 5);
    assert.equal(all.headers['x-has-more'], 'false');

    await request(app).get('/api/products?limit=99999&skip=-5');
    const limitStage = w.lastPipeline.find((s) => s.$limit !== undefined);
    assert.equal(limitStage.$limit, 501, 'the page size is capped at 500 (plus one to see if there is more)');
    assert.equal(w.lastPipeline.find((s) => s.$skip !== undefined).$skip, 0);
    assert.ok(w.lastPipeline[w.lastPipeline.length - 1].$addFields, 'the picture marker stage runs in the database');
  });
  assert.match(read('public/js/app.js'), /X-Has-More/);
  assert.match(read('public/js/app.js'), /function fetchProductsForCart\(\) \{\s*return fetchAllProducts\(\)/);
});

// Admin CSV import cannot touch vendor products (also covered in extras.test.js)
test('the CSV import only reads the store\u2019s own products', () => {
  const src = read('routes/adminExtras.js');
  assert.match(src, /Product\.find\(\{ vendorId: null \}\)/);
  assert.match(src, /findOneAndUpdate\(\{ _id: r\.id, vendorId: null \}/);
});

test('a suspended seller keeps their items and earnings but loses customer details and shipping', async () => {
  const w = newWorld();
  const a = await shopper(w, 1);
  const v = seedVendor(w, { status: 'suspended', ownerUserId: w.users[0]._id }); w.users[0].vendorId = v._id;
  const order = paidOrder(w, v);
  await withEnv(ON, () => withStubs(stubsFor(w), async () => {
    const list = (await a.get('/api/vendor/orders')).body.orders;
    assert.equal(list.length, 1);
    assert.equal(list[0].items[0].title, 'Tee');
    assert.deepEqual(list[0].earnings, { gross: 1000, commission: 100, net: 900 });
    const text = JSON.stringify(list);
    for (const secret of ['Buyer One', '01711111111', '1 Main St', 'Dhaka']) assert.ok(!text.includes(secret), `leaked ${secret}`);
    assert.equal(list[0].customerHidden, true);
    assert.equal((await a.patch(`/api/vendor/orders/${order._id}/fulfillment`).send({ status: 'SHIPPED' })).status, 403);
    v.status = 'approved';
    const back = (await a.get('/api/vendor/orders')).body.orders[0];
    assert.equal(back.customerName, 'Buyer One');
    assert.equal(back.deliveryAddress.address, '1 Main St');
  }));
});

test('saving shop details changes only the fields that were sent', async () => {
  const w = newWorld();
  const a = await shopper(w, 2);
  const v = seedVendor(w, { ownerUserId: w.users[0]._id, description: 'Streetwear', phone: '01700000000' }); w.users[0].vendorId = v._id;
  await withEnv(ON, () => withStubs(stubsFor(w), async () => {
    assert.equal((await a.put('/api/vendor/profile').send({ description: 'New text' })).status, 200);
    assert.equal(v.description, 'New text');
    assert.equal(v.phone, '01700000000', 'the phone was not sent, so it was not blanked');
    assert.equal((await a.put('/api/vendor/profile').send({ phone: '01999999999' })).status, 200);
    assert.equal(v.description, 'New text');
    assert.equal(v.phone, '01999999999');
    assert.equal((await a.put('/api/vendor/profile').send({})).status, 400);
    assert.equal((await a.put('/api/vendor/profile').send({ phone: 12345678 })).status, 400);
    assert.equal((await a.put('/api/vendor/profile').send({ description: { $set: 1 } })).status, 400);
    assert.equal((await a.put('/api/vendor/profile').send({ phone: 'bad<script>' })).status, 400);
    assert.equal(v.phone, '01999999999');
    assert.equal((await a.put('/api/vendor/profile').send({ description: '' })).status, 200);   // clearing it still works
    assert.equal(v.description, '');
  }));
});

test('earnings and payouts are exact for a vendor with more orders than one batch', async () => {
  const w = newWorld();
  const v = seedVendor(w);
  const N = marketplace.SCAN_BATCH * 2 + 250;                   // 1,250 paid, delivered orders (the old limit was 1,000)
  for (let i = 0; i < N; i++) delivered(paidOrder(w, v));
  const o = await ownerLogin();
  await withEnv(ON, () => withStubs(stubsFor(w), async () => {
    const e = await marketplace.earningsFor(v._id);
    assert.equal(e.totals.net, N * 900);
    assert.equal(e.totals.payable, N * 900, 'every order counts, not only the newest 1,000');
    assert.equal(e.totals.payableNow, N * 900);
    assert.equal(e.linesTotal, N);
    assert.equal(e.lines.length, 200, 'only the newest 200 lines are sent to the screen');
    assert.equal(e.lines[0].orderId, w.orders[N - 1]._id, 'newest first');

    const plan = await marketplace.payoutPlan(v._id);
    assert.equal(plan.payable.length, N);
    const pay = await o.agent.post(`/admin/vendors/${v._id}/payouts`).set('X-CSRF-Token', o.csrf).send({ note: 'all of it' });
    assert.equal(pay.status, 201, JSON.stringify(pay.body));
    assert.equal(pay.body.amount, N * 900);
    assert.equal(pay.body.orders, N, 'the payout covers every payable order');
    const after = await marketplace.earningsFor(v._id);
    assert.equal(after.totals.paidOut, N * 900);
    assert.equal(after.totals.payable, 0);
    assert.equal((await o.agent.post(`/admin/vendors/${v._id}/payouts`).set('X-CSRF-Token', o.csrf).send({})).status, 400);
  }));
});

test('an order cancelled after payout is taken back from the next payout (clawback)', async () => {
  const w = newWorld();
  const v = seedVendor(w);
  const first = delivered(paidOrder(w, v));
  const o = await ownerLogin();
  await withEnv(ON, () => withStubs(stubsFor(w), async () => {
    const pay = () => o.agent.post(`/admin/vendors/${v._id}/payouts`).set('X-CSRF-Token', o.csrf).send({});
    assert.equal((await pay()).status, 201);                     // 900 paid for the first order
    assert.equal(w.payouts.length, 1);

    first.status = 'CANCELLED';                                  // the customer's order is cancelled afterwards
    let e = await marketplace.earningsFor(v._id);
    assert.equal(e.totals.clawback, 900);
    assert.equal(e.totals.payableNow, 0);
    const line = e.lines.find((l) => l.orderId === String(first._id));
    assert.equal(line.state, 'clawback');
    assert.equal(line.net, -900);
    assert.equal(e.totals.net, 0, 'a cancelled order no longer counts as earnings');

    // Nothing else is payable: no payout is recorded, the clawback stays open.
    const none = await pay();
    assert.equal(none.status, 400);
    assert.match(none.body.message, /owes 900\.00 back/);
    assert.equal(w.payouts.length, 1);

    // One more delivered order of 900: the payout is 900 - 900 = 0, so still nothing is recorded...
    const second = delivered(paidOrder(w, v));
    const equal = await pay();
    assert.equal(equal.status, 400);
    assert.match(equal.body.message, /not smaller/);
    assert.equal(w.payouts.length, 1);

    // ...and with two (1,800 payable, 900 owed back) the vendor is paid 900 and the clawback is
    // settled.
    delivered(paidOrder(w, v));
    const settled = await pay();
    assert.equal(settled.status, 201, JSON.stringify(settled.body));
    assert.equal(settled.body.amount, 900);
    assert.equal(settled.body.orders, 2);
    const stored = w.payouts[w.payouts.length - 1];
    assert.deepEqual(stored.clawbackOrderIds.map(String), [String(first._id)]);
    assert.ok(stored.lineKeys.includes(`${v._id}:${first._id}:clawback`));

    e = await marketplace.earningsFor(v._id);
    assert.equal(e.totals.clawback, 0, 'settled: it is never taken twice');
    assert.equal(e.totals.payableNow, 0);
    assert.equal(e.lines.some((l) => l.state === 'clawback'), false);
    assert.equal(second.status, 'CONFIRMED');

    // A cancelled order the vendor was never paid for earns nothing and owes nothing.
    paidOrder(w, v, { status: 'CANCELLED' });
    e = await marketplace.earningsFor(v._id);
    assert.equal(e.totals.clawback, 0);
  }));
});

test('the request log does not contain secrets that travel in URLs', async () => {
  const written = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => { written.push(String(chunk)); return true; };
  try {
    await request(app).get('/api/users/verify-email?token=SECRET_TOKEN_123&ok=1');
    await request(app).get('/api/products?x=1&password=hunter2&sig=abc');
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.stdout.write = original;
  }
  const log = written.join('');
  assert.ok(!log.includes('SECRET_TOKEN_123') && !log.includes('hunter2'), 'secrets reached the log');
  assert.match(log, /token=\[redacted\]&ok=1/);
  assert.match(log, /\/api\/products\?x=1&password=\[redacted\]&sig=\[redacted\]/);
});

test('payment return pages and webhooks have their own limit', async () => {
  for (const url of ['/api/payment/ipn', '/api/payment/stripe-webhook']) {
    const res = await request(app).post(url).send({});
    assert.equal(res.headers['ratelimit-limit'], '200', url);
  }
  const src = read('server.js');
  assert.match(src, /stripe-webhook', apiRoutes\.paymentCallbackLimiter/);
});

test('/api/site-info returns only contact details that are set, and only a sane e-mail', async () => {
  await withEnv({ SUPPORT_EMAIL: undefined, SUPPORT_PHONE: undefined, SUPPORT_ADDRESS: undefined }, async () => {
    const empty = (await request(app).get('/api/site-info')).body;
    assert.equal(empty.supportEmail, ''); assert.equal(empty.supportPhone, ''); assert.equal(empty.supportAddress, '');
  });
  await withEnv({ SUPPORT_EMAIL: 'help@shop.example', SUPPORT_PHONE: '+880 1711-000000', SUPPORT_ADDRESS: 'Dhaka' }, async () => {
    const full = (await request(app).get('/api/site-info')).body;
    assert.equal(full.supportEmail, 'help@shop.example'); assert.equal(full.supportPhone, '+880 1711-000000'); assert.equal(full.supportAddress, 'Dhaka');
  });
  await withEnv({ SUPPORT_EMAIL: '<script>alert(1)</script>' }, async () => {
    assert.equal((await request(app).get('/api/site-info')).body.supportEmail, '');
  });
});

test('configuration and packaging: safe defaults and no placeholder text', () => {
  const env = read('.env.example');
  assert.match(env, /^MULTIVENDOR_ENABLED=false$/m, 'the marketplace is off in the example file, as the README says');
  assert.match(read('README.md'), /off by default|OFF by default|Off by default/i);
  for (const key of ['SUPPORT_EMAIL', 'SUPPORT_PHONE', 'SUPPORT_ADDRESS']) assert.match(env, new RegExp(`^${key}=$`, 'm'));

  assert.match(read('Dockerfile'), /^ENV NODE_ENV=production$/m);
  assert.match(read('docker-compose.yml'), /NODE_ENV: production/);

  const gitignore = read('.gitignore');
  for (const line of ['node_modules/', '.env', '.env.*', '!.env.example']) assert.ok(gitignore.split('\n').includes(line), `.gitignore: ${line}`);
  const dockerignore = read('.dockerignore').split('\n');
  for (const line of ['.env', '.env.*', '!.env.example', 'node_modules']) assert.ok(dockerignore.includes(line), `.dockerignore: ${line}`);

  const credits = read('CREDITS.md');
  for (const name of ['Bootstrap', 'jQuery', 'express', 'mongoose', 'stripe', 'original']) assert.match(credits, new RegExp(name, 'i'));

  // The old footer contact placeholders are gone everywhere a visitor or buyer can read them.
  for (const f of ['public/index.html', 'public/js/app.js', 'public/js/app-extras.js', 'public/js/marketplace.js', 'README.md']) {
    const text = read(f);
    assert.ok(!text.includes('+880 1XXX-XXXXXX'), `${f} still has the placeholder phone number`);
    assert.ok(!text.includes('hello@yourstore.example'), `${f} still has the placeholder e-mail`);
  }
  assert.match(read('public/index.html'), /id="footerContact"[^>]*class="[^"]*d-none|class="[^"]*d-none[^"]*" id="footerContact"/, 'the contact block stays hidden until the settings fill it');

  // nothing that must not be in the zip is in the project folder
  for (const bad of ['.env', 'node_modules']) {
    if (bad === 'node_modules') continue;   // present while testing; excluded from the zip by
    assert.ok(!fs.existsSync(path.join(root, bad)), `${bad} must not be shipped`);
  }
});

test('a settled clawback can be paid again if the order reopens, and clawed back again if it cancels again', async () => {
  const w = newWorld();
  const v = seedVendor(w);
  const first = delivered(paidOrder(w, v));
  const o = await ownerLogin();
  await withEnv(ON, () => withStubs(stubsFor(w), async () => {
    const pay = () => o.agent.post(`/admin/vendors/${v._id}/payouts`).set('X-CSRF-Token', o.csrf).send({});
    await pay(); // pays 900
    first.status = 'CANCELLED';
    delivered(paidOrder(w, v));
    delivered(paidOrder(w, v)); // to generate payable amount to absorb clawback
    await pay(); // settles clawback
    
    first.status = 'CONFIRMED';
    first.fulfillment[0].status = 'DELIVERED';
    const e1 = await marketplace.earningsFor(v._id);
    assert.equal(e1.totals.payableNow, 900, 'reopened order is payable again');
    
    const thirdPay = await pay(); // pays the reopened order again
    assert.equal(thirdPay.status, 201);
    
    first.status = 'CANCELLED';
    const e2 = await marketplace.earningsFor(v._id);
    assert.equal(e2.totals.clawback, 900, 'can be clawed back a second time');
  }));
});


test('admin pushing order to DELIVERED does not make it payable for a vendor who has not delivered yet', async () => {
  const w = newWorld();
  const v = seedVendor(w);
  const order = paidOrder(w, v, { status: 'DELIVERED' });
  // order.fulfillment[0].status is 'PENDING' by default in paidOrder
  await withEnv(ON, () => withStubs(stubsFor(w), async () => {
    const e = await marketplace.earningsFor(v._id);
    assert.equal(e.totals.payableNow, 0, 'Not payable because vendor has not delivered');
    assert.equal(e.totals.pending, 900, 'Still pending');
  }));
});


test('vendors cannot ship PLACED orders and customer details are hidden for PLACED and CANCELLED orders', async () => {
  const w = newWorld();
  const a = await shopper(w, 1);
  const v = seedVendor(w, { ownerUserId: w.users[0]._id, status: 'approved' }); w.users[0].vendorId = v._id;
  const placedOrder = paidOrder(w, v, { status: 'PLACED' });
  const cancelledOrder = paidOrder(w, v, { status: 'CANCELLED' });
  const confirmedOrder = paidOrder(w, v, { status: 'CONFIRMED' });
  await withEnv(ON, () => withStubs(stubsFor(w), async () => {
    // Cannot ship PLACED orders
    const shipRes = await a.patch(`/api/vendor/orders/${placedOrder._id}/fulfillment`).send({ status: 'SHIPPED' });
    assert.equal(shipRes.status, 409);
    assert.match(shipRes.body.message, /awaiting store confirmation/);
    // Customer hidden for PLACED
    const list = (await a.get('/api/vendor/orders')).body.orders;
    const placed = list.find(o => o.id === String(placedOrder._id));
    assert.equal(placed.customerHidden, true);
    // Customer hidden for CANCELLED
    const cancelled = list.find(o => o.id === String(cancelledOrder._id));
    assert.equal(cancelled.customerHidden, true);
    // Customer visible for CONFIRMED
    const confirmed = list.find(o => o.id === String(confirmedOrder._id));
    assert.equal(confirmed.customerHidden, undefined);
    assert.equal(confirmed.customerName, 'Buyer One');
  }));
});


test('vendor fulfillments sync with order status and admin override', async () => {
  const w = newWorld();
  const a1 = await shopper(w, 1);
  const v1 = seedVendor(w, { ownerUserId: w.users[w.users.length - 1]._id, status: 'approved' }); w.users[w.users.length - 1].vendorId = v1._id;
  const a2 = await shopper(w, 2);
  const v2 = seedVendor(w, { ownerUserId: w.users[w.users.length - 1]._id, status: 'approved' }); w.users[w.users.length - 1].vendorId = v2._id;
  
  const order = wrap({ _id: oid(), status: 'CONFIRMED', paidAt: new Date(), createdAt: new Date(), customerName: 'Buyer', paymentGateway: 'cod',
    items: [
      { title: 'Tee1', price: 500, quantity: 1, vendorId: v1._id, commissionPercent: 10 },
      { title: 'Tee2', price: 500, quantity: 1, vendorId: v2._id, commissionPercent: 10 }
    ],
    fulfillment: [{ vendorId: v1._id, status: 'PENDING', note: '' }, { vendorId: v2._id, status: 'PENDING', note: '' }]
  });
  w.orders.push(order);
  
  const o = await ownerLogin();
  await withEnv(ON, () => withStubs(stubsFor(w), async () => {
    // v1 ships
    await a1.patch(`/api/vendor/orders/${order._id}/fulfillment`).send({ status: 'SHIPPED' });
    assert.equal(order.status, 'CONFIRMED');
    // v2 ships, so the order becomes SHIPPED
    await a2.patch(`/api/vendor/orders/${order._id}/fulfillment`).send({ status: 'SHIPPED' });
    assert.equal(order.status, 'SHIPPED');
    // v1 delivers
    await a1.patch(`/api/vendor/orders/${order._id}/fulfillment`).send({ status: 'DELIVERED' });
    assert.equal(order.status, 'SHIPPED'); // not all delivered yet
    // v1 is payable, v2 is pending/payable check? The earnings check:
    const e1 = await marketplace.earningsFor(v1._id);
    const e2 = await marketplace.earningsFor(v2._id);
    assert.equal(e1.totals.payableNow, 450);
    assert.equal(e2.totals.payableNow, 0);
    // Admin forces DELIVERED
    const adminRes = await o.agent.put(`/admin/orders/${order._id}/status`).set('X-CSRF-Token', o.csrf).send({ status: 'DELIVERED' });
    if (adminRes.status !== 200) console.error(adminRes.body);
    assert.equal(adminRes.status, 200);
    assert.equal(order.status, 'DELIVERED');
    const f2 = order.fulfillment.find(f => String(f.vendorId) === String(v2._id));
    assert.equal(f2.status, 'DELIVERED');
  }));
});

