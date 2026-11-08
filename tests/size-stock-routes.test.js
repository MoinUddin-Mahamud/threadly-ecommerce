// Stock per size through the real routes: checkout, and the admin product create / edit.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, OWNER } = require('./helpers');
const Product = require('../models/Product');
const Order = require('../models/Order');
const emailService = require('../services/emailService');

const PID = '64b7f0c2a1b2c3d4e5f60999';
const OID = '64b7f0c2a1b2c3d4e5f60718';
const quiet = [console, 'error', () => {}];
async function withStubs(stubs, fn) {
  const saved = stubs.map(([t, n]) => [t, n, t[n]]);
  stubs.forEach(([t, n, impl]) => { t[n] = impl; });
  try { await fn(); } finally { saved.forEach(([t, n, o]) => { t[n] = o; }); }
}
async function withEnv(vars, fn) {
  const saved = Object.keys(vars).map((k) => [k, process.env[k]]);
  Object.entries(vars).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  try { await fn(); } finally { saved.forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; }); }
}
const address = { address: '1 Main St', city: 'Town', postcode: '1200', country: 'Country' };
const body = (size, quantity = 1) => ({
  customerName: 'Buyer', customerEmail: 'buyer@example.com', customerPhone: '01700000000',
  deliveryAddress: address, paymentGateway: 'cod', items: [{ productId: PID, quantity, size }]
});
function shop(log, product) {
  log.reserved = []; log.created = [];
  return [
    quiet,
    [Product, 'findById', async () => product],
    [Product, 'findOneAndUpdate', async (f, u) => { log.reserved.push([f, u]); return {}; }],
    [Product, 'updateOne', async () => ({ matchedCount: 1, modifiedCount: 1 })],
    [Order, 'create', async (doc) => { log.created.push(doc); return { _id: OID, ...doc }; }],
    [emailService, 'sendOrderConfirmation', () => Promise.resolve()]
  ];
}
const tracked = { _id: PID, title: 'Bomber', price: 100, stock: 4, sizeStock: { S: 4, M: 0 } };

test('checkout: a sold-out size is refused with a clear message and takes no stock', async () => {
  const log = {};
  await withEnv({ COD_ENABLED: 'true' }, async () => withStubs(shop(log, tracked), async () => {
    const res = await request(app).post('/api/orders').send(body('M'));
    assert.equal(res.status, 409);
    assert.match(res.body.message, /out of stock in size M/);
    const notOffered = await request(app).post('/api/orders').send(body('XL'));
    assert.equal(notOffered.status, 409);
    const tooMany = await request(app).post('/api/orders').send(body('S', 5));
    assert.equal(tooMany.status, 409);
    assert.match(tooMany.body.message, /Only 4 left/);
  }));
  assert.equal(log.reserved.length, 0);
});

test('checkout: an available size is reserved on that size and the order line is marked as per-size', async () => {
  const log = {};
  await withEnv({ COD_ENABLED: 'true' }, async () => withStubs(shop(log, tracked), async () => {
    const res = await request(app).post('/api/orders').send(body('S', 2));
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }));
  const [filter, update] = log.reserved[0];
  assert.deepEqual(filter['sizeStock.S'], { $gte: 2 });
  assert.deepEqual(update.$inc, { 'sizeStock.S': -2, stock: -2 });
  assert.equal(log.created[0].items[0].sizeTracked, true);
});

test('checkout: a product without per-size stock behaves as before (no sizeTracked, one stock number)', async () => {
  const log = {};
  await withEnv({ COD_ENABLED: 'true' }, async () => withStubs(shop(log, { _id: PID, title: 'Old', price: 100, stock: 3 }), async () => {
    assert.equal((await request(app).post('/api/orders').send(body('M', 2))).status, 200);
    assert.equal((await request(app).post('/api/orders').send(body('M', 4))).status, 409);
  }));
  assert.deepEqual(log.reserved[0][1], { $inc: { stock: -2 } });
  assert.equal(log.created[0].items[0].sizeTracked, undefined);
});

async function ownerLogin() {
  const agent = request.agent(app);
  const res = await agent.post('/admin/login').send(OWNER);
  assert.equal(res.status, 200);
  return { agent, csrf: res.body.csrfToken };
}

