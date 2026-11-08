// Order, payment and admin rules. Models are in-memory fakes, so MongoDB itself is not tested.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { app, OWNER } = require('./helpers');

const Order = require('../models/Order');
const Product = require('../models/Product');
const Coupon = require('../models/Coupon');
const CouponRedemption = require('../models/CouponRedemption');

const PRODUCT_ID = '64b7f0c2a1b2c3d4e5f60001';
const ORDER_ID = '64b7f0c2a1b2c3d4e5f60718';
const COUPON_ID = '64b7f0c2a1b2c3d4e5f60abc';

async function withStubs(stubs, fn) {
  const saved = stubs.map(([target, name]) => [target, name, target[name]]);
  stubs.forEach(([target, name, impl]) => { target[name] = impl; });
  try { await fn(); } finally { saved.forEach(([target, name, original]) => { target[name] = original; }); }
}
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { await fn(); } finally { for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
const quiet = [console, 'error', () => {}];
async function ownerLogin() {
  const agent = request.agent(app);
  const res = await agent.post('/admin/login').send(OWNER);
  assert.equal(res.status, 200);
  return { agent, csrf: res.body.csrfToken };
}
const put = (o, url, body) => o.agent.put(url).set('X-CSRF-Token', o.csrf).send(body);

const customer = { customerName: 'Buyer', customerEmail: 'buyer@example.com', customerPhone: '01711111111',
  deliveryAddress: { address: '1 Road', city: 'Dhaka', postcode: '1200', country: 'Bangladesh' } };
const product = (extra = {}) => ({ _id: PRODUCT_ID, title: 'Bomber', price: 100, stock: 5, ...extra });

test('an order without a valid size is refused before any stock is taken', async () => {
  let reserved = false;
  await withStubs([
    [Product, 'findById', async () => product()],
    [Product, 'findOneAndUpdate', async () => { reserved = true; return {}; }]
  ], async () => {
    for (const size of [undefined, '', 'HUGE', 5]) {
      const res = await request(app).post('/api/orders')
        .send({ ...customer, items: [{ productId: PRODUCT_ID, quantity: 1, size }] });
      assert.equal(res.status, 400);
      assert.match(res.body.message, /choose a size/i);
    }
  });
  assert.equal(reserved, false);
});

test('a deleted product gives a clear message and the id of the item to remove', async () => {
  await withStubs([[Product, 'findById', async () => null]], async () => {
    const res = await request(app).post('/api/orders')
      .send({ ...customer, items: [{ productId: PRODUCT_ID, quantity: 1, size: 'M' }] });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /no longer available/i);
    assert.ok(!res.body.message.includes(PRODUCT_ID), 'the raw id is not shown to the customer');
    assert.deepEqual(res.body.unavailable, [PRODUCT_ID]);
  });
});

test('the total the customer saw must match: a changed price is refused and nothing is reserved', async () => {
  let reserved = false;
  await withStubs([
    [Product, 'findById', async () => product()],
    [Product, 'findOneAndUpdate', async () => { reserved = true; return {}; }]
  ], async () => {
    const res = await request(app).post('/api/orders')
      .send({ ...customer, expectedTotal: 150, items: [{ productId: PRODUCT_ID, quantity: 2, size: 'M' }] });
    assert.equal(res.status, 409);
    assert.equal(res.body.priceChanged, true);
    assert.equal(res.body.serverTotal, 200);
  });
  assert.equal(reserved, false);
});

test('a store with no payment gateway set up refuses card orders with a clear message', async () => {
  await withEnv({ SSLCOMMERZ_STORE_ID: 'your-sslcommerz-store-id' }, async () => {
    const res = await request(app).post('/api/orders')
      .send({ ...customer, items: [{ productId: PRODUCT_ID, quantity: 1, size: 'M' }] });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /not set up/i);
  });
});

test('/api/payment-options only reports methods that are really configured', async () => {
  await withEnv({ SSLCOMMERZ_STORE_ID: 'your-sslcommerz-store-id', MANUAL_PAYMENT_ENABLED: 'true', MANUAL_PAYMENT_HOURS: '12', MANUAL_PAYMENT_INSTRUCTIONS: 'bKash 017xx' }, async () => {
    const body = (await request(app).get('/api/payment-options')).body;
    assert.equal(body.sslcommerz.enabled, false);
    assert.equal(body.stripe.enabled, false);
    assert.deepEqual(body.manual, { enabled: true, hours: 12, instructions: 'bKash 017xx' });
  });
});

