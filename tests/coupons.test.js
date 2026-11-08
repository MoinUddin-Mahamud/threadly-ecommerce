// Tests for coupons: the rules, atomic use counting, the cart box, discounted
// totals at checkout, giving a use back (failed, cancelled, expired, reopened),
// the admin screens and their permissions, emails, and the pages.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const nodemailer = require('nodemailer');
const SSLCommerzPayment = require('sslcommerz-lts');
const { app, OWNER, resetData, addAccount } = require('./helpers');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Coupon = require('../models/Coupon');
const CouponRedemption = require('../models/CouponRedemption');
const Role = require('../models/Role');
const rules = require('../services/coupons');
const { claimCoupon, applyCoupon } = require('../services/couponService');
const { cancelPendingOrder, cancelOrderAndRestock, expirePendingOrders } = require('../services/orderService');
const { ALL_PERMISSIONS, DEFAULT_ROLES } = require('../services/permissions');

const PRODUCT_ID = '64b7f0c2a1b2c3d4e5f60999';
const COUPON_ID = '64b7f0c2a1b2c3d4e5f60c01';
// Orders in the status tests need the fields the status email reads
const MAILABLE = { totalAmount: 200, customerName: 'B', customerEmail: 'b@example.com' };
const ORDER_ID = '64b7f0c2a1b2c3d4e5f60718';
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

// In-memory Coupon collection that understands the claim filter
function matchValue(actual, cond) {
  if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
    return Object.entries(cond).every(([op, v]) => {
      if (op === '$lte') return actual != null && actual <= v;
      if (op === '$gte') return actual != null && actual >= v;
      if (op === '$gt') return actual != null && actual > v;
      throw new Error('unsupported operator ' + op);
    });
  }
  return cond === null ? actual == null : actual === cond;
}
function matchDoc(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$and') return cond.every((f) => matchDoc(doc, f));
    if (key === '$or') return cond.some((f) => matchDoc(doc, f));
    if (key === '$expr') {
      const [a, b] = cond.$lt.map((x) => doc[x.slice(1)]);
      return a < b;
    }
    return matchValue(doc[key], cond);
  });
}
function fakeCoupons(docs, log = {}) {
  log.released = 0; log.reclaimed = 0; log.redemptionUpdates = [];
  return [
    // The per-customer use count.
    [CouponRedemption, 'updateOne', async (f, u, o) => { log.redemptionUpdates.push({ filter: f, update: u, options: o }); return { modifiedCount: 1 }; }],
    [Coupon, 'findOneAndUpdate', async (f, u) => {
      const d = docs.find((x) => matchDoc(x, f));
      if (!d) return null;
      if (u.$inc) d.usedCount += u.$inc.usedCount;
      if (u.$set) Object.assign(d, u.$set);
      return d;
    }],
    [Coupon, 'findOne', async (f) => docs.find((x) => matchDoc(x, f)) || null],
    [Coupon, 'updateOne', async (f, u) => {
      const d = docs.find((x) => matchDoc(x, f));
      if (d) { d.usedCount += u.$inc.usedCount; u.$inc.usedCount < 0 ? log.released++ : log.reclaimed++; }
      return {};
    }]
  ];
}
const coupon = (extra = {}) => ({
  _id: COUPON_ID, code: 'SAVE10', type: 'percent', value: 10, minOrderAmount: null, maxDiscount: null,
  usageLimit: null, usedCount: 0, startsAt: null, endsAt: null, active: true, ...extra
});

test('codes are trimmed, upper-cased and limited to 3-32 safe characters', () => {
  assert.equal(rules.normalizeCode('  save10 '), 'SAVE10');
  assert.equal(rules.normalizeCode('a_b-9'), 'A_B-9');
  for (const bad of ['', 'ab', 'x'.repeat(33), 'SAVE 10', '<b>x</b>', '-ABC', { $ne: 1 }, null, 123]) {
    assert.equal(rules.normalizeCode(bad), '', String(bad));
  }
});

test('percent and fixed discounts, the maximum discount, and the minimum order floor', (t) => {
  process.env.MIN_ORDER_TOTAL = '10';   // these tests check the minimum-order floor
  t.after(() => { delete process.env.MIN_ORDER_TOTAL; });
  assert.equal(rules.computeDiscount(coupon(), 8999.5), 899.95);
  assert.equal(rules.computeDiscount(coupon({ maxDiscount: 500 }), 8999.5), 500);
  assert.equal(rules.computeDiscount(coupon({ type: 'fixed', value: 250 }), 1000), 250);
  assert.equal(rules.computeDiscount(coupon({ type: 'fixed', value: 5000 }), 100), 90);   // never below the minimum order total
  assert.equal(rules.computeDiscount(coupon({ type: 'fixed', value: 5 }), 12), 2);
  assert.equal(rules.computeDiscount(coupon({ type: 'fixed', value: 5 }), 10), 0);
  assert.equal(rules.computeDiscount(coupon(), 0), 0);
  assert.equal(rules.computeDiscount(null, 100), 0);
});

