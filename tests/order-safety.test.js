// Tests for: stock following admin cancel/reopen, payments that arrive after an
// order was cancelled, safe rollback when the payment gateway fails, and
// unguessable transaction IDs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const SSLCommerzPayment = require('sslcommerz-lts');
const { app, OWNER } = require('./helpers');
const Order = require('../models/Order');
const Product = require('../models/Product');
const apiRouter = require('../routes/api');
const {
  PENDING_ORDER_TTL_MINUTES, PENDING_ORDER_GRACE_MINUTES,
  reserveItems, expirePendingOrders
} = require('../services/orderService');

const ORDER_ID = '64b7f0c2a1b2c3d4e5f60718';
const PRODUCT_ID = '64b7f0c2a1b2c3d4e5f60999';

// Replaces methods for the duration of one test and puts them back afterwards.
async function withStubs(stubs, fn) {
  const saved = stubs.map(([target, name]) => [target, name, target[name]]);
  stubs.forEach(([target, name, impl]) => { target[name] = impl; });
  try { await fn(); } finally { saved.forEach(([target, name, original]) => { target[name] = original; }); }
}
const quiet = [console, 'error', () => {}];

async function ownerLogin() {
  const agent = request.agent(app);
  const res = await agent.post('/admin/login').send(OWNER);
  assert.equal(res.status, 200);
  return { agent, csrf: res.body.csrfToken };
}
const setStatus = (o, status) => o.agent.put(`/admin/orders/${ORDER_ID}/status`).set('X-CSRF-Token', o.csrf).send({ status });

test('cancelling an unpaid order in the admin panel returns its stock, once', async () => {
  const o = await ownerLogin();
  const restocked = [];
  let filter, update;
  const items = [{ productId: 'p1', quantity: 3, size: 'M' }, { productId: 'p2', quantity: 1, size: 'M' }];
  await withStubs([
    [Order, 'findById', async () => ({ _id: ORDER_ID, status: 'PENDING', items })],
    [Order, 'findOneAndUpdate', async (f, u) => { filter = f; update = u; return { _id: ORDER_ID, status: 'CANCELLED', items }; }],
    [Product, 'updateOne', async (f, u) => { restocked.push([f._id, u.$inc.stock]); return {}; }]
  ], async () => {
    const res = await setStatus(o, 'CANCELLED');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'CANCELLED');
  });
  assert.ok(filter.status.$in.includes('PENDING') && filter.status.$in.includes('CONFIRMED'));
  assert.deepEqual(filter.stockReleased, { $ne: true });   // a second cancel cannot restock again
  assert.equal(update.stockReleased, true);
  assert.deepEqual(restocked, [['p1', 3], ['p2', 1]]);
});

test('cancelling a shipped order does not touch stock', async () => {
  const o = await ownerLogin();
  let restocked = 0;
  let plainUpdate = null;
  await withStubs([
    [Order, 'findById', async () => ({ _id: ORDER_ID, status: 'SHIPPED', items: [{ productId: 'p1', quantity: 1, size: 'M' }] })],
    [Order, 'findOneAndUpdate', (() => { let n = 0; return async (f, u) => { if (n++ === 0) return null; plainUpdate = u; return { _id: ORDER_ID, status: u.status, items: [] }; }; })()],
    [Product, 'updateOne', async () => { restocked++; return {}; }]
  ], async () => {
    const res = await setStatus(o, 'CANCELLED');
    assert.equal(res.status, 200);
  });
  assert.equal(restocked, 0);
  assert.equal(plainUpdate.status, 'CANCELLED');
});

test('reopening a cancelled order takes its stock again', async () => {
  const o = await ownerLogin();
  const taken = [];
  let filter, update;
  await withStubs([
    [Order, 'findById', async () => ({ _id: ORDER_ID, status: 'CANCELLED', paymentGateway: 'cod', stockReleased: true, items: [{ productId: PRODUCT_ID, title: 'Bomber', quantity: 2 }] })],
    [Product, 'findOneAndUpdate', async (f, u) => { taken.push([f.stock, u.$inc.stock]); return {}; }],
    [Order, 'findOneAndUpdate', async (f, u) => { filter = f; update = u; return { _id: ORDER_ID, status: 'CONFIRMED', items: [] }; }]
  ], async () => {
    const res = await setStatus(o, 'CONFIRMED');
    assert.equal(res.status, 200);
  });
  assert.deepEqual(taken, [[{ $gte: 2 }, -2]]);
  assert.equal(filter.status, 'CANCELLED');
  assert.equal(update.stockReleased, false);
  assert.deepEqual(update.$unset, { paymentIssue: 1 });   // the "paid after cancellation" flag is cleared
});