test('a repeated checkout request returns the same payment page instead of a second order', async () => {
  let created = false;
  await withStubs([
    [Order, 'findOne', async () => ({ _id: ORDER_ID, transactionId: 'TXN-1', customerEmail: customer.customerEmail, totalAmount: 200, paymentGateway: 'sslcommerz', status: 'PENDING', gatewayUrl: 'https://pay.example/abc' })],
    [Order, 'create', async () => { created = true; return {}; }]
  ], async () => {
    const res = await request(app).post('/api/orders')
      .send({ ...customer, clientRequestId: 'req-0123456789abcdef', items: [{ productId: PRODUCT_ID, quantity: 1, size: 'M' }] });
    assert.equal(res.status, 200);
    assert.equal(res.body.idempotent, true);
    assert.equal(res.body.paymentUrl, 'https://pay.example/abc');
    assert.equal(res.body.transactionId, 'TXN-1');
  });
  assert.equal(created, false);
});

test('a repeated request for an order that has expired says so, instead of reusing a dead payment page', async () => {
  await withStubs([[Order, 'findOne', async () => ({ _id: ORDER_ID, transactionId: 'TXN-1', customerEmail: customer.customerEmail, paymentGateway: 'sslcommerz', status: 'CANCELLED', gatewayUrl: 'https://pay.example/abc' })]], async () => {
    const res = await request(app).post('/api/orders')
      .send({ ...customer, clientRequestId: 'req-0123456789abcdef', items: [{ productId: PRODUCT_ID, quantity: 1, size: 'M' }] });
    assert.equal(res.status, 409);
    assert.equal(res.body.expired, true);
  });
});

test('the order never stores a null clientRequestId (it would clash with the unique index)', async () => {
  let doc;
  await withStubs([
    quiet,
    [Product, 'findById', async () => product()],
    [Product, 'findOneAndUpdate', async () => ({})],
    [Order, 'create', async (d) => { doc = d; return { _id: ORDER_ID, items: [], totalAmount: 100 }; }],
    [Order, 'updateOne', async () => ({})],
    [require('sslcommerz-lts').prototype, 'init', async () => ({ GatewayPageURL: 'https://pay.example/x' })]
  ], async () => {
    const res = await request(app).post('/api/orders')
      .send({ ...customer, items: [{ productId: PRODUCT_ID, quantity: 1, size: 'M' }] });
    assert.equal(res.status, 200);
    assert.equal(res.body.paymentUrl, 'https://pay.example/x');
  });
  assert.ok(!('clientRequestId' in doc), 'no clientRequestId key when the browser sent none');
});

test('a Stripe payment is only accepted for the exact amount and currency of the order', async () => {
  const { settleStripeSession } = require('../routes/api');
  const req = { app: { get: () => null } };
  const order = { _id: ORDER_ID, transactionId: 'TXN-1', paymentGateway: 'stripe', status: 'PENDING', totalAmount: 1000, stripeAmountCents: 840, items: [] };
  const session = (extra) => ({ id: 'cs_1', client_reference_id: 'TXN-1', payment_status: 'paid', payment_intent: 'pi_1', amount_total: 840, currency: 'xxx', ...extra });
  let confirmed = 0;
  await withStubs([
    quiet,
    [Order, 'findOne', async () => order],
    [Order, 'findOneAndUpdate', async () => { confirmed++; return { ...order, status: 'CONFIRMED' }; }]
  ], async () => {
    assert.equal((await settleStripeSession(session({ amount_total: 100 }), req)).result, 'invalid');
    assert.equal((await settleStripeSession(session({ currency: 'yyy' }), req)).result, 'invalid');
    assert.equal((await settleStripeSession(session({ payment_status: 'unpaid' }), req)).result, 'invalid');
    assert.equal(confirmed, 0, 'nothing was confirmed for a wrong amount, currency or status');
    assert.equal((await settleStripeSession(session(), req)).result, 'confirmed');
    assert.equal(confirmed, 1);
  });
});

test('a Stripe order with no recorded amount must also match its total exactly, with no rounding allowance', async () => {
  const { settleStripeSession } = require('../routes/api');
  const intl = require('../services/intlGateways');
  const req = { app: { get: () => null } };
  const order = { _id: ORDER_ID, transactionId: 'TXN-2', paymentGateway: 'stripe', status: 'PENDING', totalAmount: 1000, items: [] };
  const expected = intl.toMinorUnits(1000);
  const session = (amount) => ({ id: 'cs_2', client_reference_id: 'TXN-2', payment_status: 'paid', payment_intent: 'pi_2', amount_total: amount, currency: 'xxx' });
  let confirmed = 0;
  await withStubs([
    quiet,
    [Order, 'findOne', async () => order],
    [Order, 'findOneAndUpdate', async () => { confirmed++; return { ...order, status: 'CONFIRMED' }; }]
  ], async () => {
    assert.equal((await settleStripeSession(session(expected - 1), req)).result, 'invalid', 'one cent too little');
    assert.equal((await settleStripeSession(session(expected + 1), req)).result, 'invalid', 'one cent too much');
    assert.equal(confirmed, 0);
    assert.equal((await settleStripeSession(session(expected), req)).result, 'confirmed');
    assert.equal(confirmed, 1);
  });
});