test('status: active, disabled, scheduled, expired, used up', () => {
  const now = new Date('2026-06-15T12:00:00Z');
  assert.equal(rules.couponStatus(coupon(), now), 'active');
  assert.equal(rules.couponStatus(coupon({ active: false }), now), 'disabled');
  assert.equal(rules.couponStatus(null, now), 'disabled');
  assert.equal(rules.couponStatus(coupon({ startsAt: new Date('2026-07-01') }), now), 'scheduled');
  assert.equal(rules.couponStatus(coupon({ endsAt: new Date('2026-06-01') }), now), 'expired');
  assert.equal(rules.couponStatus(coupon({ usageLimit: 3, usedCount: 3 }), now), 'used_up');
  assert.equal(rules.couponStatus(coupon({ usageLimit: 3, usedCount: 2 }), now), 'active');
});

test('checkCoupon explains every refusal, and unknown and disabled codes look the same', (t) => {
  process.env.MIN_ORDER_TOTAL = '10';   // these tests check the minimum-order floor
  t.after(() => { delete process.env.MIN_ORDER_TOTAL; });
  const now = new Date('2026-06-15T12:00:00Z');
  assert.equal(rules.checkCoupon(coupon(), 1000, now).discount, 100);
  assert.deepEqual(rules.checkCoupon(null, 1000, now), rules.checkCoupon(coupon({ active: false }), 1000, now));
  assert.equal(rules.checkCoupon(coupon({ startsAt: new Date('2026-07-01') }), 1000, now).message, rules.MESSAGE_NOT_VALID);
  assert.equal(rules.checkCoupon(coupon({ endsAt: new Date('2026-06-01') }), 1000, now).message, rules.MESSAGE_NOT_VALID);
  assert.equal(rules.checkCoupon(coupon({ usageLimit: 1, usedCount: 1 }), 1000, now).message, rules.MESSAGE_NOT_VALID);
  assert.equal(rules.checkCoupon(coupon({ minOrderAmount: 2000 }), 1999.99, now).message, rules.MESSAGE_NOT_VALID);
  assert.equal(rules.checkCoupon(coupon({ minOrderAmount: 2000 }), 2000, now).ok, true);
  assert.equal(rules.checkCoupon(coupon({ type: 'fixed', value: 5 }), 10, now).message, rules.MESSAGE_NOT_VALID);
});

test('admin input: a valid coupon is cleaned, and every bad value is refused', () => {
  const ok = rules.validateCouponInput({ code: ' save10 ', type: 'percent', value: 10, maxDiscount: '500', usageLimit: 5 });
  assert.equal(ok.ok, true);
  assert.deepEqual([ok.value.code, ok.value.maxDiscount, ok.value.usageLimit, ok.value.active], ['SAVE10', 500, 5, true]);

  const bad = (body, pattern) => {
    const r = rules.validateCouponInput({ code: 'ABC', type: 'percent', value: 10, ...body });
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.match(r.message, pattern);
  };
  assert.equal(rules.validateCouponInput({ type: 'percent', value: 10 }).ok, false);          // no code
  assert.equal(rules.validateCouponInput({ code: 'x', type: 'percent', value: 10 }).ok, false); // too short
  assert.equal(rules.validateCouponInput('nope').ok, false);
  bad({ value: 101 }, /more than 100/);
  bad({ value: 0 }, /greater than 0/);
  bad({ value: -5 }, /greater than 0/);
  bad({ type: 'fixed', value: '100.555' }, /at most 2 decimals/);
  bad({ type: 'fixed', value: 1e9 }, /more than/);
  bad({ type: 'weird' }, /Type must be/);
  bad({ minOrderAmount: -1 }, /Minimum order/);
  bad({ maxDiscount: 0 }, /Maximum discount/);
  bad({ usageLimit: 0 }, /Usage limit/);
  bad({ usageLimit: 1.5 }, /Usage limit/);
  bad({ startsAt: 'not a date' }, /Start date/);
  bad({ startsAt: '2026-06-02', endsAt: '2026-06-01' }, /end date must be after/);
  bad({ active: 'yes' }, /true or false/);
  // a cap is dropped for a fixed coupon, and a 0 minimum means none
  const fixed = rules.validateCouponInput({ code: 'ABC', type: 'fixed', value: 50, maxDiscount: 10, minOrderAmount: 0 });
  assert.equal(fixed.value.maxDiscount, null);
  assert.equal(fixed.value.minOrderAmount, null);
});