test('admin create: stock per size makes the total the sum of the sizes; bad sizes are refused', async () => {
  const created = [];
  await withStubs([quiet, [Product, 'create', async (d) => { created.push(d); return { _id: PID, ...d, toObject() { return { ...this }; } }; }]], async () => {
    const o = await ownerLogin();
    const post = (b) => o.agent.post('/admin/products').set('X-CSRF-Token', o.csrf).send({ title: 'Tee', price: 10, category: 'Men', ...b });
    const ok = await post({ sizeStock: { S: 3, m: '4' } });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(created[0].stock, 7);
    assert.deepEqual(created[0].sizeStock, { S: 3, M: 4 });
    assert.equal((await post({ sizeStock: { XXXL: 1 } })).status, 400);
    assert.equal((await post({ sizeStock: { S: -2 } })).status, 400);
    const plain = await post({ stock: 5 });
    assert.equal(plain.status, 201);
    assert.equal(created[1].sizeStock, undefined);
  });
});

test('admin edit: sizes are applied as a change, a plain stock edit on a per-size product is refused', async () => {
  const calls = [];
  const writes = [];
  const current = { _id: PID, title: 'Tee', stock: 7, sizeStock: { S: 3, L: 4 } };
  await withStubs([
    quiet,
    [Product, 'findById', () => ({ select: async () => current })],
    [Product, 'findByIdAndUpdate', async (id, data) => { writes.push(data); return { ...current, toObject() { return { ...current }; } }; }],
    [Product, 'findOneAndUpdate', async (f, pipeline) => { calls.push(pipeline); return { ...current, stock: 9, sizeStock: { S: 5, L: 4 } }; }]
  ], async () => {
    const o = await ownerLogin();
    const put = (b) => o.agent.put(`/admin/products/${PID}`).set('X-CSRF-Token', o.csrf).send(b);
    const noPrev = await put({ sizeStock: { S: 5, L: 4 } });
    assert.equal(noPrev.status, 400);
    assert.match(noPrev.body.message, /previousSizeStock/);
    const ok = await put({ sizeStock: { S: 5, L: 4 }, previousSizeStock: { S: 3, L: 4 } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(calls.length, 1);
    assert.ok(Array.isArray(calls[0]), 'one atomic pipeline update');
    const plain = await put({ stock: 20, previousStock: 7 });
    assert.equal(plain.status, 409);
    assert.match(plain.body.message, /per size/);
    assert.equal(calls.length, 1, 'the plain stock edit changed nothing');
    const before = writes.length;
    const mixed = await put({ title: 'Renamed Tee', stock: 20, previousStock: 7 });
    assert.equal(mixed.status, 409);
    assert.equal(writes.length, before, 'no field of a refused edit is saved');
    assert.equal((await put({ sizeStock: { Q: 1 }, previousSizeStock: {} })).status, 400);
  });
});

test('seller edit: a stock change on a per-size product is refused before anything is saved', async () => {
  const { newWorld, stubsFor, seedVendor, seedProduct, withStubs: stubbed } = require('./fakeDb');
  const w = newWorld();
  const agent = request.agent(app);
  await withEnv({ MULTIVENDOR_ENABLED: 'true' }, () => stubbed(stubsFor(w), async () => {
    const reg = await agent.post('/api/users/register').send({ name: 'Seller', email: 'seller@example.com', password: 'LongEnough123' });
    assert.equal(reg.status, 201);
    const shop = seedVendor(w, { name: 'Mine', slug: 'mine', ownerUserId: w.users[0]._id });
    w.users[0].vendorId = shop._id;
    const product = seedProduct(w, shop, { title: 'Bomber', stock: 7, sizeStock: { S: 3, L: 4 } });
    const edit = { title: 'Renamed', description: '', price: '100', category: 'Men', stock: 20, previousStock: 7 };
    const refused = await agent.put(`/api/vendor/products/${product._id}`).send(edit);
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /per size/);
    assert.equal(product.title, 'Bomber', 'nothing was saved');
    assert.equal(product.stock, 7);
  }));
});