test('a Stripe session cannot confirm an order that was not placed with Stripe', async () => {
  const { settleStripeSession } = require('../routes/api');
  await withStubs([quiet, [Order, 'findOne', async () => ({ transactionId: 'TXN-1', paymentGateway: 'sslcommerz', totalAmount: 100 })]], async () => {
    const out = await settleStripeSession({ client_reference_id: 'TXN-1', payment_status: 'paid', amount_total: 84, currency: 'xxx' }, { app: { get: () => null } });
    assert.equal(out.result, 'invalid');
  });
});

test('the payment reference needs the order transaction ID, not just the order ID', async () => {
  let filter;
  await withStubs([[Order, 'findOneAndUpdate', async (f) => { filter = f; return { paymentReference: null }; }], [Order, 'countDocuments', async () => 1], [Order, 'updateMany', async () => ({})]], async () => {
    const noTran = await request(app).post(`/api/orders/${ORDER_ID}/payment-reference`).send({ paymentReference: 'ABC' });
    assert.equal(noTran.status, 400);
    const ok = await request(app).post(`/api/orders/${ORDER_ID}/payment-reference`).send({ paymentReference: 'ABC', transactionId: 'MAN-1' });
    assert.equal(ok.status, 200);
    assert.equal(filter.transactionId, 'MAN-1');
    assert.equal(filter.paymentGateway, 'manual');
    const badId = await request(app).post('/api/orders/not-an-id/payment-reference').send({ paymentReference: 'A', transactionId: 'x' });
    assert.equal(badId.status, 404);
  });
});

test('unconfirmed manual-payment orders expire and give their stock back, unless they have a payment reference (then they are flagged)', async () => {
  const { expireUnconfirmedManualOrders } = require('../services/orderService');
  let findFilter; const restocked = []; const released = [];
  const flagged = [];
  await withEnv({ MANUAL_PAYMENT_HOURS: '2' }, async () => {
    await withStubs([
      [Order, 'find', (f) => { findFilter = f; return { sort: () => ({ limit: async () => [{ _id: 'o1' }, { _id: 'o2', paymentReference: 'REF123' }] }) }; }],
      [Order, 'updateOne', async (f, u) => { flagged.push({ id: f._id, issue: u.$set.paymentIssue }); return {}; }],
      [Order, 'findOneAndUpdate', async (f) => f._id === 'o1' ? { _id: 'o1', paymentGateway: 'manual', customerEmail: 'A@B.com', couponId: COUPON_ID, items: [{ productId: PRODUCT_ID, quantity: 2 }] } : null],
      [Product, 'updateOne', async (f, u) => { restocked.push(u.$inc.stock); return {}; }],
      [CouponRedemption, 'updateOne', async (f) => { released.push(f.customerKey); return {}; }],
      [Coupon, 'updateOne', async () => ({})]
    ], async () => { assert.equal(await expireUnconfirmedManualOrders(), 1); });
  });
  assert.equal(findFilter.paymentGateway, 'manual');
  assert.equal(findFilter.status, 'PLACED');
  assert.ok(Date.now() - findFilter.createdAt.$lt.getTime() < 2 * 3600 * 1000 + 5000);
  assert.deepEqual(restocked, [2]);
  assert.deepEqual(released, ['a@b.com']);
  assert.deepEqual(flagged, [{ id: 'o2', issue: 'PAYMENT_UNCONFIRMED' }]);
});

