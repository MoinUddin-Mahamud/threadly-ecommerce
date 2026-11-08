// A seller cannot buy from, or review, their own shop (checked through the account and the shop).
const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.PAYOUT_HOLD_DAYS = '0';
const request = require('supertest');
const SSLCommerzPayment = require('sslcommerz-lts');
const { app } = require('./helpers');
const Vendor = require('../models/Vendor');
const Product = require('../models/Product');
const Order = require('../models/Order');
const User = require('../models/User');
const Review = require('../models/Review');
const emailService = require('../services/emailService');
const reviews = require('../services/reviews');
const { quiet, withStubs, withEnv, oid, chain, matches, newWorld, stubsFor, seedVendor, seedProduct } = require('./fakeDb');

const ON = { MULTIVENDOR_ENABLED: 'true', MARKETPLACE_COMMISSION_PERCENT: '10', COD_ENABLED: 'true' };
const address = { address: '1 Main St', city: 'Dhaka', postcode: '1200', country: 'Bangladesh' };
const body = (id) => ({
  customerName: 'Buyer', customerEmail: 'buyer@example.com', customerPhone: '01700000000', deliveryAddress: address,
  paymentGateway: 'cod', items: [{ productId: id, quantity: 1, size: 'M' }]
});
function checkoutStubs(w, created) {
  return [
    quiet,
    [Vendor, 'findOne', (f) => chain(w.vendors.find((v) => matches(v, f)) || null)],
    [Product, 'findById', async (id) => w.products.find((p) => String(p._id) === String(id)) || null],
    [Product, 'findOneAndUpdate', async () => ({})], [Product, 'updateOne', async () => ({})],
    [Order, 'create', async (d) => { created.push(d); return { _id: oid(), ...d }; }], [Order, 'updateOne', async () => ({})],
    [emailService, 'sendOrderConfirmation', () => Promise.resolve()],
    [SSLCommerzPayment.prototype, 'init', async () => ({ GatewayPageURL: 'https://pay.example/x' })]
  ];
}

test('a logged-in shop owner cannot place an order for a product of their own shop; others can', async () => {
  const w = newWorld();
  const shop = seedVendor(w);
  const mine = seedProduct(w, shop, { title: 'Own Tee', price: 100 });
  const agent = request.agent(app);
  let userId;
  await withStubs(stubsFor(w), async () => {
    const res = await agent.post('/api/users/register').send({ name: 'Shop Owner', email: 'owner@example.com', password: 'LongEnough123' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    userId = res.body.user.id;
  });
  shop.ownerUserId = userId;
  const created = [];
  await withEnv(ON, () => withStubs(checkoutStubs(w, created), async () => {
    const refused = await agent.post('/api/orders').send(body(mine._id));
    assert.equal(refused.status, 403);
    assert.match(refused.body.message, /own shop/);
    assert.equal(created.length, 0, 'no order is stored');
    const other = await request(app).post('/api/orders').send(body(mine._id));
    assert.equal(other.status, 200, JSON.stringify(other.body));
    assert.equal(created.length, 1, 'a different customer can still buy it');
  }));
});

test('a seller is refused a review through the shop owner link even when the account has no shop id', async () => {
  const w = newWorld();
  const agent = request.agent(app);
  const SHOP = oid();
  const PID = oid();
  let userId;
  await withStubs(stubsFor(w), async () => {
    const res = await agent.post('/api/users/register').send({ name: 'Shop Owner', email: 'owner2@example.com', password: 'LongEnough123' });
    assert.equal(res.status, 201);
    userId = res.body.user.id;
  });
  const created = [];
  const stubs = [
    quiet,
    [User, 'findById', async () => ({ _id: userId, name: 'Shop Owner', email: 'owner2@example.com', emailVerified: false, vendorId: null })],
    [Product, 'findById', () => ({ select: async () => ({ _id: PID, vendorId: SHOP }) })],
    [Vendor, 'findById', () => ({ select: () => ({ lean: async () => ({ _id: SHOP, ownerUserId: userId }) }) })],
    [Order, 'exists', async () => ({ _id: 1 })],
    [Review, 'create', async (d) => { created.push(d); return d; }]
  ];
  await withStubs(stubs, async () => {
    const res = await agent.post(`/api/users/products/${PID}/reviews`).send({ rating: 5 });
    assert.equal(res.status, 403);
    assert.match(res.body.message, /own product/);
  });
  assert.equal(created.length, 0, 'no review is stored');
});

test('isOwnProduct knows both links, and hasReceived leaves out lines sold by the customer\'s own shop', async () => {
  const user = { _id: 'u1', vendorId: null };
  assert.equal(reviews.isOwnProduct(user, { vendorId: 's1' }, { ownerUserId: 'u1' }), true);
  assert.equal(reviews.isOwnProduct(user, { vendorId: 's1' }, { ownerUserId: 'u2' }), false);
  assert.equal(reviews.isOwnProduct(user, { vendorId: 's1' }), false);
  assert.equal(reviews.isOwnProduct({ _id: 'u1', vendorId: 's1' }, { vendorId: 's1' }), true);
  assert.equal(reviews.isOwnProduct(user, { vendorId: null }, { ownerUserId: 'u1' }), false);

  let filter = null;
  await withStubs([[Order, 'exists', async (f) => { filter = f; return null; }]], async () => {
    await reviews.hasReceived({ _id: 'u1', email: 'a@b.com' }, 'p1');
    assert.deepEqual(filter['items.productId'], 'p1');
    await reviews.hasReceived({ _id: 'u1', email: 'a@b.com' }, 'p1', 's1');
    assert.deepEqual(filter.items, { $elemMatch: { productId: 'p1', vendorId: { $ne: 's1' } } });
    assert.equal('items.productId' in filter, false);
  });
});