test('admin edits: unsent fields stay, the code is fixed, the limit cannot drop below uses', () => {
  const existing = coupon({ usageLimit: 10, usedCount: 4, maxDiscount: 300 });
  const only = rules.validateCouponInput({ active: false }, existing);
  assert.equal(only.ok, true);
  assert.deepEqual([only.value.code, only.value.value, only.value.usageLimit, only.value.maxDiscount, only.value.active], ['SAVE10', 10, 10, 300, false]);
  assert.match(rules.validateCouponInput({ code: 'OTHER' }, existing).message, /cannot be changed/);
  assert.equal(rules.validateCouponInput({ code: 'save10' }, existing).ok, true);   // same code, different case
  assert.match(rules.validateCouponInput({ usageLimit: 3 }, existing).message, /already used/);
  assert.equal(rules.validateCouponInput({ usageLimit: 4 }, existing).ok, true);
});

test('the claim filter carries every rule, so it is one atomic update', async () => {
  const now = new Date('2026-06-15T12:00:00Z');
  const docs = [coupon({ usageLimit: 3 })];
  await withStubs(fakeCoupons(docs), async () => {
    const claims = await Promise.all(Array.from({ length: 10 }, () => claimCoupon('SAVE10', 1000, now)));
    assert.equal(claims.filter(Boolean).length, 3, 'only 3 of 10 simultaneous orders get a use');
  });
  assert.equal(docs[0].usedCount, 3);

  const cases = [
    [{ active: false }, 1000], [{ startsAt: new Date('2026-07-01') }, 1000], [{ endsAt: new Date('2026-06-01') }, 1000],
    [{ minOrderAmount: 2000 }, 1999], [{ usageLimit: 1, usedCount: 1 }, 1000]
  ];
  for (const [extra, subtotal] of cases) {
    const one = [coupon(extra)];
    await withStubs(fakeCoupons(one), async () => { assert.equal(await claimCoupon('SAVE10', subtotal, now), null, JSON.stringify(extra)); });
    assert.equal(one[0].usedCount, extra.usedCount || 0);
  }
});

test('applyCoupon gives the reason when the last use was just taken, and never leaves a use behind', async (t) => {
  process.env.MIN_ORDER_TOTAL = '10';   // these tests check the minimum-order floor
  t.after(() => { delete process.env.MIN_ORDER_TOTAL; });
  const docs = [coupon({ usageLimit: 1, usedCount: 1 })];
  await withStubs(fakeCoupons(docs), async () => {
    const r = await applyCoupon('save10', 1000);
    assert.equal(r.ok, false);
    assert.equal(r.message, rules.MESSAGE_NOT_VALID);
    assert.equal((await applyCoupon('nope', 1000)).message, rules.MESSAGE_NOT_VALID);
    assert.equal((await applyCoupon({ $ne: 1 }, 1000)).message, rules.MESSAGE_NOT_VALID);
  });
  const small = [coupon({ type: 'fixed', value: 5 })];
  const log = {};
  await withStubs(fakeCoupons(small, log), async () => {
    assert.equal((await applyCoupon('SAVE10', 10)).ok, false);   // discount would be 0: use is given back
  });
  assert.equal(small[0].usedCount, 0);
});

const priceStub = (price = 100) => [Product, 'find', () => ({ select: () => ({ lean: async () => [{ _id: PRODUCT_ID, price }] }) })];
const validate = (body) => request(app).post('/api/coupons/validate').send(body);
const cart = (quantity = 2) => [{ productId: PRODUCT_ID, quantity, size: 'M' }];

test('the cart box prices the cart on the server and returns the new total without using the coupon', async () => {
  const docs = [coupon({ usageLimit: 1 })];
  await withStubs([quiet, priceStub(100), ...fakeCoupons(docs)], async () => {
    const res = await validate({ code: ' save10 ', items: cart(2), subtotal: 1, total: 1, discount: 999 });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { valid: true, code: 'SAVE10', subtotal: 200, discount: 20, total: 180 });
  });
  assert.equal(docs[0].usedCount, 0, 'previewing does not use the coupon up');
});