test('cancelling or reopening an order returns / takes the per-customer coupon use too', async () => {
  const { cancelPendingOrder, reopenCancelledOrder } = require('../services/orderService');
  const calls = [];
  const order = { _id: 'o1', customerEmail: 'Buyer@Example.com', couponId: COUPON_ID, items: [], stockReleased: true, status: 'CANCELLED' };
  await withStubs([
    [Order, 'findOneAndUpdate', async () => order],
    [CouponRedemption, 'updateOne', async (f, u, o) => { calls.push([f.customerKey, u.$inc.count, !!(o && o.upsert)]); return {}; }],
    [Coupon, 'updateOne', async () => ({})]
  ], async () => { await cancelPendingOrder({ _id: 'o1' }); });
  assert.deepEqual(calls, [['buyer@example.com', -1, false]]);

  calls.length = 0;
  await withStubs([
    [Order, 'findById', async () => order],
    [Order, 'findOneAndUpdate', async () => ({ ...order, status: 'PLACED' })],
    [CouponRedemption, 'updateOne', async (f, u, o) => { calls.push([f.customerKey, u.$inc.count, !!(o && o.upsert)]); return {}; }],
    [Coupon, 'findOneAndUpdate', async () => ({ _id: COUPON_ID })],
    [Coupon, 'updateOne', async () => ({})]
  ], async () => { assert.equal((await reopenCancelledOrder('o1', 'PLACED')).result, 'reopened'); });

  // A coupon that has run out of uses blocks the reopen and the stock goes back.
  const restocked = [];
  await withStubs([
    [Order, 'findById', async () => ({ ...order, items: [{ productId: PRODUCT_ID, quantity: 1 }] })],
    [Product, 'findOneAndUpdate', async () => ({ _id: PRODUCT_ID })],
    [Product, 'updateOne', async (f, u) => { restocked.push(u.$inc.stock); return {}; }],
    [Coupon, 'findOneAndUpdate', async () => null]
  ], async () => { assert.equal((await reopenCancelledOrder('o1', 'PLACED')).result, 'coupon_unavailable'); });
  assert.deepEqual(restocked, [1]);
  assert.deepEqual(calls, [['buyer@example.com', 1, true]]);
});

test('the cart coupon preview applies the per-customer limit once the email is known', async () => {
  const live = { _id: COUPON_ID, code: 'ONCE', type: 'percent', value: 10, active: true, usedCount: 0, perCustomerLimit: 1 };
  await withStubs([
    [Product, 'find', () => ({ select: () => ({ lean: async () => [{ _id: PRODUCT_ID, price: 100 }] }) })],
    [Coupon, 'findOne', async () => live],
    [CouponRedemption, 'findOne', async () => ({ count: 1 })]
  ], async () => {
    const items = [{ productId: PRODUCT_ID, quantity: 2, size: 'M' }];
    const anon = await request(app).post('/api/coupons/validate').send({ code: 'ONCE', items });
    assert.equal(anon.status, 200);
    const used = await request(app).post('/api/coupons/validate').send({ code: 'ONCE', items, email: 'buyer@example.com' });
    assert.equal(used.status, 400);
  });
});

test('the cart coupon preview asks for a size, like checkout does', async () => {
  const live = { _id: COUPON_ID, code: 'ONCE', type: 'percent', value: 10, active: true, usedCount: 0 };
  await withStubs([
    [Product, 'find', () => ({ select: () => ({ lean: async () => [{ _id: PRODUCT_ID, title: 'Bomber', price: 100, stock: 5 }] }) })],
    [Coupon, 'findOne', async () => live]
  ], async () => {
    const without = await request(app).post('/api/coupons/validate').send({ code: 'ONCE', items: [{ productId: PRODUCT_ID, quantity: 1 }] });
    assert.equal(without.status, 400);
    assert.match(without.body.message, /choose a size for "Bomber"/);
    const withSize = await request(app).post('/api/coupons/validate').send({ code: 'ONCE', items: [{ productId: PRODUCT_ID, quantity: 1, size: 'M' }] });
    assert.equal(withSize.status, 200);
  });
});

test('the admin coupon list includes the per-customer limit', async () => {
  const o = await ownerLogin();
  await withStubs([[Coupon, 'find', () => ({ sort: () => ({ limit: async () => [{ _id: COUPON_ID, code: 'X', type: 'fixed', value: 5, perCustomerLimit: 2, usedCount: 0, active: true }] }) })]], async () => {
    const res = await o.agent.get('/admin/coupons');
    assert.equal(res.status, 200);
    assert.equal(res.body[0].perCustomerLimit, 2);
  });
});

test('an admin cannot skip steps: PLACED to SHIPPED and PENDING to CONFIRMED are refused', async () => {
  const o = await ownerLogin();
  let wrote = false;
  for (const [from, to, gw] of [['PLACED', 'SHIPPED', 'cod'], ['PENDING', 'CONFIRMED', 'sslcommerz'], ['SHIPPED', 'PLACED', 'cod']]) {
    await withStubs([
      [Order, 'findById', async () => ({ _id: ORDER_ID, status: from, paymentGateway: gw, items: [] })],
      [Order, 'findOneAndUpdate', async () => { wrote = true; return {}; }]
    ], async () => {
      const res = await put(o, `/admin/orders/${ORDER_ID}/status`, { status: to });
      assert.equal(res.status, 409, `${from} -> ${to}`);
      assert.ok(Array.isArray(res.body.allowedStatuses));
    });
  }
  assert.equal(wrote, false);
});

