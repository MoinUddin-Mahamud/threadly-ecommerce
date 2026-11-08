const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const SSLCommerzPayment = require('sslcommerz-lts');
const { app } = require('./helpers');
const Order = require('../models/Order');
const Product = require('../models/Product');
const { cancelPendingOrder, expirePendingOrders } = require('../services/orderService');

const PRODUCT_ID = '64b7f0c2a1b2c3d4e5f60718';
// Online payment is the default method, and it needs a phone and a full delivery address.
const customer = { customerName: 'Test Buyer', customerEmail: 'buyer@example.com', customerPhone: '01700000000', deliveryAddress: { address: '1 Main St', city: 'Dhaka', postcode: '1200', country: 'Bangladesh' } };

// Replaces model methods for the duration of one test and puts them back afterwards.
async function withStubs(stubs, fn) {
  const saved = stubs.map(([target, name]) => [target, name, target[name]]);
  stubs.forEach(([target, name, impl]) => { target[name] = impl; });
  try { await fn(); } finally { saved.forEach(([target, name, original]) => { target[name] = original; }); }
}

test('order creation rejects quantities that are not whole numbers', async () => {
  for (const quantity of [1.5, '2', 0, -1, null]) {
    const res = await request(app).post('/api/orders')
      .send({ ...customer, items: [{ productId: PRODUCT_ID, quantity, size: 'M' }] });
    assert.equal(res.status, 400, `quantity ${JSON.stringify(quantity)} should be rejected`);
  }
});

test('order creation rejects a malformed product id', async () => {
  const res = await request(app).post('/api/orders')
    .send({ ...customer, items: [{ productId: 'not-an-id', quantity: 1, size: 'M' }] });
  assert.equal(res.status, 400);
});

test('order creation does not oversell when the stock update loses a race', async () => {
  let orderCreated = false;
  await withStubs([
    [Product, 'findById', async () => ({ _id: PRODUCT_ID, title: 'Bomber', price: 100, stock: 1 })],
    [Product, 'findOneAndUpdate', async () => null],
    [Order, 'create', async () => { orderCreated = true; return {}; }]
  ], async () => {
    const res = await request(app).post('/api/orders')
      .send({ ...customer, items: [{ productId: PRODUCT_ID, quantity: 1, size: 'M' }] });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /not enough stock/i);
  });
  assert.equal(orderCreated, false);
});

test('a forged IPN cannot confirm an order', async () => {
  let confirmed = false;
  const pending = { _id: 'o1', status: 'PENDING', totalAmount: 500, items: [] };
  await withStubs([
    [Order, 'findOne', async () => pending],
    [Order, 'findOneAndUpdate', async () => { confirmed = true; return pending; }],
    [SSLCommerzPayment.prototype, 'validate', async () => ({ status: 'INVALID_TRANSACTION' })]
  ], async () => {
    const res = await request(app).post('/api/payment/ipn')
      .send({ tran_id: 'TXN-1', val_id: 'fake', status: 'VALID' });
    assert.equal(res.status, 200);
  });
  assert.equal(confirmed, false);
});

test('a verified payment is confirmed without waiting for the mail server', async () => {
  const emailService = require('../services/emailService');
  const pending = { _id: 'o1', status: 'PENDING', totalAmount: 500, items: [], transactionId: 'TXN-1' };
  let mailStarted = false;
  await withStubs([
    [Order, 'findOne', async () => pending],
    [Order, 'findOneAndUpdate', async () => ({ ...pending, status: 'CONFIRMED' })],
    [SSLCommerzPayment.prototype, 'validate', async () => ({ status: 'VALID', tran_id: 'TXN-1', amount: '500.00', currency_type: 'XXX' })],
    [emailService, 'sendOrderConfirmation', () => { mailStarted = true; return new Promise(() => {}); }]   // a mail server that never answers
  ], async () => {
    const reply = request(app).post('/api/payment/ipn').send({ tran_id: 'TXN-1', val_id: 'v1' }).then((res) => res.status);
    const status = await Promise.race([reply, new Promise((resolve) => setTimeout(() => resolve('timed out'), 3000))]);
    assert.equal(status, 200);
  });
  assert.equal(mailStarted, true, 'the confirmation email should still be started');
});

test('payment callbacks treat tran_id as plain text, not a query object', async () => {
  let filter = null;
  await withStubs([
    [Order, 'findOne', async (f) => { filter = f; return null; }]
  ], async () => {
    const res = await request(app).post('/api/payment/fail').send({ tran_id: { $ne: null } });
    assert.equal(res.status, 302);
  });
  assert.equal(typeof filter.transactionId, 'string');
});

test('cancelling a pending order restocks it once, and only if it was still pending', async () => {
  const restocked = [];
  const order = { items: [{ productId: 'p1', quantity: 2, size: 'M' }, { productId: 'p2', quantity: 1, size: 'M' }] };
  let filter = null;
  await withStubs([
    [Order, 'findOneAndUpdate', async (f) => { filter = f; return order; }],
    [Product, 'updateOne', async (f, u) => { restocked.push([f._id, u.$inc.stock]); return {}; }]
  ], async () => {
    assert.equal(await cancelPendingOrder({ transactionId: 'TXN-1' }), order);
  });
  assert.equal(filter.status, 'PENDING');
  assert.deepEqual(restocked, [['p1', 2], ['p2', 1]]);

  restocked.length = 0;
  await withStubs([
    [Order, 'findOneAndUpdate', async () => null],
    [Product, 'updateOne', async (f, u) => { restocked.push(u); return {}; }]
  ], async () => {
    assert.equal(await cancelPendingOrder({ transactionId: 'TXN-1' }), null);
  });
  assert.equal(restocked.length, 0);
});

test('expiry job cancels stale pending orders', async () => {
  let cutoff = null;
  const chain = (rows) => ({ select() { return this; }, limit() { return this; }, lean: async () => rows });
  await withStubs([
    [Order, 'find', (f) => { cutoff = f.createdAt.$lt; return chain([{ _id: 'a' }, { _id: 'b' }]); }],
    [Order, 'findOneAndUpdate', async (f) => (f._id === 'a' ? { items: [] } : null)]
  ], async () => {
    assert.equal(await expirePendingOrders(), 1);
  });
  assert.ok(cutoff instanceof Date && cutoff < new Date());
});
