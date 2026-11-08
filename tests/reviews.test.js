// Product reviews: who may write one, cleaning, the rating summary, moderation and how reviews are
// shown.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, OWNER } = require('./helpers');
const User = require('../models/User');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Review = require('../models/Review');
const Vendor = require('../models/Vendor');
const reviews = require('../services/reviews');
const seo = require('../services/seo');

const USER_ID = '64b7f0c2a1b2c3d4e5f60aaa';
const PID = '64b7f0c2a1b2c3d4e5f60999';
const RID = '64b7f0c2a1b2c3d4e5f60bbb';
const quiet = [console, 'error', () => {}];
async function withStubs(stubs, fn) {
  const saved = stubs.map(([t, n]) => [t, n, t[n]]);
  stubs.forEach(([t, n, impl]) => { t[n] = impl; });
  try { await fn(); } finally { saved.forEach(([t, n, o]) => { t[n] = o; }); }
}

let agent = null;
async function customer() {
  if (agent) return agent;
  agent = request.agent(app);
  await withStubs([[console, 'log', () => {}], [User, 'findOne', async () => null],
    [User, 'create', async (doc) => ({ _id: USER_ID, name: doc.name, email: doc.email })]], async () => {
    const res = await agent.post('/api/users/register').send({ name: 'Buyer One', email: 'buyer@example.com', password: 'LongEnough123' });
    assert.equal(res.status, 201);
  });
  return agent;
}
const buyer = { _id: USER_ID, name: 'Buyer One', email: 'buyer@example.com', emailVerified: false };