test('cancelling a paid order flags REFUND_DUE, even when it had already shipped', async () => {
  const o = await ownerLogin();
  const updates = [];
  await withStubs([
    [Order, 'findById', async () => ({ _id: ORDER_ID, status: 'SHIPPED', paymentGateway: 'sslcommerz', paidAt: new Date(), items: [] })],
    [Order, 'findOneAndUpdate', (() => { let n = 0; return async (f, u) => { updates.push(u); n++; return n === 1 ? null : { _id: ORDER_ID, status: 'CANCELLED', paymentGateway: 'sslcommerz', paidAt: new Date(), customerEmail: 'a@b.co', items: [], ...(u.$set && u.$set.paymentIssue ? { paymentIssue: u.$set.paymentIssue } : {}) }; }; })()]
  ], async () => {
    const res = await put(o, `/admin/orders/${ORDER_ID}/status`, { status: 'CANCELLED' });
    assert.equal(res.status, 200);
    assert.equal(res.body.paymentIssue, 'REFUND_DUE');
  });
  assert.ok(updates.some((u) => u.$set && u.$set.paymentIssue === 'REFUND_DUE'));
});

test('confirming a manual-payment order records the payment and clears any unconfirmed flag', async () => {
  const o = await ownerLogin();
  let update;
  await withStubs([
    [Order, 'findById', async () => ({ _id: ORDER_ID, status: 'PLACED', paymentGateway: 'manual', paymentIssue: 'PAYMENT_UNCONFIRMED', items: [] })],
    [Order, 'findOneAndUpdate', async (f, u) => { update = u; return { _id: ORDER_ID, status: 'CONFIRMED', customerEmail: 'a@b.co', totalAmount: 1, items: [] }; }]
  ], async () => { assert.equal((await put(o, `/admin/orders/${ORDER_ID}/confirm`, {})).status, 200); });
  assert.equal(update.$set.status, 'CONFIRMED');
  assert.ok(update.$set.paidAt instanceof Date);
  assert.deepEqual(update.$unset, { paymentIssue: 1 });
});

test('revenue is "paid and not cancelled" in the revenue endpoint and the stats endpoint', async () => {
  const o = await ownerLogin();
  const matches = [];
  await withStubs([
    [Order, 'aggregate', async (pipeline) => {
      const first = pipeline[0];
      if (first.$match) { matches.push(first.$match); return [{ _id: null, minor: 250000, totalRevenue: 250000, count: 3, orderCount: 3 }]; }
      return [{ _id: 'PLACED', count: 2 }, { _id: 'CONFIRMED', count: 1 }];
    }],
    [Product, 'countDocuments', async () => 4]
  ], async () => {
    const rev = await o.agent.get('/admin/revenue');
    assert.equal(rev.body.totalRevenue, 2500);
    const stats = await o.agent.get('/admin/stats');
    assert.equal(stats.status, 200);
    assert.equal(stats.body.totalRevenue, 2500);
    assert.equal(stats.body.totalOrders, 3);
    assert.equal(stats.body.productCount, 4);
  });
  assert.equal(matches.length, 2);
  for (const m of matches) assert.deepEqual(m, { paidAt: { $ne: null }, status: { $ne: 'CANCELLED' } });
});

test('the orders list is paged, filterable, and says what each order may become next', async () => {
  const o = await ownerLogin();
  let filter, skipped, limited;
  await withStubs([
    [Order, 'find', (f) => { filter = f; return { sort: () => ({ skip: (n) => { skipped = n; return { limit: async (l) => { limited = l; return [{ _id: ORDER_ID, status: 'PLACED', paymentGateway: 'cod', totalAmount: 10, items: [] }]; } }; } }) }; }],
    [Order, 'countDocuments', async () => 120]
  ], async () => {
    const res = await o.agent.get('/admin/orders?page=2&limit=50&status=placed');
    assert.equal(res.status, 200);
    assert.equal(res.body.pagination.total, 120);
    assert.equal(res.body.pagination.pages, 3);
    assert.deepEqual(res.body.orders[0].allowedStatuses, ['CONFIRMED', 'CANCELLED']);
    assert.equal(res.body.orders[0].countsAsRevenue, false);
  });
  assert.deepEqual(filter, { status: 'PLACED' });
  assert.equal(skipped, 50);
  assert.equal(limited, 50);
});

