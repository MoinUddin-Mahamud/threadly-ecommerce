// Late-payment replays, asking the gateway before cancelling, payable earnings, minimum order total.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const SSLCommerzPayment = require('sslcommerz-lts');
const { app, OWNER } = require('./helpers');
const Order = require('../models/Order');
const Product = require('../models/Product');
const marketplace = require('../services/marketplace');
const { minPayableMinor } = require('../services/money');
const apiRouter = require('../routes/api');

async function withStubs(stubs, fn) {
  const saved = stubs.map(([target, name]) => [target, name, target[name]]);
  stubs.forEach(([target, name, impl]) => { target[name] = impl; });
  try { await fn(); } finally { saved.forEach(([target, name, original]) => { target[name] = original; }); }
}
const quiet = [console, 'error', () => {}];
const req = { app: { get: () => null } };

// A payment callback that is replayed must not flag an order a second time
test('a late payment is recorded once: a replay (retry or reload) changes nothing', async () => {
  const calls = [];
  const order = { _id: 'o1', status: 'CANCELLED', transactionId: 'TXN-1', customerEmail: 'a@b.co', totalAmount: 100 };
  let modified = 1;
  await withStubs([quiet, [Order, 'updateOne', async (f, u) => { calls.push([f, u]); return { modifiedCount: calls.length === 1 ? modified : 0 }; }]], async () => {
    await apiRouter.recordLatePayment(order, 'VAL1', req);
    assert.equal(calls[0][0].paymentIssue, null, 'only an order with no issue yet can be flagged');
    assert.equal(calls[0][0].refundedAt, null, 'an order that was already refunded is never re-flagged');
    assert.equal(calls[0][1].$set.paymentIssue, 'PAID_AFTER_CANCEL');
    assert.equal(calls.length, 2, 'first time: flag, then record the payment date');
    calls.length = 0; modified = 0;
    await apiRouter.recordLatePayment(order, 'VAL1', req);
    assert.equal(calls.length, 1, 'replay: the flag update matched nothing, so nothing else is written');
  });
});

test('a refund can be recorded only once', async () => {
  const agent = request.agent(app);
  const login = await agent.post('/admin/login').send(OWNER);
  const filters = [];
  await withStubs([
    quiet,
    [Order, 'findOne', async (f) => { filters.push(f); return null; }]
  ], async () => {
    const res = await agent.put('/admin/orders/64b7f0c2a1b2c3d4e5f60718/mark-refunded').set('X-CSRF-Token', login.body.csrfToken).send({});
    assert.equal(res.status, 409);
  });
  assert.equal(filters[0].refundedAt, null, 'an order with refundedAt set is not awaiting a refund');
});

// Cancel and fail callbacks come from the browser, so the gateway is asked first.
const pendingSsl = { _id: 'o1', status: 'PENDING', paymentGateway: 'sslcommerz', transactionId: 'TXN-1', customerEmail: 'a@b.co', totalAmount: 100, items: [] };
const hitFail = () => request(app).post('/api/payment/fail').type('form').send({ tran_id: 'TXN-1' });

test('a "fail" callback does not cancel an order the gateway says was paid', async () => {
  let cancelled = 0;
  await withStubs([
    quiet,
    [Order, 'findOne', async () => pendingSsl],
    [Order, 'findOneAndUpdate', async () => { cancelled++; return null; }],
    [SSLCommerzPayment.prototype, 'transactionQueryByTransactionId', async () => ({ APIConnect: 'DONE', element: [{ status: 'VALID', val_id: 'v1' }] })],
    [SSLCommerzPayment.prototype, 'validate', async () => ({ status: 'INVALID_TRANSACTION' })]
  ], async () => {
    const res = await hitFail();
    assert.equal(res.status, 302);
  });
  assert.equal(cancelled, 0, 'a payment was found at the gateway: the order is not cancelled');
});

test('a "fail" callback leaves the order alone when the gateway cannot be asked', async () => {
  let cancelled = 0;
  await withStubs([
    quiet,
    [Order, 'findOne', async () => pendingSsl],
    [Order, 'findOneAndUpdate', async () => { cancelled++; return null; }],
    [SSLCommerzPayment.prototype, 'transactionQueryByTransactionId', async () => { throw new Error('network down'); }]
  ], async () => { await hitFail(); });
  assert.equal(cancelled, 0);
});

test('a "fail" callback cancels (and restocks) only when the gateway confirms nothing was paid', async () => {
  let cancelled = 0;
  await withStubs([
    quiet,
    [Order, 'findOne', async () => pendingSsl],
    [Order, 'findOneAndUpdate', async () => { cancelled++; return { ...pendingSsl, status: 'CANCELLED' }; }],
    [Product, 'updateOne', async () => ({})],
    [SSLCommerzPayment.prototype, 'transactionQueryByTransactionId', async () => ({ APIConnect: 'DONE', no_of_trans_found: 0, element: [] })]
  ], async () => { await hitFail(); });
  assert.equal(cancelled, 1);
});

