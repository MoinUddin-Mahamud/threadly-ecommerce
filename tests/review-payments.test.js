// Payments that need a person (risky gateway payments, manual transfers), revenue split, coupons.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { SSLCommerzPayment } = (() => { const m = require('sslcommerz-lts'); return { SSLCommerzPayment: m.default || m }; })();
const { app, OWNER } = require('./helpers');
const Order = require('../models/Order');
const Product = require('../models/Product');
const marketplace = require('../services/marketplace');
const seo = require('../services/seo');
const { allowedNextStatuses } = require('../services/orderStatus');
const { expirePendingOrders, expireUnconfirmedManualOrders } = require('../services/orderService');
const { quiet, withStubs, withEnv, oid, wrap, newWorld, stubsFor, seedVendor } = require('./fakeDb');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const ID = '64b7f0c2a1b2c3d4e5f60718';
const HOUR = 3600 * 1000;
const ON = { MULTIVENDOR_ENABLED: 'true', MARKETPLACE_COMMISSION_PERCENT: '10', COD_ENABLED: 'true' };

async function ownerLogin() {
  const agent = request.agent(app);
  const res = await agent.post('/admin/login').send(OWNER);
  assert.equal(res.status, 200);
  return { agent, csrf: res.body.csrfToken };
}
const put = (o, url, body) => o.agent.put(url).set('X-CSRF-Token', o.csrf).send(body || {});

const riskyReply = { status: 'VALID', tran_id: 'TXN-1', amount: '1000.00', currency_type: 'XXX', risk_level: '1' };

test('a risky SSLCommerz payment keeps the order PENDING, flagged for review, and the customer sees the review page', async () => {
  const updates = [];
  await withStubs([quiet,
    [SSLCommerzPayment.prototype, 'validate', async () => riskyReply],
    [Order, 'findOne', async () => ({ _id: ID, transactionId: 'TXN-1', status: 'PENDING', totalAmount: 1000 })],
    [Order, 'findOneAndUpdate', async (f, u) => { updates.push({ f, u }); return {}; }]
  ], async () => {
    const res = await request(app).post('/api/payment/success').send({ tran_id: 'TXN-1', val_id: 'VAL1' });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /payment-success\.html\?tran_id=TXN-1&review=1/);
  });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].f.status, 'PENDING');
  assert.equal(updates[0].u.$set.paymentIssue, 'PAYMENT_UNCONFIRMED');
  assert.equal(updates[0].u.$set.valId, 'VAL1');          // the gateway's id, kept apart from a customer's payment reference
  assert.equal(updates[0].u.$set.paymentReference, undefined);
});

test('a risky payment that arrives for an already CANCELLED order is still recorded as a late payment', async () => {
  const flagged = [];
  await withStubs([quiet,
    [SSLCommerzPayment.prototype, 'validate', async () => riskyReply],
    [Order, 'findOne', async () => ({ _id: ID, transactionId: 'TXN-1', status: 'CANCELLED', totalAmount: 1000, customerEmail: 'a@b.co' })],
    [Order, 'findOneAndUpdate', async () => null],
    [Order, 'updateOne', async (f, u) => { flagged.push(u.$set); return { modifiedCount: 1 }; }]
  ], async () => {
    const res = await request(app).post('/api/payment/success').send({ tran_id: 'TXN-1', val_id: 'VAL1' });
    assert.match(res.headers.location, /reason=paid_late/);
  });
  assert.equal(flagged[0].paymentIssue, 'PAID_AFTER_CANCEL');
});

test('the unpaid-order timer skips orders flagged for review', async () => {
  let filter;
  await withStubs([[Order, 'find', (f) => { filter = f; return { select() { return this; }, limit() { return this; }, lean: async () => [] }; }]], async () => {
    await expirePendingOrders();
  });
  assert.deepEqual(filter.paymentIssue, { $ne: 'PAYMENT_UNCONFIRMED' });
  assert.equal(filter.status, 'PENDING');
});