test('the cart box refuses bad input, bad carts and unusable coupons', async () => {
  const docs = [coupon({ minOrderAmount: 500 }), coupon({ _id: 'x', code: 'OFF', active: false })];
  await withStubs([quiet, priceStub(100), ...fakeCoupons(docs)], async () => {
    for (const [body, pattern] of [
      [{ items: cart() }, /Enter a coupon code/],
      [{ code: '   ', items: cart() }, /Enter a coupon code/],
      [{ code: { $ne: 1 }, items: cart() }, /Enter a coupon code/],
      [{ code: 'x'.repeat(65), items: cart() }, /not valid/],
      [{ code: 'SAVE10', items: [] }, /empty/],
      [{ code: 'SAVE10', items: 'nope' }, /empty/],
      [{ code: 'SAVE10', items: [{ productId: 'bad', quantity: 1, size: 'M' }] }, /Invalid item/],
      [{ code: 'SAVE10', items: [{ productId: PRODUCT_ID, quantity: 1.5, size: 'M' }] }, /Invalid item/],
      [{ code: 'SAVE10', items: [{ productId: PRODUCT_ID, quantity: 11, size: 'M' }] }, /Invalid item/],
      [{ code: 'SAVE10', items: Array.from({ length: 21 }, () => cart(1)[0]) }, /at most 20/],
      [{ code: 'SAVE10', items: cart(2) }, /not valid/],
      [{ code: 'OFF', items: cart(10) }, /not valid/],
      [{ code: 'NOSUCH', items: cart(10) }, /not valid/]
    ]) {
      const res = await validate(body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
      assert.equal(res.body.valid, false);
      assert.match(res.body.message, pattern);
    }
  });
  await withStubs([quiet, [Product, 'find', () => ({ select: () => ({ lean: async () => [] }) })]], async () => {
    assert.match((await validate({ code: 'SAVE10', items: cart() })).body.message, /no longer available/);
  });
});

const address = { address: '1 Main St', city: 'Dhaka', postcode: '1200', country: 'Bangladesh' };
const orderBody = (extra = {}) => ({
  customerName: 'Buyer', customerEmail: 'buyer@example.com', customerPhone: '01700000000',
  deliveryAddress: address, items: cart(2), ...extra
});

// A store with plenty of stock; records what happened.
function store(log, coupons) {
  Object.assign(log, { reserved: 0, restocked: [], created: [], sslData: null, orderUpdates: [] });
  return [
    quiet,
    // Checkout records the gateway's session key on the new order after it is created.
    [Order, 'updateOne', async (f, u) => { log.orderUpdates.push({ filter: f, update: u }); return { modifiedCount: 1 }; }],
    [Product, 'findById', async () => ({ _id: PRODUCT_ID, title: 'Bomber', price: 100, stock: 50 })],
    [Product, 'findOneAndUpdate', async () => { log.reserved++; return {}; }],
    [Product, 'updateOne', async (f, u) => { log.restocked.push(u.$inc.stock); return {}; }],
    [Order, 'create', async (doc) => { log.created.push(doc); return { _id: ORDER_ID, ...doc }; }],
    [SSLCommerzPayment.prototype, 'init', async (d) => { log.sslData = d; return { GatewayPageURL: 'https://pay.example/x' }; }],
    ...fakeCoupons(coupons, log)
  ];
}

test('the order stores the coupon and the discounted total, and the gateway is charged that total', async () => {
  const log = {}; const docs = [coupon({ maxDiscount: 15 })];
  await withStubs(store(log, docs), async () => {
    // the browser claims a price and a discount; only the code is used
    const res = await request(app).post('/api/orders').send(orderBody({ couponCode: ' save10 ', totalAmount: 1, discountAmount: 999 }));
    assert.equal(res.status, 200);
  });
  const saved = log.created[0];
  assert.equal(saved.totalAmount, 185);             // 200 - min(10% of 200, cap 15)
  assert.equal(saved.discountAmount, 15);
  assert.equal(saved.couponCode, 'SAVE10');
  assert.equal(String(saved.couponId), COUPON_ID);
  assert.equal(log.sslData.total_amount, 185);
  assert.equal(docs[0].usedCount, 1);
});

test('an order without a coupon is unchanged', async () => {
  const log = {}; const docs = [coupon()];
  await withStubs(store(log, docs), async () => {
    assert.equal((await request(app).post('/api/orders').send(orderBody())).status, 200);
  });
  assert.equal(log.created[0].totalAmount, 200);
  assert.equal(log.created[0].couponId, undefined);
  assert.equal(log.created[0].discountAmount, undefined);
  assert.equal(docs[0].usedCount, 0);
});

test('an unusable coupon stops the order before any stock is taken', async () => {
  const log = {}; const docs = [coupon({ usageLimit: 1, usedCount: 1 }), coupon({ _id: 'b', code: 'BIG', minOrderAmount: 5000 })];
  await withStubs(store(log, docs), async () => {
    for (const [code, pattern] of [['SAVE10', /not valid/], ['BIG', /not valid/], ['NOSUCH', /not valid/]]) {
      const res = await request(app).post('/api/orders').send(orderBody({ couponCode: code }));
      assert.equal(res.status, 400);
      assert.equal(res.body.couponInvalid, true);
      assert.match(res.body.message, pattern);
    }
    for (const bad of [{ $ne: null }, 12345, 'x'.repeat(65)]) {
      assert.equal((await request(app).post('/api/orders').send(orderBody({ couponCode: bad }))).status, 400);
    }
  });
  assert.equal(log.reserved, 0);
  assert.equal(log.created.length, 0);
});

test('the coupon use is given back when the stock runs out', async () => {
  const log = {}; const docs = [coupon()];
  await withStubs([...store(log, docs), [Product, 'findOneAndUpdate', async () => null]], async () => {
    const res = await request(app).post('/api/orders').send(orderBody({ couponCode: 'SAVE10' }));
    assert.equal(res.status, 409);
    assert.match(res.body.message, /not enough stock/i);
  });
  assert.equal(docs[0].usedCount, 0);
});

test('the coupon use is given back when saving the order fails', async () => {
  const log = {}; const docs = [coupon()];
  await withStubs([...store(log, docs), [Order, 'create', async () => { throw new Error('db down'); }]], async () => {
    assert.equal((await request(app).post('/api/orders').send(orderBody({ couponCode: 'SAVE10' }))).status, 500);
  });
  assert.equal(docs[0].usedCount, 0);
  assert.deepEqual(log.restocked, [2]);
});

test('the coupon use is given back, once, when the payment gateway fails', async () => {
  const log = {}; const docs = [coupon()];
  const order = { _id: ORDER_ID, items: [{ productId: PRODUCT_ID, quantity: 2, size: 'M' }], couponId: COUPON_ID };
  await withStubs([
    ...store(log, docs),
    [SSLCommerzPayment.prototype, 'init', async () => ({ status: 'FAILED' })],
    [Order, 'create', async (doc) => ({ _id: ORDER_ID, ...doc })],
    [Order, 'findOneAndUpdate', async () => order],       // the single conditional cancel
    [Order, 'findByIdAndDelete', async () => { throw new Error('db down'); }]
  ], async () => {
    assert.equal((await request(app).post('/api/orders').send(orderBody({ couponCode: 'SAVE10' }))).status, 502);
  });
  assert.equal(docs[0].usedCount, 0);
  assert.equal(log.released, 1);
});

test('a coupon works with Cash on Delivery: the limit applies to the discounted total, a refusal frees the use', async () => {
  const docs = [coupon({ type: 'fixed', value: 100 })];
  await withEnv({ COD_ENABLED: 'true', COD_MAX_AMOUNT: '150' }, async () => {
    // 200 is over 150, but 200 - 100 = 100 is not
    const log = {};
    await withStubs(store(log, docs), async () => {
      const ok = await request(app).post('/api/orders').send(orderBody({ paymentGateway: 'cod', couponCode: 'SAVE10' }));
      assert.equal(ok.status, 200);
      assert.equal(ok.body.amount, 100);
    });
    assert.equal(log.created[0].status, 'PLACED');
    assert.equal(log.created[0].discountAmount, 100);
    assert.equal(docs[0].usedCount, 1);

    // without a phone the COD check fails after the coupon was claimed: the use goes back
    const log2 = {};
    await withStubs(store(log2, docs), async () => {
      const res = await request(app).post('/api/orders').send(orderBody({ paymentGateway: 'cod', couponCode: 'SAVE10', customerPhone: '' }));
      assert.equal(res.status, 400);
    });
    assert.equal(docs[0].usedCount, 1);
  });
});

test('cancelling or expiring an unpaid order gives its coupon use back; orders without one do not', async () => {
  const order = { _id: 'o1', items: [], couponId: COUPON_ID };
  const log = {}; const docs = [coupon({ usedCount: 1 })];
  await withStubs([...fakeCoupons(docs, log), [Order, 'findOneAndUpdate', async () => order]], async () => {
    assert.equal(await cancelPendingOrder({ transactionId: 'T' }), order);
  });
  assert.equal(docs[0].usedCount, 0);

  const docs2 = [coupon({ usedCount: 1 })];
  const chain = { select() { return this; }, limit() { return this; }, lean: async () => [{ _id: 'a' }, { _id: 'b' }] };
  await withStubs([
    ...fakeCoupons(docs2), [Order, 'find', () => chain],
    [Order, 'findOneAndUpdate', async (f) => (f._id === 'a' ? order : { _id: 'b', items: [] })]   // b has no coupon
  ], async () => { assert.equal(await expirePendingOrders(), 2); });
  assert.equal(docs2[0].usedCount, 0);
  assert.equal(docs2.length, 1);

  const docs3 = [coupon({ usedCount: 0 })];
  await withStubs([...fakeCoupons(docs3), [Order, 'findOneAndUpdate', async () => ({ _id: 'x', items: [], couponId: COUPON_ID })]], async () => {
    await cancelPendingOrder({ transactionId: 'T' });
  });
  assert.equal(docs3[0].usedCount, 0, 'a use never goes below zero');
});

test('an admin cancelling an order gives the use back once; reopening takes it again', async () => {
  const o = await ownerLogin();
  const docs = [coupon({ usedCount: 1 })];
  const items = [{ productId: PRODUCT_ID, title: 'Bomber', quantity: 2 }];
  const set = (status) => o.agent.put(`/admin/orders/${ORDER_ID}/status`).set('X-CSRF-Token', o.csrf).send({ status });

  await withStubs([...fakeCoupons(docs), [Product, 'updateOne', async () => ({})],
    [Order, 'findById', async () => ({ ...MAILABLE, _id: ORDER_ID, status: 'PLACED', items })],
    [Order, 'findOneAndUpdate', async () => ({ ...MAILABLE, _id: ORDER_ID, status: 'CANCELLED', items, couponId: COUPON_ID })]
  ], async () => { assert.equal((await set('CANCELLED')).status, 200); });
  assert.equal(docs[0].usedCount, 0);

  const log = {};
  await withStubs([...fakeCoupons(docs, log), [Product, 'updateOne', async () => ({})],
    [Order, 'findById', async () => ({ ...MAILABLE, _id: ORDER_ID, status: 'SHIPPED', items })],
    [Order, 'findOneAndUpdate', (() => { let n = 0; return async () => (n++ === 0 ? null : { ...MAILABLE, _id: ORDER_ID, status: 'CANCELLED', items }); })()]
  ], async () => { assert.equal((await set('CANCELLED')).status, 200); });
  assert.equal(docs[0].usedCount, 0, 'cancelling a shipped order keeps the stock out and the use');

  await withStubs([...fakeCoupons(docs, log), [Product, 'findOneAndUpdate', async () => ({})],
    [Order, 'findById', async () => ({ ...MAILABLE, _id: ORDER_ID, status: 'CANCELLED', paymentGateway: 'cod', stockReleased: true, couponId: COUPON_ID, items })],
    [Order, 'findOneAndUpdate', async () => ({ ...MAILABLE, _id: ORDER_ID, status: 'PLACED', items })]
  ], async () => { assert.equal((await set('PLACED')).status, 200); });
  assert.equal(docs[0].usedCount, 1);
});

test('reopening is refused for lack of stock without touching the coupon, and a lost race gives both back', async () => {
  const o = await ownerLogin();
  const docs = [coupon({ usedCount: 0 })];
  const items = [{ productId: PRODUCT_ID, title: 'Bomber', quantity: 2 }];
  const cancelled = { ...MAILABLE, _id: ORDER_ID, status: 'CANCELLED', paymentGateway: 'cod', stockReleased: true, couponId: COUPON_ID, items };
  const set = (status) => o.agent.put(`/admin/orders/${ORDER_ID}/status`).set('X-CSRF-Token', o.csrf).send({ status });

  await withStubs([...fakeCoupons(docs), [Order, 'findById', async () => cancelled], [Product, 'findOneAndUpdate', async () => null]], async () => {
    assert.equal((await set('PLACED')).status, 409);
  });
  assert.equal(docs[0].usedCount, 0);

  await withStubs([...fakeCoupons(docs), [Order, 'findById', async () => cancelled], [Product, 'findOneAndUpdate', async () => ({})],
    [Product, 'updateOne', async () => ({})], [Order, 'findOneAndUpdate', async () => null]], async () => {
    assert.equal((await set('PLACED')).status, 409);
  });
  assert.equal(docs[0].usedCount, 0);
});

async function ownerLogin() {
  const agent = request.agent(app);
  const res = await agent.post('/admin/login').send(OWNER);
  assert.equal(res.status, 200);
  return { agent, csrf: res.body.csrfToken };
}
async function loginAs(username, password) {
  const agent = request.agent(app);
  const res = await agent.post('/admin/login').send({ username, password });
  assert.equal(res.status, 200);
  return { agent, csrf: res.body.csrfToken };
}
const api = (o, method, url, body) => o.agent[method](url).set('X-CSRF-Token', o.csrf).send(body || {});

test('the coupon permissions are in the catalog; Staff may only view coupons', () => {
  ['coupon.view', 'coupon.create', 'coupon.edit', 'coupon.delete'].forEach((p) => assert.ok(ALL_PERMISSIONS.includes(p), p));
  assert.ok(!ALL_PERMISSIONS.includes('coupon.details'));
  assert.deepEqual(DEFAULT_ROLES.Staff.permissions.filter((p) => p.startsWith('coupon')), ['coupon.view']);
  assert.deepEqual(DEFAULT_ROLES.Admin.permissions, ALL_PERMISSIONS);
});

test('an admin can create, list, edit, disable and delete coupons', async () => {
  resetData();
  const o = await ownerLogin();
  const docs = [];
  let nextId = 0;
  const saved = [];
  let stale = false;   // when true, findById shows the coupon as it was before a use landed
  await withStubs([
    quiet,
    [Coupon, 'create', async (d) => { if (docs.some((x) => x.code === d.code)) { const e = new Error('dup'); e.code = 11000; throw e; } const doc = { _id: '64b7f0c2a1b2c3d4e5f60c0' + (++nextId), createdAt: new Date(), ...d }; docs.push(doc); return doc; }],
    [Coupon, 'find', () => ({ sort: () => ({ limit: async () => docs.slice() }) })],
    [Coupon, 'findById', async (id) => { const d = docs.find((x) => x._id === id); return d ? { ...d, usedCount: stale ? 0 : d.usedCount } : null; }],
    [Coupon, 'findOneAndUpdate', async (f, u) => { saved.push([f, u]); const d = docs.find((x) => x._id === String(f._id)); if (!d || (f.usedCount && d.usedCount > f.usedCount.$lte)) return null; Object.assign(d, u.$set); return d; }],
    [Coupon, 'findByIdAndDelete', async (id) => { const i = docs.findIndex((d) => d._id === id); return i < 0 ? null : docs.splice(i, 1)[0]; }]
  ], async () => {
    const made = await api(o, 'post', '/admin/coupons', { code: ' welcome10 ', type: 'percent', value: 10, usageLimit: 5, usedCount: 4, _id: 'hack' });
    assert.equal(made.status, 201);
    assert.equal(made.body.code, 'WELCOME10');
    assert.equal(made.body.usedCount, 0, 'the used count can not be set from outside');
    assert.equal(made.body.status, 'active');
    const id = made.body._id;

    assert.equal((await api(o, 'post', '/admin/coupons', { code: 'welcome10', type: 'fixed', value: 5 })).status, 400);   // duplicate
    assert.equal((await api(o, 'post', '/admin/coupons', { code: 'BAD', type: 'percent', value: 500 })).status, 400);
    assert.equal((await o.agent.get('/admin/coupons')).body.length, 1);

    const edited = await api(o, 'put', `/admin/coupons/${id}`, { value: 15, maxDiscount: 200 });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.value, 15);
    assert.equal(edited.body.usageLimit, 5);                                      // untouched
    assert.equal((await api(o, 'put', `/admin/coupons/${id}`, { code: 'OTHER' })).status, 400);

    const off = await api(o, 'put', `/admin/coupons/${id}`, { active: false });
    assert.equal(off.body.status, 'disabled');
    assert.equal((await api(o, 'put', '/admin/coupons/not-an-id', { active: true })).status, 400);
    assert.equal((await api(o, 'put', '/admin/coupons/64b7f0c2a1b2c3d4e5f60cff', { active: true })).status, 404);

    // the limit is also checked inside the update, so a use that lands meanwhile wins
    docs[0].usedCount = 5;
    const raced = await api(o, 'put', `/admin/coupons/${id}`, { usageLimit: 5 });
    assert.equal(raced.status, 200);
    assert.deepEqual(saved[saved.length - 1][0].usedCount, { $lte: 5 });
    docs[0].usedCount = 6;   // a use arrived after the form was loaded
    stale = true;
    assert.equal((await api(o, 'put', `/admin/coupons/${id}`, { usageLimit: 5 })).status, 409);

    assert.equal((await api(o, 'delete', `/admin/coupons/${id}`)).status, 200);
    assert.equal((await api(o, 'delete', `/admin/coupons/${id}`)).status, 404);
    assert.equal((await api(o, 'delete', '/admin/coupons/xyz')).status, 400);
  });
});