test('with no payout hold, a delivered order is payable even without a timestamp', () => {
  const order = { status: 'DELIVERED', fulfillment: [] };
  assert.equal(marketplace.isPayableNow(order, 'v1', Date.now(), { PAYOUT_HOLD_DAYS: '0' }), true);
  assert.equal(marketplace.isPayableNow({ status: 'CONFIRMED', fulfillment: [] }, 'v1', Date.now(), { PAYOUT_HOLD_DAYS: '0' }), false);
  // With a hold a delivery time is needed to count the days.
  assert.equal(marketplace.isPayableNow(order, 'v1', Date.now(), { PAYOUT_HOLD_DAYS: '3' }), false);
  const recent = { ...order, updatedAt: new Date() };
  assert.equal(marketplace.isPayableNow(recent, 'v1', Date.now(), { PAYOUT_HOLD_DAYS: '3' }), false);
  const old = { ...order, updatedAt: new Date(Date.now() - 4 * 86400000) };
  assert.equal(marketplace.isPayableNow(old, 'v1', Date.now(), { PAYOUT_HOLD_DAYS: '3' }), true);
});

test('one payout record holds a bounded number of orders', () => {
  assert.ok(marketplace.MAX_PAYOUT_ORDERS > 0 && marketplace.MAX_PAYOUT_ORDERS <= 5000);
});

test('there is no minimum order total by default, MIN_ORDER_TOTAL changes it, and a zero total is always refused', () => {
  const { minOrderMinor } = require('../services/money');
  assert.equal(minPayableMinor({}), 0);
  assert.equal(minPayableMinor({ MIN_ORDER_TOTAL: '25.5' }), 2550);
  assert.equal(minPayableMinor({ MIN_ORDER_TOTAL: 'abc' }), 0);
  assert.equal(minPayableMinor({ MIN_ORDER_TOTAL: '0' }), 0);
  assert.equal(minOrderMinor({}), 1);
  assert.equal(minOrderMinor({ MIN_ORDER_TOTAL: '25.5' }), 2550);
});

test('a very small Cash on Delivery order is refused too, not only online payments', async () => {
  const saved = process.env.COD_ENABLED;
  process.env.COD_ENABLED = 'true';
  try {
    await withStubs([
      quiet,
      [Product, 'findById', async () => ({ _id: '64b7f0c2a1b2c3d4e5f60718', title: 'Tiny', price: 0.5, stock: 5 })],
      [Order, 'create', async () => { throw new Error('must not be created'); }]
    ], async () => {
      const res = await request(app).post('/api/orders').send({
        customerName: 'B', customerEmail: 'b@example.com', customerPhone: '01700000000',
        deliveryAddress: { address: '1 Main St', city: 'X', postcode: '1', country: 'Y' }, paymentGateway: 'cod',
        items: [{ productId: '64b7f0c2a1b2c3d4e5f60718', quantity: 1, size: 'M' }]
      });
      assert.equal(res.status, 400);
      assert.match(res.body.message, /at least/);
    });
  } finally { if (saved === undefined) delete process.env.COD_ENABLED; else process.env.COD_ENABLED = saved; }
});

test('no currency sign, code or word appears in the shipped pages, scripts, services, models or seed', () => {
  const ROOT = path.join(__dirname, '..');
  const dirs = ['public', 'routes', 'services', 'models', 'seed', 'config', 'scripts', 'server.js', '.env.example', 'README.md'];
  const files = [];
  const walk = (p) => {
    const full = path.join(ROOT, p);
    if (!fs.existsSync(full)) return;
    if (fs.statSync(full).isDirectory()) fs.readdirSync(full).forEach((f) => walk(path.join(p, f)));
    else if (/\.(js|html|css|md|svg|example)$/.test(full) || full.endsWith('.env.example')) files.push(p);
  };
  dirs.forEach(walk);
  assert.ok(files.length > 30);
  const codes = [['B','D','T'], ['U','S','D'], ['E','U','R'], ['G','B','P']].map((c) => `\\b${c.join('')}\\b`).join('|');
  const bad = new RegExp(`${codes}|\u09F3|\u09F3|\\b${['ta','ka'].join('')}\\b|\\bdollars?\\b|\u20AC|\u00A3|\\bTk\\.?\\s?\\d|\\$\\s?\\d`, 'i');
  const hits = [];
  for (const f of files) {
    fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
      // "$1" in a regex replacement and "$2b$" in password hashes are not money.
      if (bad.test(line.replace(/\$[0-9]\b/g, '').replace(/\$2[aby]\$/g, ''))) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(hits, []);
});