test('staff may confirm a flagged PENDING order (and only that kind of PENDING order)', () => {
  assert.deepEqual(allowedNextStatuses({ status: 'PENDING', paymentGateway: 'sslcommerz', paymentIssue: 'PAYMENT_UNCONFIRMED' }), ['CONFIRMED', 'CANCELLED']);
  assert.deepEqual(allowedNextStatuses({ status: 'PENDING', paymentGateway: 'sslcommerz' }), ['CANCELLED']);
});

test('confirming a flagged PENDING order records the payment and clears the flag', async () => {
  const o = await ownerLogin();
  let update;
  await withStubs([
    [Order, 'findById', async () => ({ _id: ID, status: 'PENDING', paymentGateway: 'sslcommerz', paymentIssue: 'PAYMENT_UNCONFIRMED', items: [] })],
    [Order, 'findOneAndUpdate', async (f, u) => { update = { f, u }; return { _id: ID, status: 'CONFIRMED', customerEmail: 'a@b.co', totalAmount: 1, items: [] }; }]
  ], async () => {
    assert.equal((await put(o, `/admin/orders/${ID}/confirm`)).status, 200);
  });
  assert.equal(update.f.status, 'PENDING');
  assert.equal(update.u.$set.status, 'CONFIRMED');
  assert.ok(update.u.$set.paidAt instanceof Date);
  assert.deepEqual(update.u.$unset, { paymentIssue: 1 });
});

test('cancelling an order whose payment was only reported or flagged raises REFUND_DUE', async () => {
  const o = await ownerLogin();
  const updates = [];
  await withStubs([
    [Order, 'findById', async () => ({ _id: ID, status: 'PENDING', paymentGateway: 'sslcommerz', paymentIssue: 'PAYMENT_UNCONFIRMED', items: [] })],
    [Order, 'findOneAndUpdate', async (f, u) => { updates.push(u); return { _id: ID, status: 'CANCELLED', customerEmail: 'a@b.co', items: [], ...(u.$set && u.$set.paymentIssue ? { paymentIssue: u.$set.paymentIssue } : {}) }; }]
  ], async () => {
    const res = await put(o, `/admin/orders/${ID}/status`, { status: 'CANCELLED' });
    assert.equal(res.status, 200);
    assert.equal(res.body.paymentIssue, 'REFUND_DUE');
  });
  assert.ok(updates.some((u) => u.$set && u.$set.paymentIssue === 'REFUND_DUE'));
});

test('a manual order with a reference is flagged inside its review window and cancelled with REFUND_DUE after it', async () => {
  const flagged = []; const cancelled = [];
  await withEnv({ MANUAL_PAYMENT_HOURS: '2', MANUAL_PAYMENT_REVIEW_HOURS: '10' }, async () => {
    await withStubs([quiet,
      [Order, 'find', () => ({ sort: () => ({ limit: async () => [
        { _id: 'inside', paymentReference: 'R1', createdAt: new Date(Date.now() - 5 * HOUR) },
        { _id: 'past', paymentReference: 'R2', paymentIssue: 'PAYMENT_UNCONFIRMED', createdAt: new Date(Date.now() - 13 * HOUR) },
        { _id: 'none', createdAt: new Date(Date.now() - 5 * HOUR) }
      ] }) })],
      [Order, 'updateOne', async (f) => { flagged.push(f._id); return {}; }],
      [Order, 'findOneAndUpdate', async (f, u) => { cancelled.push({ id: f._id, u }); return { _id: f._id, paymentGateway: 'manual', customerEmail: 'a@b.co', items: [] }; }],
      [Product, 'updateOne', async () => ({})]
    ], async () => { assert.equal(await expireUnconfirmedManualOrders(), 2); });
  });
  assert.deepEqual(flagged, ['inside']);
  const byId = Object.fromEntries(cancelled.map((c) => [c.id, c.u]));
  assert.equal(byId.past.paymentIssue, 'REFUND_DUE');
  assert.equal(byId.none.paymentIssue, undefined, 'no reference: plain cancel');
});