test('coupon admin routes need login, a CSRF token and the right permission', async () => {
  resetData();
  assert.equal((await request(app).get('/admin/coupons')).status, 401);
  assert.equal((await request(app).post('/admin/coupons').send({})).status, 401);

  const o = await ownerLogin();
  assert.equal((await o.agent.post('/admin/coupons').send({ code: 'ABC', type: 'fixed', value: 5 })).status, 403);   // no CSRF token

  await Role.create({ name: 'CouponViewer', permissions: ['coupon.view'] });
  await Role.create({ name: 'CouponEditor', permissions: ['coupon.view', 'coupon.edit'] });
  await Role.create({ name: 'NoCoupons', permissions: ['order.view'] });
  await addAccount('cviewer', 'ViewerPass123', ['CouponViewer']);
  await addAccount('ceditor', 'EditorPass123', ['CouponEditor']);
  await addAccount('nocoupon', 'NoCouponPass1', ['NoCoupons']);
  const viewer = await loginAs('cviewer', 'ViewerPass123');
  const editor = await loginAs('ceditor', 'EditorPass123');
  const none = await loginAs('nocoupon', 'NoCouponPass1');
  const staff = await loginAs('helper', 'StaffPass123');   // built-in Staff: coupon.view

  let wrote = false;
  const noWrite = ['create', 'findOneAndUpdate', 'findByIdAndDelete'].map((m) => [Coupon, m, async () => { wrote = true; return null; }]);
  await withStubs([quiet, ...noWrite,
    [Coupon, 'find', () => ({ sort: () => ({ limit: async () => [] }) })],
    [Coupon, 'findById', async () => coupon()]
  ], async () => {
    assert.equal((await viewer.agent.get('/admin/coupons')).status, 200);
    assert.equal((await staff.agent.get('/admin/coupons')).status, 200);
    assert.equal((await none.agent.get('/admin/coupons')).status, 403);
    assert.equal((await api(viewer, 'post', '/admin/coupons', { code: 'ABC', type: 'fixed', value: 5 })).status, 403);
    assert.equal((await api(staff, 'post', '/admin/coupons', { code: 'ABC', type: 'fixed', value: 5 })).status, 403);
    assert.equal((await api(viewer, 'put', `/admin/coupons/${COUPON_ID}`, { active: false })).status, 403);
    assert.equal((await api(editor, 'delete', `/admin/coupons/${COUPON_ID}`)).status, 403);
    assert.equal((await api(editor, 'post', '/admin/coupons', { code: 'ABC', type: 'fixed', value: 5 })).status, 403);
  });
  assert.equal(wrote, false);

  // the editor's own permission lets the write through (the stub finds nothing to update)
  await withStubs([quiet, [Coupon, 'findById', async () => coupon()], [Coupon, 'findOneAndUpdate', async () => { wrote = true; return null; }]], async () => {
    assert.equal((await api(editor, 'put', `/admin/coupons/${COUPON_ID}`, { active: false })).status, 409);
  });
  assert.equal(wrote, true);
});