test('reopening is refused when there is not enough stock, and nothing changes', async () => {
  const o = await ownerLogin();
  let orderUpdated = false;
  await withStubs([
    [Order, 'findById', async () => ({ _id: ORDER_ID, status: 'CANCELLED', paymentGateway: 'cod', stockReleased: true, items: [{ productId: PRODUCT_ID, title: 'Bomber', quantity: 2 }] })],
    [Product, 'findOneAndUpdate', async () => null],
    [Order, 'findOneAndUpdate', async () => { orderUpdated = true; return {}; }]
  ], async () => {
    const res = await setStatus(o, 'CONFIRMED');
    assert.equal(res.status, 409);
    assert.match(res.body.message, /not enough stock for "Bomber"/);
  });
  assert.equal(orderUpdated, false);
});

test('reopening an order whose stock was never returned does not take stock twice', async () => {
  const o = await ownerLogin();
  let reserved = 0;
  let filter;
  await withStubs([
    [Order, 'findById', async () => ({ _id: ORDER_ID, status: 'CANCELLED', paymentGateway: 'cod', items: [{ productId: PRODUCT_ID, title: 'Bomber', quantity: 2 }] })],   // e.g. an order cancelled before this fix
    [Product, 'findOneAndUpdate', async () => { reserved++; return {}; }],
    [Order, 'findOneAndUpdate', async (f) => { filter = f; return { _id: ORDER_ID, status: 'PLACED', items: [] }; }]
  ], async () => {
    assert.equal((await setStatus(o, 'PLACED')).status, 200);
  });
  assert.equal(reserved, 0);
  assert.deepEqual(filter.stockReleased, { $ne: true });
});

test('reserveItems puts back what it took when a later line runs short', async () => {
  const restocked = [];
  let call = 0;
  await withStubs([
    [Product, 'findOneAndUpdate', async () => (++call === 1 ? {} : null)],
    [Product, 'updateOne', async (f, u) => { restocked.push([f._id, u.$inc.stock]); return {}; }]
  ], async () => {
    const result = await reserveItems([
      { productId: 'a', title: 'A', quantity: 2 },
      { productId: 'b', title: 'B', quantity: 1 }
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.title, 'B');
    assert.equal(result.line.productId, 'b');   // the failing line, so the message can name its size
  });
  assert.deepEqual(restocked, [['a', 2]]);
});

test('the expiry job waits the TTL plus a grace period before cancelling', async () => {
  let cutoff = null;
  const chain = { select() { return this; }, limit() { return this; }, lean: async () => [] };
  await withStubs([[Order, 'find', (f) => { cutoff = f.createdAt.$lt; return chain; }]], async () => {
    await expirePendingOrders();
  });
  const minutesAgo = (Date.now() - cutoff.getTime()) / 60000;
  assert.ok(PENDING_ORDER_GRACE_MINUTES >= 10);
  assert.ok(Math.abs(minutesAgo - (PENDING_ORDER_TTL_MINUTES + PENDING_ORDER_GRACE_MINUTES)) < 0.5);
  // A Stripe session lives TTL + 2 minutes, so it is always over before the order is cancelled
  assert.ok(PENDING_ORDER_GRACE_MINUTES > 2);
});

const cancelledOrder = { _id: 'o1', status: 'CANCELLED', totalAmount: 1000, transactionId: 'TXN-1', customerEmail: 'a@b.com' };
const validPayment = async () => ({ status: 'VALID', tran_id: 'TXN-1', amount: '1000.00', currency_type: 'XXX' });
const payNow = () => request(app).post('/api/payment/success').type('form').send({ tran_id: 'TXN-1', val_id: 'v1' });

test('a verified payment for a cancelled order is flagged for the owner, not shown as success', async () => {
  let flagged = null;
  await withStubs([
    quiet,
    [Order, 'findOne', async () => cancelledOrder],
    [SSLCommerzPayment.prototype, 'validate', validPayment],
    [Order, 'findOneAndUpdate', async () => null],
    [Order, 'updateOne', async (f, u) => { if (!flagged) flagged = [f, u]; return { modifiedCount: 1 }; }]
  ], async () => {
    const res = await payNow();
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /payment-fail\.html\?reason=paid_late&tran_id=TXN-1/);
  });
  assert.equal(flagged[0].status, 'CANCELLED');
  assert.equal(flagged[1].$set.paymentIssue, 'PAID_AFTER_CANCEL');
  assert.equal(flagged[1].$set.valId, 'v1');
});