test('the manual-payment cleanup reads oldest first and leaves orders that are flagged and still being reviewed alone', async () => {
  let filter; let sorted;
  await withEnv({ MANUAL_PAYMENT_HOURS: '2', MANUAL_PAYMENT_REVIEW_HOURS: '10' }, async () => {
    await withStubs([[Order, 'find', (f) => { filter = f; return { sort: (s) => { sorted = s; return { limit: async () => [] }; } }; }]], async () => { await expireUnconfirmedManualOrders(); });
  });
  assert.deepEqual(sorted, { createdAt: 1 });
  assert.equal(filter.$or[0].paymentIssue.$ne, 'PAYMENT_UNCONFIRMED');
  assert.ok(filter.$or[1].createdAt.$lt instanceof Date);
});

test('a payment reference that is already on another order is accepted and both orders are flagged', async () => {
  const flagged = [];
  await withStubs([
    [Order, 'findOneAndUpdate', async () => ({ _id: ID, paymentReference: null })],
    [Order, 'countDocuments', async () => 2],
    [Order, 'updateMany', async (f, u) => { flagged.push({ f, u }); return {}; }]
  ], async () => {
    const res = await request(app).post(`/api/orders/${ID}/payment-reference`).send({ paymentReference: 'ABC123', transactionId: 'MAN-1' });
    assert.equal(res.status, 200);
    assert.equal(res.body.paymentReference, 'ABC123');
  });
  assert.deepEqual(flagged, [{ f: { paymentReference: 'ABC123' }, u: { $set: { paymentReferenceDuplicate: true } } }]);
});

const mixedOrder = {
  _id: ID, totalAmount: 1460, shippingAmount: 60, discountAmount: 100,
  items: [{ price: 500, quantity: 1 }, { price: 1000, quantity: 1, vendorId: 'v1', commissionPercent: 10 }]
};
const orderRows = (rows) => [Order, 'find', () => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => rows })];

test('revenue split: store keeps own items + commission + shipping - coupons, sellers keep price minus commission', async () => {
  await withStubs([orderRows([mixedOrder])], async () => {
    const r = await marketplace.revenueBreakdown();
    assert.equal(r.commissionEarned, 100);
    assert.equal(r.vendorShare, 900, "the store's own item is not a seller's share");
    assert.equal(r.storeRevenue, 560);
    assert.equal(r.shippingCollected, 60);
    assert.equal(r.couponDiscounts, 100);
  });
});

test('the admin stats and revenue endpoints return that split when the marketplace is on, and not when it is off', async () => {
  const o = await ownerLogin();
  const stubs = [orderRows([mixedOrder]),
    [Order, 'aggregate', async (p) => (p[0].$match ? [{ _id: null, minor: 146000, totalRevenue: 146000, count: 1, orderCount: 1 }] : [])],
    [Product, 'countDocuments', async () => 1]];
  await withStubs(stubs, async () => {
    await withEnv({ MULTIVENDOR_ENABLED: 'true' }, async () => {
      const stats = (await o.agent.get('/admin/stats')).body;
      assert.equal(stats.totalRevenue, 1460);
      assert.equal(stats.storeRevenue, 560);
      assert.equal(stats.vendorShare, 900);
      assert.equal((await o.agent.get('/admin/revenue')).body.storeRevenue, 560);
    });
    await withEnv({ MULTIVENDOR_ENABLED: 'false' }, async () => {
      assert.equal((await o.agent.get('/admin/stats')).body.storeRevenue, undefined);
    });
  });
});

test('wouldLoseMoney: sellers always earn price minus commission', () => {
  const items = [{ price: 1000, quantity: 1, vendorId: 'v1', commissionPercent: 10 }];
  assert.equal(marketplace.vendorNetOfItems(items), 90000);
  assert.equal(marketplace.wouldLoseMoney(items, 1000), true, '100% coupon: customer pays the 10 minimum');
  assert.equal(marketplace.wouldLoseMoney(items, 90000), false);
  assert.equal(marketplace.wouldLoseMoney(items, 89999), true);
  assert.equal(marketplace.wouldLoseMoney([{ price: 1000, quantity: 1 }], 1000), false, "the store's own items are never a loss");
});

test('the coupon preview refuses an item that is out of stock, like checkout does', async () => {
  await withStubs([quiet, [Product, 'find', () => ({ select: () => ({ lean: async () => [{ _id: ID, price: 100, stock: 0, vendorId: null }] }) })]], async () => {
    const res = await request(app).post('/api/coupons/validate').send({ code: 'SAVE10', items: [{ productId: ID, quantity: 1, size: 'M' }] });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /out of stock/);
  });
});