test('cleanReview: rating must be a whole number from 1 to 5; the text is plain and limited', () => {
  assert.deepEqual(reviews.cleanReview({ rating: 5, text: 'Great' }), { ok: true, rating: 5, text: 'Great' });
  assert.equal(reviews.cleanReview({ rating: '4' }).rating, 4);
  for (const bad of [{}, { rating: 0 }, { rating: 6 }, { rating: 2.5 }, { rating: 'x' }, { rating: '' }, { rating: null }, { rating: [5] }, { rating: { $gt: 1 } }, { rating: true }]) {
    assert.equal(reviews.cleanReview(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(reviews.cleanReview(undefined).ok, false);
  assert.equal(reviews.cleanReview({ rating: 3, text: { a: 1 } }).ok, false);
  assert.equal(reviews.cleanReview({ rating: 3, text: 'x'.repeat(1001) }).ok, false);
  assert.equal(reviews.cleanReview({ rating: 3, text: 'x'.repeat(1000) }).ok, true);
  const plain = reviews.cleanReview({ rating: 3, text: '<script>alert(1)</script>  nice\n\tfit' }).text;
  assert.ok(!/[<>\n\t]/.test(plain) && !/  /.test(plain) && plain.endsWith('nice fit'), plain);
});

test('displayName shows a first name and a last initial, never an e-mail address', () => {
  assert.equal(reviews.displayName({ name: 'Anna Karenina' }), 'Anna K.');
  assert.equal(reviews.displayName({ name: 'anna maria de souza' }), 'anna S.');
  assert.equal(reviews.displayName({ name: 'Cher' }), 'Cher');
  assert.equal(reviews.displayName({ name: '   ' }), 'Customer');
  assert.equal(reviews.displayName({ email: 'x@y.com' }), 'Customer');
  assert.ok(!/[<>]/.test(reviews.displayName({ name: '<b>Eve</b> Ng' })));
});

test('who may review: only an order that was delivered, own orders only', async () => {
  const seen = [];
  await withStubs([[Order, 'exists', async (q) => { seen.push(q); return { _id: 1 }; }]], async () => {
    assert.equal(await reviews.hasReceived({ _id: USER_ID, email: 'a@b.com', emailVerified: false }, PID), true);
    await reviews.hasReceived({ _id: USER_ID, email: 'a@b.com', emailVerified: true }, PID);
  });
  assert.equal(seen[0].status, 'DELIVERED');
  assert.equal(seen[0]['items.productId'], PID);
  assert.deepEqual(seen[0].$or, [{ userId: USER_ID }], 'a guest order counts only after the e-mail is verified');
  assert.deepEqual(seen[1].$or, [{ userId: USER_ID }, { customerEmail: 'a@b.com' }]);
});

test('refreshRating keeps the average (one decimal) and the count on the product; no reviews clears them', async () => {
  const updates = [];
  await withStubs([
    [Review, 'aggregate', async () => [{ _id: null, average: 4.25, count: 8 }]],
    [Product, 'updateOne', async (f, u) => { updates.push(u); return {}; }]
  ], async () => { assert.deepEqual(await reviews.refreshRating(PID), { average: 4.3, count: 8 }); });
  assert.deepEqual(updates[0], { $set: { ratingAverage: 4.3, ratingCount: 8 } });
  await withStubs([[Review, 'aggregate', async () => []], [Product, 'updateOne', async (f, u) => { updates.push(u); return {}; }]], async () => {
    assert.deepEqual(await reviews.refreshRating(PID), { average: 0, count: 0 });
  });
  assert.ok(updates[1].$unset);
});

test('POST a review: login needed, product and delivery checked, one per customer, text stored as plain text', async () => {
  const a = await customer();
  const created = []; const updates = [];
  const base = [
    quiet,
    [User, 'findById', async () => buyer],
    [Product, 'findById', () => ({ select: async () => ({ _id: PID }) })],
    [Review, 'aggregate', async () => [{ average: 5, count: 1 }]],
    [Product, 'updateOne', async (f, u) => { updates.push(u); return {}; }]
  ];
  assert.equal((await request(app).post(`/api/users/products/${PID}/reviews`).send({ rating: 5 })).status, 401);
  await withStubs([...base, [Order, 'exists', async () => null]], async () => {
    const res = await a.post(`/api/users/products/${PID}/reviews`).send({ rating: 5 });
    assert.equal(res.status, 403);
  });
  await withStubs([...base, [Order, 'exists', async () => ({ _id: 1 })],
    [Review, 'create', async (d) => { created.push(d); return d; }]], async () => {
    for (const bad of [{ rating: 0 }, { rating: 7 }, { rating: 'five' }, {}]) {
      assert.equal((await a.post(`/api/users/products/${PID}/reviews`).send(bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await a.post('/api/users/products/not-an-id/reviews').send({ rating: 5 })).status, 400);
    const ok = await a.post(`/api/users/products/${PID}/reviews`).send({ rating: 4, text: '<img src=x onerror=alert(1)> Fits well' });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.count, 1);
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].authorName, 'Buyer O.');
  assert.equal(created[0].rating, 4);
  assert.ok(!/[<>]/.test(created[0].text), created[0].text);
  assert.equal(String(created[0].userId), USER_ID);
  assert.deepEqual(updates[0], { $set: { ratingAverage: 5, ratingCount: 1 } });
  await withStubs([...base, [Order, 'exists', async () => ({ _id: 1 })],
    [Review, 'create', async () => { const e = new Error('dup'); e.code = 11000; throw e; }]], async () => {
    const res = await a.post(`/api/users/products/${PID}/reviews`).send({ rating: 5 });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /already reviewed/);
  });
  await withStubs([...base, [Product, 'findById', () => ({ select: async () => null })], [Order, 'exists', async () => ({ _id: 1 })]], async () => {
    assert.equal((await a.post(`/api/users/products/${PID}/reviews`).send({ rating: 5 })).status, 404);
  });
});

test('my-reviews lists the products already reviewed', async () => {
  const a = await customer();
  await withStubs([quiet, [Review, 'find', () => ({ select: () => ({ limit: () => ({ lean: async () => [{ productId: PID }] }) }) })]], async () => {
    const res = await a.get('/api/users/my-reviews');
    assert.equal(res.status, 200); assert.deepEqual(res.body.productIds, [PID]);
  });
  assert.equal((await request(app).get('/api/users/my-reviews')).status, 401);
});

test('GET reviews of a product: public, newest first, no customer ids, bad ids are 404', async () => {
  const rows = [{ authorName: 'Anna K.', rating: 5, text: 'Great', createdAt: new Date('2026-01-02'), userId: 'secret' }];
  await withStubs([quiet,
    [Product, 'findById', () => ({ select: async () => ({ _id: PID, ratingAverage: 4.5, ratingCount: 2 }) })],
    [Review, 'find', () => ({ sort: () => ({ skip: () => ({ limit: () => ({ select: () => ({ lean: async () => rows }) }) }) }) })],
    [Review, 'countDocuments', async () => 1]
  ], async () => {
    const res = await request(app).get(`/api/products/${PID}/reviews`);
    assert.equal(res.status, 200);
    assert.equal(res.body.average, 4.5); assert.equal(res.body.count, 2);
    assert.equal(res.body.reviews.length, 1);
    assert.ok(!JSON.stringify(res.body).includes('secret'), 'customer ids are never sent');
    assert.equal((await request(app).get('/api/products/zzz/reviews')).status, 404);
  });
});

async function ownerLogin() {
  const ag = request.agent(app);
  const res = await ag.post('/admin/login').send(OWNER);
  assert.equal(res.status, 200);
  return { ag, csrf: res.body.csrfToken };
}

test('admin moderation: list, hide, show and delete refresh the rating; permissions and ids are checked', async () => {
  const updates = [];
  assert.equal((await request(app).get('/admin/reviews')).status, 401);
  await withStubs([quiet,
    [Review, 'find', () => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => [{ _id: RID, productId: PID, authorName: 'Anna K.', rating: 2, text: 'meh', hidden: false, createdAt: new Date() }] }) }) }) })],
    [Review, 'countDocuments', async () => 1],
    [Product, 'find', () => ({ select: () => ({ lean: async () => [{ _id: PID, title: 'Tee' }] }) })],
    [Review, 'findByIdAndUpdate', async (id, u) => ({ _id: RID, productId: PID, hidden: u.$set.hidden })],
    [Review, 'findByIdAndDelete', async () => ({ _id: RID, productId: PID })],
    [Review, 'aggregate', async () => []],
    [Product, 'updateOne', async (f, u) => { updates.push(u); return {}; }]
  ], async () => {
    const o = await ownerLogin();
    const list = await o.ag.get('/admin/reviews');
    assert.equal(list.status, 200);
    assert.equal(list.body.reviews[0].productTitle, 'Tee');
    assert.equal((await o.ag.put(`/admin/reviews/${RID}`).send({ hidden: true })).status, 403, 'CSRF token needed');
    const hide = await o.ag.put(`/admin/reviews/${RID}`).set('X-CSRF-Token', o.csrf).send({ hidden: true });
    assert.equal(hide.status, 200); assert.equal(hide.body.hidden, true);
    assert.equal((await o.ag.put(`/admin/reviews/${RID}`).set('X-CSRF-Token', o.csrf).send({ hidden: 'yes' })).status, 400);
    assert.equal((await o.ag.put('/admin/reviews/xyz').set('X-CSRF-Token', o.csrf).send({ hidden: true })).status, 400);
    assert.equal((await o.ag.delete(`/admin/reviews/${RID}`).set('X-CSRF-Token', o.csrf)).status, 200);
    assert.equal(updates.length, 2, 'the rating was recalculated after each change');
  });
});