test('an expired admin session answers 401 JSON that the dashboard can act on', async () => {
  const res = await request(app).get('/admin/orders');
  assert.equal(res.status, 401);
  assert.match(res.body.message, /login/i);
  assert.match(fs.readFileSync(path.join(__dirname, '../public/js/admin.js'), 'utf8'), /function sessionExpired/);
});

test('requests with no body get 400, not 500', async () => {
  assert.equal((await request(app).post('/admin/login')).status, 400);
  assert.equal((await request(app).post('/api/users/login')).status, 400);
  assert.equal((await request(app).post('/api/users/register')).status, 400);
  assert.equal((await request(app).post(`/api/orders/${ORDER_ID}/payment-reference`)).status, 400);
  assert.equal((await request(app).post('/api/orders')).status, 400);
  assert.equal((await request(app).post('/api/chat')).status, 400);
});

test('invalid JSON is a 400 with a plain message, and server errors do not leak details', async () => {
  const bad = await request(app).post('/api/orders').set('Content-Type', 'application/json').send('{not json');
  assert.equal(bad.status, 400);
  assert.match(bad.body.message, /not valid JSON/);
});

test('a non-string admin username or password is a 400', async () => {
  const res = await request(app).post('/admin/login').send({ username: { $ne: '' }, password: ['x'] });
  assert.equal(res.status, 400);
});