test('derivedStatus follows the sellers, but never for an order that also holds the store\'s own items', () => {
  const f = (...s) => s.map((status, i) => ({ vendorId: `v${i}`, status }));
  const sellers = [{ vendorId: 'v0' }, { vendorId: 'v1' }];
  assert.equal(marketplace.derivedStatus({ items: sellers, fulfillment: f('SHIPPED', 'SHIPPED') }), 'SHIPPED');
  assert.equal(marketplace.derivedStatus({ items: sellers, fulfillment: f('DELIVERED', 'DELIVERED') }), 'DELIVERED');
  assert.equal(marketplace.derivedStatus({ items: sellers, fulfillment: f('DELIVERED', 'PENDING') }), null);
  assert.equal(marketplace.derivedStatus({ items: [...sellers, {}], fulfillment: f('DELIVERED', 'DELIVERED') }), null);
});

async function sellerWorld() {
  const w = newWorld();
  const agent = request.agent(app);
  await withStubs(stubsFor(w), async () => {
    const res = await agent.post('/api/users/register').send({ name: 'Seller', email: 'sell@example.com', password: 'LongEnough123' });
    assert.equal(res.status, 201);
  });
  const v = seedVendor(w, { ownerUserId: w.users[0]._id, status: 'approved' }); w.users[0].vendorId = v._id;
  return { w, agent, v };
}

test('an order that also holds the store\'s own items is not moved to SHIPPED by the seller alone', async () => {
  const { w, agent, v } = await sellerWorld();
  const order = wrap({ _id: oid(), status: 'CONFIRMED', paidAt: new Date(), createdAt: new Date(), customerName: 'B', paymentGateway: 'cod',
    items: [{ title: 'Own', price: 100, quantity: 1 }, { title: 'Tee', price: 500, quantity: 1, vendorId: v._id, commissionPercent: 10 }],
    fulfillment: [{ vendorId: v._id, status: 'PENDING', note: '' }] });
  w.orders.push(order);
  await withEnv(ON, () => withStubs(stubsFor(w), async () => {
    assert.equal((await agent.patch(`/api/vendor/orders/${order._id}/fulfillment`).send({ status: 'SHIPPED' })).status, 200);
    assert.equal(order.status, 'CONFIRMED', 'the store ships its own item; staff move the order');
  }));
});

test('"orders to ship" does not count orders still waiting for store confirmation, and ?needs=ship lists only shippable ones', async () => {
  const { w, agent, v } = await sellerWorld();
  const mk = (status) => { const o = wrap({ _id: oid(), status, paidAt: new Date(), createdAt: new Date(), customerName: 'B', paymentGateway: 'cod',
    items: [{ title: 'Tee', price: 500, quantity: 1, vendorId: v._id, commissionPercent: 10 }], fulfillment: [{ vendorId: v._id, status: 'PENDING' }] }); w.orders.push(o); return o; };
  const placed = mk('PLACED'); const confirmed = mk('CONFIRMED'); mk('CANCELLED');
  await withEnv(ON, () => withStubs(stubsFor(w), async () => {
    assert.equal((await agent.get('/api/vendor/dashboard')).body.ordersToShip, 1);
    const ids = (await agent.get('/api/vendor/orders?needs=ship')).body.orders.map((o) => o.id);
    assert.deepEqual(ids, [String(confirmed._id)]);
    assert.ok(!ids.includes(String(placed._id)));
  }));
});