test('the permission matrix and a staff member\'s access include coupons', async () => {
  resetData();
  const o = await ownerLogin();
  const cat = await o.agent.get('/admin/permissions/catalog');
  assert.deepEqual(cat.body.resources.map((r) => r.key), ['product', 'order', 'coupon', 'audit', 'vendor']);
  assert.equal(cat.body.resources[2].actions.details, false);
  assert.equal((await api(o, 'put', '/admin/roles/Staff/permissions', { permissions: ['coupon.view', 'coupon.create'] })).status, 200);
  assert.equal((await api(o, 'put', '/admin/roles/Staff/permissions', { permissions: ['coupon.details'] })).status, 400);
  const staff = await loginAs('helper', 'StaffPass123');
  const status = await staff.agent.get('/admin/auth/status');
  assert.deepEqual(status.body.permissions.sort(), ['coupon.create', 'coupon.view']);
});

process.env.EMAIL_HOST = 'smtp.test';
process.env.EMAIL_USER = 'shop@test.example';
process.env.EMAIL_PASS = 'secret';
async function captureMail(order) {
  const sent = [];
  delete require.cache[require.resolve('../services/emailService')];
  await withStubs([[nodemailer, 'createTransport', () => ({ sendMail: async (m) => { sent.push(m); } })]], async () => {
    await require('../services/emailService').sendOrderConfirmation(order);
  });
  return sent[0];
}
const mailOrder = (extra) => ({ _id: 'o1', customerName: 'Eve', customerEmail: 'a@b.com', status: 'CONFIRMED', totalAmount: 180, createdAt: new Date(), items: [{ title: 'Bomber', quantity: 2, price: 100 }], ...extra });