test('an unverified "payment" for a cancelled order is never flagged', async () => {
  let flagged = false;
  await withStubs([
    [Order, 'findOne', async () => cancelledOrder],
    [SSLCommerzPayment.prototype, 'validate', async () => ({ status: 'INVALID_TRANSACTION' })],
    [Order, 'updateOne', async () => { flagged = true; return { modifiedCount: 1 }; }]
  ], async () => {
    const res = await payNow();
    assert.match(res.headers.location, /reason=cancelled/);
  });
  assert.equal(flagged, false);
});

test('a payment that loses a race with the expiry job is caught as a late payment', async () => {
  let reads = 0;
  let flagged = false;
  await withStubs([
    quiet,
    // first read: still PENDING; after the confirm attempt fails the order has been cancelled
    [Order, 'findOne', async () => (++reads === 1 ? { ...cancelledOrder, status: 'PENDING' } : cancelledOrder)],
    [SSLCommerzPayment.prototype, 'validate', validPayment],
    [Order, 'findOneAndUpdate', async () => null],
    [Order, 'updateOne', async () => { flagged = true; return { modifiedCount: 1 }; }]
  ], async () => {
    const res = await payNow();
    assert.match(res.headers.location, /reason=paid_late/);
  });
  assert.equal(flagged, true);
});

test('the IPN for a late payment is acknowledged so the gateway stops retrying', async () => {
  await withStubs([
    quiet,
    [Order, 'findOne', async () => cancelledOrder],
    [SSLCommerzPayment.prototype, 'validate', validPayment],
    [Order, 'findOneAndUpdate', async () => null],
    [Order, 'updateOne', async () => ({})]
  ], async () => {
    const res = await request(app).post('/api/payment/ipn').send({ tran_id: 'TXN-1', val_id: 'v1' });
    assert.equal(res.status, 200);
    assert.equal(res.text, 'IPN received');
  });
});

test('a repeat callback for an already confirmed order does not call the gateway again', async () => {
  let validated = false;
  await withStubs([
    [Order, 'findOne', async () => ({ ...cancelledOrder, status: 'CONFIRMED' })],
    [SSLCommerzPayment.prototype, 'validate', async () => { validated = true; return {}; }]
  ], async () => {
    const res = await payNow();
    assert.match(res.headers.location, /payment-success\.html\?tran_id=TXN-1&already=true/);
  });
  assert.equal(validated, false);
});

test('settlePaidOrder reports confirmed, late, already and missing orders', async () => {
  const req = { app: { get: () => null } };
  const { settlePaidOrder } = apiRouter;
  await withStubs([quiet, [Order, 'updateOne', async () => ({})]], async () => {
    await withStubs([[Order, 'findOneAndUpdate', async () => ({ _id: 'x', items: [] })]], async () => {
      assert.equal((await settlePaidOrder({ transactionId: 'T' }, 'v', req)).result, 'confirmed');
    });
    await withStubs([[Order, 'findOneAndUpdate', async () => null], [Order, 'findOne', async () => cancelledOrder]], async () => {
      assert.equal((await settlePaidOrder({ transactionId: 'T' }, 'v', req)).result, 'late');
    });
    await withStubs([[Order, 'findOneAndUpdate', async () => null], [Order, 'findOne', async () => ({ status: 'SHIPPED' })]], async () => {
      assert.equal((await settlePaidOrder({ transactionId: 'T' }, 'v', req)).result, 'already');
    });
    await withStubs([[Order, 'findOneAndUpdate', async () => null], [Order, 'findOne', async () => null]], async () => {
      assert.equal((await settlePaidOrder({ transactionId: 'T' }, 'v', req)).result, 'missing');
    });
  });
});