test('an admin SHIPPED / DELIVERED override changes each seller entry with its own conditional write, not by rewriting the array', async () => {
  const o = await ownerLogin();
  const updates = [];
  const order = { _id: ID, status: 'SHIPPED', items: [], customerEmail: 'a@b.co', fulfillment: [{ vendorId: 'v1', status: 'PENDING' }, { vendorId: 'v2', status: 'DELIVERED' }] };
  await withStubs([
    [Order, 'findById', async () => ({ _id: ID, status: 'CONFIRMED', paymentGateway: 'cod', items: [] })],
    [Order, 'findOneAndUpdate', async () => order],
    [Order, 'updateOne', async (f, u) => { updates.push({ f, u }); return {}; }]
  ], async () => { assert.equal((await put(o, `/admin/orders/${ID}/status`, { status: 'SHIPPED' })).status, 200); });
  assert.equal(updates.length, 1, 'only the entry that is not delivered yet');
  assert.ok(updates[0].u.$set['fulfillment.$.status']);
  assert.equal(updates[0].u.$set.fulfillment, undefined);
});

const PAGES = ['privacy', 'terms', 'returns', 'shipping', 'faq', 'contact'];

test('every policy page exists, is served, and is linked from the storefront and seller footers', async () => {
  for (const p of PAGES) {
    const res = await request(app).get(`/${p}.html`);
    assert.equal(res.status, 200, p);
    assert.match(res.text, /<h1/);
    assert.ok(read('public/index.html').includes(`href="/${p}.html"`), `index footer links ${p}`);
    assert.ok(read('public/vendor.html').includes(`href="/${p}.html"`), `vendor footer links ${p}`);
  }
});

test('the policy pages carry no made-up contact details and take them from /api/site-info', () => {
  for (const p of PAGES) assert.ok(!/\b0\d{10}\b|\+880/.test(read(`public/${p}.html`)), `${p} has a phone number`);
  assert.match(read('public/js/legal.js'), /\/api\/site-info/);
  assert.match(read('public/contact.html'), /legalContactList/);
  assert.match(read('public/shipping.html'), /legalContactList/);
});

test('the sitemap lists the policy pages and the admin pages stay noindex', () => {
  const xml = seo.renderSitemap('https://shop.example.com', []);
  for (const p of PAGES) assert.ok(xml.includes(`https://shop.example.com/${p}.html</loc>`), p);
  assert.equal(seo.isNoindexPath('/privacy.html'), false);
  assert.equal(seo.isNoindexPath('/admin.html'), true);
});

test('the chatbot is told to point to the policy pages instead of inventing a returns policy', () => {
  const src = read('services/chatPolicy.js');
  assert.match(src, /\/returns\.html/);
  assert.match(src, /NEVER invent/);
});

test('README, package.json and the storefront say what the code does', () => {
  const readme = read('README.md');
  assert.ok(!/six payment options/i.test(readme));
  assert.match(readme, /seven payment options/);
  assert.ok(!/default and always-on/.test(readme));
  for (const name of ['MANUAL_PAYMENT_ENABLED', 'MANUAL_PAYMENT_INSTRUCTIONS', 'MANUAL_PAYMENT_HOURS', 'MANUAL_PAYMENT_REVIEW_HOURS', 'SUPPORT_EMAIL']) {
    assert.ok(new RegExp(`\\| \`${name}`).test(readme), `${name} is in the env table`);
    if (name !== 'SUPPORT_EMAIL') assert.ok(read('.env.example').includes(name), `${name} is in .env.example`);
  }
  for (const f of ['money.js', 'productRules.js', 'orderStatus.js', 'paymentConfig.js', 'intlGateways.js', 'auditService.js', 'AuditLog', 'CouponRedemption', 'AdminTwoFactor', 'Audit: View']) assert.ok(readme.includes(f), `README mentions ${f}`);
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.description, /marketplace/i);
  assert.ok(pkg.keywords.includes('marketplace') && pkg.keywords.includes('clothing'));
  assert.ok(!/size and price/.test(read('public/index.html')), 'there is no size filter');
  assert.ok(!/Leather, Denim, Winter/.test(read('public/admin.html')));
  assert.equal(JSON.parse(read('package-lock.json')).version, pkg.version);
});

test('categories are one list: Men, Women, Kids, Accessories (no stale Male / Female keys)', () => {
  const { CATEGORIES } = require('../routes/vendor');
  assert.deepEqual(CATEGORIES, ['Men', 'Women', 'Kids', 'Accessories']);
  assert.ok(!/Male:|Female:/.test(read('public/js/app.js')));
  assert.ok(read('public/js/app.js').includes("Accessories: 'handbag'"));
});