test('the confirmation email shows the subtotal, the discount and the charged total, and escapes the code', async () => {
  const mail = await captureMail(mailOrder({ discountAmount: 20, couponCode: '<img src=x>' }));
  assert.match(mail.html, /Subtotal:[\s\S]*200\.00/);
  assert.match(mail.html, /-20\.00/);
  assert.match(mail.html, /180\.00/);
  assert.ok(!mail.html.includes('<img src=x>') && mail.html.includes('&lt;img src=x&gt;'));
  assert.ok(!/Subtotal:/.test((await captureMail(mailOrder({}))).html));
});

const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

test('the cart has a coupon box and the admin has a coupons page, hidden without permission', () => {
  const index = pub('index.html');
  ['couponInput', 'applyCouponBtn', 'removeCouponBtn', 'cartSummary'].forEach((id) => assert.ok(index.includes(`id="${id}"`), id));
  const app_js = pub('js/app.js');
  assert.match(app_js, /\/api\/coupons\/validate/);
  assert.match(app_js, /const couponCode\s*=\s*appliedCoupon \? appliedCoupon\.code : undefined/);   // only the code is sent
  assert.ok(!/discount:\s*[a-z]/i.test(app_js.slice(app_js.indexOf('function placeOrder'), app_js.indexOf('function placeOrder') + 1200)));
  const admin = pub('admin.html');
  assert.match(admin, /body:not\(\.can-coupon-create\) #newCouponBtn/);
  assert.match(admin, /body:not\(\.can-coupon-delete\) \.coupon-delete-btn/);
  assert.match(admin, /admin-coupons\.js/);
  assert.match(pub('js/admin.js'), /can\('coupon\.view'\)/);
});

// Keep this last: it uses up the cart box rate limit.

test('the cart coupon box is rate limited', async () => {
  let limited = false;
  await withStubs([quiet, priceStub(100), ...fakeCoupons([])], async () => {
    for (let i = 0; i < 40 && !limited; i++) {
      const res = await validate({ code: 'GUESS' + i, items: cart() });
      if (res.status === 429) { limited = true; assert.match(res.body.message, /Too many coupon attempts/); }
    }
  });
  assert.ok(limited, 'expected a 429 after repeated attempts');
});

test('with no minimum order total a coupon still never makes an order free', () => {
  delete process.env.MIN_ORDER_TOTAL;
  assert.equal(rules.computeDiscount(coupon({ type: 'fixed', value: 5000 }), 100), 99.99);
  assert.equal(rules.computeDiscount(coupon({ type: 'percent', value: 100 }), 100), 99.99);
});