const checkoutBody = { customerName: 'Buyer', customerEmail: 'buyer@example.com', customerPhone: '01700000000', deliveryAddress: { address: '1 Main St', city: 'Dhaka', postcode: '1200', country: 'Bangladesh' }, items: [{ productId: PRODUCT_ID, quantity: 2, size: 'M' }] };

test('when the payment gateway fails, stock goes back exactly once even if deleting the order fails', async () => {
  let created = null;
  let restocks = 0;
  let cancels = 0;
  const line = { productId: PRODUCT_ID, title: 'Bomber', price: 100, quantity: 2, size: null };
  await withStubs([
    quiet,
    [Product, 'findById', async () => ({ _id: PRODUCT_ID, title: 'Bomber', price: 100, stock: 5 })],
    [Product, 'findOneAndUpdate', async () => ({})],
    [Order, 'create', async (doc) => { created = doc; return { _id: 'o1', items: [line] }; }],
    [SSLCommerzPayment.prototype, 'init', async () => ({ status: 'FAILED' })],
    [Order, 'findOneAndUpdate', async () => { cancels++; return { _id: 'o1', items: [line] }; }],
    [Product, 'updateOne', async () => { restocks++; return {}; }],
    [Order, 'findByIdAndDelete', async () => { throw new Error('db down'); }]
  ], async () => {
    const res = await request(app).post('/api/orders').send(checkoutBody);
    assert.equal(res.status, 502);
  });
  assert.equal(cancels, 1);
  assert.equal(restocks, 1, 'one restock for the one reserved line');
  assert.equal(created.status, 'PENDING');
  assert.equal(created.userId, null);   // guest checkout
});

test('if creating the order fails after stock was reserved, the reservation is released once', async () => {
  let restocks = 0;
  await withStubs([
    quiet,
    [Product, 'findById', async () => ({ _id: PRODUCT_ID, title: 'Bomber', price: 100, stock: 5 })],
    [Product, 'findOneAndUpdate', async () => ({})],
    [Order, 'create', async () => { throw new Error('db down'); }],
    [Product, 'updateOne', async () => { restocks++; return {}; }]
  ], async () => {
    const res = await request(app).post('/api/orders').send(checkoutBody);
    assert.equal(res.status, 500);
  });
  assert.equal(restocks, 1);
});

test('transaction IDs are unique, fit the gateway limit and are not built from Math.random', async () => {
  const ids = [];
  await withStubs([
    quiet,
    [Product, 'findById', async () => ({ _id: PRODUCT_ID, title: 'Bomber', price: 100, stock: 5 })],
    [Product, 'findOneAndUpdate', async () => ({})],
    [Order, 'create', async (doc) => { ids.push(doc.transactionId); throw new Error('stop here'); }],
    [Product, 'updateOne', async () => ({})],
    [Math, 'random', () => { throw new Error('Math.random must not be used for transaction IDs'); }]
  ], async () => {
    for (let i = 0; i < 3; i++) await request(app).post('/api/orders').send(checkoutBody);
  });
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3);
  ids.forEach((id) => { assert.match(id, /^TXN-[0-9A-Z]{24}$/); assert.ok(id.length <= 30); });   // SSLCommerz refuses a longer tran_id
});

test('an order placed while logged in is linked to that customer', async () => {
  const User = require('../models/User');
  let created = null;
  await withStubs([
    quiet,
    [User, 'findOne', async () => null],
    [User, 'create', async (d) => ({ _id: '64b7f0c2a1b2c3d4e5f60aaa', name: d.name, email: d.email })],
    [Product, 'findById', async () => ({ _id: PRODUCT_ID, title: 'Bomber', price: 100, stock: 5 })],
    [Product, 'findOneAndUpdate', async () => ({})],
    [Order, 'create', async (doc) => { created = doc; throw new Error('stop here'); }],
    [Product, 'updateOne', async () => ({})]
  ], async () => {
    const agent = request.agent(app);
    await agent.post('/api/users/register').send({ name: 'Logged In', email: 'li@example.com', password: 'LongEnough123' });
    await agent.post('/api/orders').send(checkoutBody);
  });
  assert.equal(String(created.userId), '64b7f0c2a1b2c3d4e5f60aaa');
});