test('admin product edits reject bad ids and bad image values instead of crashing', async () => {
  const o = await ownerLogin();
  assert.equal((await put(o, '/admin/products/not-an-id', { title: 'Shirt' })).status, 400);
  await withStubs([[Product, 'findByIdAndUpdate', async () => ({ _id: PRODUCT_ID, title: 'x' })]], async () => {
    assert.equal((await put(o, `/admin/products/${PRODUCT_ID}`, { imageUrl: 12345 })).status, 400);
    assert.equal((await put(o, `/admin/products/${PRODUCT_ID}`, { imageUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' })).status, 400);
    assert.equal((await put(o, `/admin/products/${PRODUCT_ID}`, { imageUrl: 'javascript:alert(1)' })).status, 400);
    assert.equal((await put(o, `/admin/products/${PRODUCT_ID}`, { imageUrl: 'https://example.com/a.jpg' })).status, 200);
  });
});

test('the audit log ignores repeated query parameters instead of crashing', async () => {
  const o = await ownerLogin();
  assert.equal((await o.agent.get('/admin/audit-log?action=a&action=b&actor[x]=1')).status, 200);
});

test('audit entries never store picture data', () => {
  const { redact } = require('../services/auditService');
  const out = redact({ imageUrl: 'data:image/png;base64,' + 'A'.repeat(5000), title: 'ok', nested: [{ big: 'x'.repeat(5000) }] });
  assert.match(out.imageUrl, /image data omitted/);
  assert.equal(out.title, 'ok');
  assert.ok(out.nested[0].big.length < 1100);
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const PNG_URI = 'data:image/png;base64,' + PNG.toString('base64');

test('uploaded pictures are served as cacheable image files, and lists carry only the short address', async () => {
  await withStubs([
    // The list comes from an aggregation that swaps an uploaded picture for a one-word marker.
    [Product, 'aggregate', async () => [{ _id: PRODUCT_ID, title: 'Bomber', imageUrl: 'data:image/uploaded', updatedAt: new Date(5) }]],
    [Product, 'findById', () => ({ select: async () => ({ imageUrl: PNG_URI }) })]
  ], async () => {
    const list = await request(app).get('/api/products');
    assert.equal(list.body[0].imageUrl, `/api/products/${PRODUCT_ID}/image?v=5`);
    assert.ok(JSON.stringify(list.body).length < 500);
    const img = await request(app).get(`/api/products/${PRODUCT_ID}/image`).buffer(true).parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    assert.equal(img.status, 200);
    assert.equal(img.headers['content-type'], 'image/png');
    assert.match(img.headers['cache-control'], /max-age=86400/);
    assert.equal(img.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(img.body, PNG);
  });
});

test('image validation accepts real pictures and refuses SVG, fakes and oversize files', () => {
  const { cleanImageInput } = require('../services/images');
  assert.equal(cleanImageInput(PNG_URI).ok, true);
  assert.equal(cleanImageInput('/img/products/x.svg').ok, true);
  assert.equal(cleanImageInput('https://example.com/a.jpg').ok, true);
  assert.equal(cleanImageInput('').value, '');
  assert.equal(cleanImageInput(`/api/products/${PRODUCT_ID}/image?v=1`).keep, true);
  assert.equal(cleanImageInput('data:image/png;base64,' + Buffer.from('hello world, not a png at all').toString('base64')).ok, false);
  assert.equal(cleanImageInput('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=').ok, false);
  assert.equal(cleanImageInput('data:image/png;base64,' + Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]).toString('base64')).ok, false);
  assert.equal(cleanImageInput('ftp://example.com/a.png').ok, false);
  assert.equal(cleanImageInput('//evil.example/a.png').ok, false);
  assert.equal(cleanImageInput({}).ok, false);
});

test('the status map allows only legal steps', () => {
  const { allowedNextStatuses, canTransition } = require('../services/orderStatus');
  assert.deepEqual(allowedNextStatuses({ status: 'PLACED' }), ['CONFIRMED', 'CANCELLED']);
  assert.deepEqual(allowedNextStatuses({ status: 'PENDING' }), ['CANCELLED']);
  assert.equal(canTransition({ status: 'CONFIRMED' }, 'DELIVERED'), false);
  assert.deepEqual(allowedNextStatuses({ status: 'CANCELLED', paymentGateway: 'sslcommerz' }), []);
  assert.deepEqual(allowedNextStatuses({ status: 'CANCELLED', paymentGateway: 'sslcommerz', paidAt: new Date() }), ['CONFIRMED']);
  assert.deepEqual(allowedNextStatuses({ status: 'CANCELLED', paymentGateway: 'cod' }), ['PLACED', 'CONFIRMED']);
});

test('placeholder values in .env.example do not count as configured', () => {
  const { isRealValue, sslcommerzConfigured, stripeConfigured } = require('../services/paymentConfig');
  assert.equal(isRealValue('your-sslcommerz-store-id'), false);
  assert.equal(isRealValue(''), false);
  assert.equal(isRealValue('abc123'), true);
  assert.equal(sslcommerzConfigured({ SSLCOMMERZ_STORE_ID: 'id', SSLCOMMERZ_STORE_PASSWORD: 'pw', CURRENCY_CODE: 'XXX' }), true);
  assert.equal(sslcommerzConfigured({ SSLCOMMERZ_STORE_ID: 'id', SSLCOMMERZ_STORE_PASSWORD: 'pw' }), false);   // no currency code: not offered
  assert.equal(sslcommerzConfigured({ SSLCOMMERZ_STORE_ID: 'id' }), false);
  assert.equal(stripeConfigured({ STRIPE_SECRET_KEY: '', CURRENCY_CODE: 'XXX' }), false);
});

test('a request to /api/users counts once against the rate limit, and payment callbacks not at all', async () => {
  const a = await request(app).get('/api/users/me');
  const b = await request(app).get('/api/users/me');
  const remaining = (r) => Number(r.headers['ratelimit-remaining']);
  assert.equal(remaining(a) - remaining(b), 1);
  // Payment callbacks have a limit of their own (200 per 5 minutes) and do NOT use up the general
  // one.
  const ipn = await request(app).post('/api/payment/ipn').send({});
  assert.equal(ipn.headers['ratelimit-limit'], '200');
  assert.ok(Number(ipn.headers['ratelimit-remaining']) <= 199);
  await request(app).post('/api/payment/ipn').send({});
  await request(app).post('/api/payment/ipn').send({});
  const c = await request(app).get('/api/users/me');
  assert.equal(remaining(b) - remaining(c), 1, 'three payment callbacks did not count against the general limit');
});

const pub = (f) => fs.readFileSync(path.join(__dirname, '../public', f), 'utf8');
const PAGES = ['index.html', 'admin.html', 'payment-success.html', 'payment-fail.html'];

test('every CDN script and stylesheet has an integrity hash', () => {
  for (const f of PAGES) {
    const tags = pub(f).match(/<(?:script|link)[^>]+(?:src|href)="https?:\/\/[^"]+"[^>]*>/g) || [];
    assert.ok(tags.length > 0, f);
    for (const t of tags) assert.match(t, /integrity="sha384-[A-Za-z0-9+/=]+"/, `${f}: ${t}`);
  }
});

test('the pages have no inline scripts or inline event handlers (so the CSP can forbid them)', () => {
  for (const f of PAGES) {
    const html = pub(f);
    assert.deepEqual(html.match(/<script(?![^>]*\bsrc=)(?![^>]*ld\+json)[^>]*>/g) || [], [], `${f} has an inline script`);
    assert.deepEqual(html.match(/\son(?:click|error|load|change|input|submit)=/gi) || [], [], `${f} has an inline handler`);
  }
  for (const f of ['js/app.js', 'js/admin.js', 'js/chat.js']) {
    assert.ok(!/\son(?:click|error|load)=\\?["']/.test(pub(f)), `${f} builds inline handlers`);
  }
});

test('the server sends a Content-Security-Policy that allows only this site and the CDN hosts', async () => {
  const res = await request(app).get('/');
  const csp = res.headers['content-security-policy'];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self' https:\/\/cdn\.jsdelivr\.net https:\/\/code\.jquery\.com/);
  assert.match(csp, /object-src 'none'/);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
});

test('connect-src allows this site and its own websocket origin, not every websocket', async () => {
  const csp = (await request(app).get('/')).headers['content-security-policy'];
  const connect = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src'));
  assert.ok(!/\bwss?:(?!\/\/)/.test(connect), connect);
  const origin = new URL(process.env.BASE_URL || 'http://localhost:3000');
  if (process.env.BASE_URL) assert.ok(connect.includes(`${origin.protocol === 'https:' ? 'wss' : 'ws'}://${origin.host}`), connect);
});

test('the storefront keeps the cart until payment succeeds and uses one idempotency id per attempt', () => {
  const app_js = pub('js/app.js');
  assert.ok(!/paymentUrl\)\s*\{\s*saveCart\(\[\]\)/.test(app_js), 'the cart is not emptied before the redirect');
  assert.match(app_js, /clientRequestId:\s*checkoutRequestId/);
  assert.match(app_js, /expectedTotal/);
  assert.match(pub('js/payment-success.js'), /localStorage\.removeItem\('threadly_cart'\)/);
  assert.match(pub('index.html'), /id="gatewayManual"/);
});

test('the storefront scripts are valid JavaScript and survive a damaged cart', () => {
  const vm = require('node:vm');
  for (const f of ['js/app.js', 'js/admin.js', 'js/admin-coupons.js', 'js/chat.js', 'js/payment-success.js', 'js/payment-fail.js']) {
    assert.doesNotThrow(() => new vm.Script(pub(f), { filename: f }), f);
  }
  const src = pub('js/app.js');
  const body = src.slice(src.indexOf('function getCart()'), src.indexOf('function saveCart'));
  const ls = { getItem: () => '{not json' };
  const getCart = new Function('localStorage', 'cartKey', `${body}; return getCart();`);
  assert.deepEqual(getCart(ls, 'k'), []);
  const ok = new Function('localStorage', 'cartKey', `${body}; return getCart();`);
  assert.equal(ok({ getItem: () => JSON.stringify([{ productId: 'a', quantity: 1, price: 5 }, { bogus: true }, 7]) }, 'k').length, 1);
});

test('both REFUND_DUE and PAID_AFTER_CANCEL can be refunded once, a second call returns 409', async () => {
  const o = await ownerLogin();
  const db = [];
  const saved = [];
  await withStubs([
    [Order, 'findOne', async (f) => (db.includes(f._id) ? null : { _id: f._id, totalAmount: 100 })],
    [Order, 'findOneAndUpdate', async (f, u) => {
      if (f.paymentIssue && f.paymentIssue.$in && (f.paymentIssue.$in.includes('REFUND_DUE') || f.paymentIssue.$in.includes('PAID_AFTER_CANCEL'))) {
        if (db.includes(f._id)) return null;
        db.push(f._id);
        saved.push(u.$set);
        return { _id: f._id };
      }
      return null;
    }]
  ], async () => {
    assert.equal((await put(o, '/admin/orders/o1/mark-refunded')).status, 400); // 400 for bad object id format
    assert.equal((await put(o, '/admin/orders/64b7f0c2a1b2c3d4e5f60001/mark-refunded')).status, 200);
    assert.equal((await put(o, '/admin/orders/64b7f0c2a1b2c3d4e5f60001/mark-refunded')).status, 409);
    assert.equal((await put(o, '/admin/orders/64b7f0c2a1b2c3d4e5f60002/mark-refunded')).status, 200);
    // The refund record: the full total by default, or a partial amount that cannot exceed what
    // was paid.
    assert.equal(saved[0].refundedAmount, 100);
    const withBody = (id, body) => o.agent.put(`/admin/orders/${id}/mark-refunded`).set('X-CSRF-Token', o.csrf).send(body);
    assert.equal((await withBody('64b7f0c2a1b2c3d4e5f60003', { amount: '500' })).status, 400);
    assert.equal((await withBody('64b7f0c2a1b2c3d4e5f60003', { amount: '0' })).status, 400);
    assert.equal((await withBody('64b7f0c2a1b2c3d4e5f60003', { amount: '40.5', note: 'bKash TX123' })).status, 200);
    assert.equal(saved[2].refundedAmount, 40.5);
    assert.equal(saved[2].refundNote, 'bKash TX123');
  });
});