test('the product page shows reviews escaped, with star data; none when there are none', () => {
  const CFG = { baseUrl: 'https://shop.example', siteName: 'Shop' };
  const EVIL = '<script>alert(1)</script>';
  const doc = { _id: PID, title: 'Tee', price: 10, stock: 3, category: 'Men', description: 'd', imageUrl: '/x.png', ratingAverage: 4.5, ratingCount: 2 };
  const list = [{ authorName: EVIL, rating: 5, text: EVIL, createdAt: new Date('2026-01-02') }, { authorName: 'Bo', rating: 4, text: '', createdAt: new Date('2026-01-01') }];
  const html = seo.renderProductPage(doc, CFG, list);
  assert.match(html, /id="productReviews"/);
  assert.ok(!html.includes('<script>alert'), 'raw script leaked');
  assert.ok(html.includes('&lt;script&gt;'));
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(ld.aggregateRating.ratingValue, 4.5); assert.equal(ld.aggregateRating.reviewCount, 2);
  assert.equal(ld.review.length, 2);
  const none = seo.renderProductPage({ ...doc, ratingAverage: undefined, ratingCount: undefined }, CFG, []);
  assert.ok(!/productReviews|aggregateRating/.test(none));
});

test('deleting a product also deletes its reviews', async () => {
  let removed = null;
  await withStubs([quiet, [Product, 'findByIdAndDelete', async () => ({ _id: PID, title: 'Tee' })],
    [Review, 'deleteMany', async (q) => { removed = q; return {}; }]], async () => {
    const o = await ownerLogin();
    assert.equal((await o.ag.delete(`/admin/products/${PID}`).set('X-CSRF-Token', o.csrf)).status, 200);
  });
  assert.deepEqual(removed, { productId: PID });
});

test('a seller cannot review a product of their own shop', async () => {
  const a = await customer();
  const SHOP = '64b7f0c2a1b2c3d4e5f60ccc';
  const created = [];
  const seller = { ...buyer, vendorId: SHOP };
  const stubs = (owner, shop) => [
    quiet,
    [User, 'findById', async () => owner],
    [Product, 'findById', () => ({ select: async () => ({ _id: PID, vendorId: shop }) })],
    [Order, 'exists', async () => ({ _id: 1 })],
    [Review, 'create', async (d) => { created.push(d); return d; }],
    [Review, 'aggregate', async () => [{ average: 5, count: 1 }]],
    [Product, 'updateOne', async () => ({})],
    [Vendor, 'findById', () => ({ select: () => ({ lean: async () => ({ _id: shop, ownerUserId: '64b7f0c2a1b2c3d4e5f60eee' }) }) })]
  ];
  await withStubs(stubs(seller, SHOP), async () => {
    const res = await a.post(`/api/users/products/${PID}/reviews`).send({ rating: 5 });
    assert.equal(res.status, 403);
    assert.match(res.body.message, /own product/);
  });
  assert.equal(created.length, 0, 'no review is stored');
  await withStubs(stubs(seller, '64b7f0c2a1b2c3d4e5f60ddd'), async () => {
    assert.equal((await a.post(`/api/users/products/${PID}/reviews`).send({ rating: 5 })).status, 201, "another shop's product is fine");
  });
  await withStubs(stubs(buyer, SHOP), async () => {
    assert.equal((await a.post(`/api/users/products/${PID}/reviews`).send({ rating: 4 })).status, 201, 'a customer without a shop is fine');
  });
  assert.equal(reviews.isOwnProduct(seller, { vendorId: SHOP }), true);
  assert.equal(reviews.isOwnProduct(buyer, { vendorId: null }), false);
});
