// Tests for the multi-vendor marketplace: visibility, applying, a vendor's own
// area (and that one vendor cannot reach another's data), order snapshots,
// earnings and payouts, and the admin controls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
// These tests are about earnings and payouts, not the hold (the 7-day default is tested in
// currency-decimals and chat-retry-safety), so they run without it.
process.env.PAYOUT_HOLD_DAYS = '0';
const request = require('supertest');
const SSLCommerzPayment = require('sslcommerz-lts');
const { app, OWNER, addAccount } = require('./helpers');
const Vendor = require('../models/Vendor');
const Product = require('../models/Product');
const Order = require('../models/Order');
const User = require('../models/User');
const Payout = require('../models/Payout');
const Role = require('../models/Role');
const emailService = require('../services/emailService');
const marketplace = require('../services/marketplace');
const { quiet, withStubs, withEnv, oid, wrap, chain, matches, newWorld, stubsFor, seedVendor, seedProduct } = require('./fakeDb');

const ON = { MULTIVENDOR_ENABLED: 'true', MARKETPLACE_COMMISSION_PERCENT: '10', COD_ENABLED: 'true' };



// A logged-in shopper (a normal customer account). Registration is allowed 5 times an hour, so we
// make two for the whole file.
async function shopper(w, n) {
  const agent = request.agent(app);
  await withStubs(stubsFor(w), async () => {
    const res = await agent.post('/api/users/register').send({ name: `Seller ${n}`, email: `seller${n}@example.com`, password: 'LongEnough123' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });
  return agent;
}

test('marketplace is off by default: routes answer 404 and vendor products are hidden', async () => {
  const w = newWorld();
  const v = seedVendor(w); seedProduct(w, v, { title: 'Vendor Tee' }); seedProduct(w, null, { title: 'Store Tee' });
  await withEnv({ MULTIVENDOR_ENABLED: undefined }, () => withStubs(stubsFor(w), async () => {
    assert.equal((await request(app).get('/api/shops')).status, 404);
    assert.equal((await request(app).get('/api/vendor/me')).status, 404);
    const list = await request(app).get('/api/products');
    assert.deepEqual(list.body.map((p) => p.title), ['Store Tee']);
    assert.equal((await request(app).get(`/api/products/${w.products[0]._id}`)).status, 404);
  }));
});

test('only approved vendors\' products are listed, each with its seller', async () => {
  const w = newWorld();
  const ok = seedVendor(w); const pending = seedVendor(w, { name: 'New Shop', slug: 'new-shop', status: 'pending' }); const bad = seedVendor(w, { name: 'Bad', slug: 'bad', status: 'suspended' });
  seedProduct(w, ok, { title: 'Good Tee' }); seedProduct(w, pending, { title: 'Pending Tee' }); seedProduct(w, bad, { title: 'Suspended Tee' }); seedProduct(w, null, { title: 'Store Tee' });
  await withEnv(ON, () => withStubs(stubsFor(w), async () => {
    const list = (await request(app).get('/api/products')).body;
    assert.deepEqual(list.map((p) => p.title).sort(), ['Good Tee', 'Store Tee']);
    assert.deepEqual(list.find((p) => p.title === 'Good Tee').vendor, { name: 'Urban Loom', slug: 'urban-loom' });
    assert.equal('vendor' in list.find((p) => p.title === 'Store Tee'), false);
    const hidden = w.products.find((p) => p.title === 'Suspended Tee');
    assert.equal((await request(app).get(`/api/products/${hidden._id}`)).status, 404);
    assert.equal((await request(app).get('/api/shops/bad')).status, 404);       // not approved: no public page
    assert.equal((await request(app).get('/api/shops/urban-loom')).body.name, 'Urban Loom');
    assert.deepEqual((await request(app).get('/api/shops')).body.map((s) => s.slug), ['urban-loom']);
  }));
});

test('a customer applies for a shop: validated, pending, once only, unique slug', async () => {
  const w = newWorld();
  const a = await shopper(w, 1);
  const b = await shopper(w, 2);
  await withEnv(ON, () => withStubs(stubsFor(w), async () => {
    assert.equal((await request(app).post('/api/vendor/apply').send({ shopName: 'X' })).status, 401);
    assert.equal((await a.get('/api/vendor/me')).body.vendor, null);
    assert.equal((await a.get('/api/vendor/dashboard')).status, 403);          // no shop yet
    assert.equal((await a.post('/api/vendor/apply').send({ shopName: 'X' })).status, 400);
    assert.equal((await a.post('/api/vendor/apply').send({ shopName: 'Urban Loom', phone: '<script>' })).status, 400);

    const res = await a.post('/api/vendor/apply').send({ shopName: 'Urban Loom', description: 'Streetwear', phone: '01700 000000' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.vendor.status, 'pending');
    assert.equal(res.body.vendor.commissionPercent, 10);
    assert.equal(w.users[0].vendorId, w.vendors[0]._id);

    assert.equal((await a.post('/api/vendor/apply').send({ shopName: 'Another' })).status, 409);   // one shop per account
    const second = await b.post('/api/vendor/apply').send({ shopName: 'Urban Loom!' });             // same name gets the next free slug
    assert.equal(second.status, 201);
    assert.equal(second.body.vendor.slug, 'urban-loom-2');
  }));
});

test('vendor products: pending shops cannot sell, approved ones manage only their own', async () => {
  const w = newWorld();
  const a = await shopper(w, 3);
  const mine = seedVendor(w, { name: 'Mine', slug: 'mine', status: 'pending', ownerUserId: w.users[0]._id });
  w.users[0].vendorId = mine._id;
  const other = seedVendor(w, { name: 'Other', slug: 'other' });
  const theirs = seedProduct(w, other, { title: 'Their Tee' });
  const input = { title: 'My Tee', description: 'Soft', price: '799.50', stock: '12', category: 'Men' };

  await withEnv(ON, () => withStubs(stubsFor(w), async () => {
    assert.equal((await a.post('/api/vendor/products').send(input)).status, 403);                  // still pending
    assert.equal((await a.get('/api/vendor/products')).status, 200);

    mine.status = 'approved';
    const bad = (extra) => a.post('/api/vendor/products').send({ ...input, ...extra });
    assert.equal((await bad({ title: 'x' })).status, 400);
    assert.equal((await bad({ price: '-5' })).status, 400);
    assert.equal((await bad({ price: '0' })).status, 400);
    assert.equal((await bad({ price: '1e3' })).status, 400);
    assert.equal((await bad({ stock: '1.5' })).status, 400);
    assert.equal((await bad({ category: 'Shoes' })).status, 400);
    assert.equal((await bad({ imageUrl: 'javascript:alert(1)' })).status, 400);

    const made = await a.post('/api/vendor/products').send({ ...input, vendorId: other._id, currency: 'XXX' });   // extra fields are ignored
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const created = w.products.find((p) => p.title === 'My Tee');
    assert.equal(String(created.vendorId), String(mine._id), 'the shop comes from the login, never from the request');
    assert.equal(created.price, 799.5);
    assert.equal(created.currency, undefined, 'no currency is stored');

    // only own products show up, and another shop's product cannot be changed or deleted
    assert.deepEqual((await a.get('/api/vendor/products')).body.products.map((p) => p.title), ['My Tee']);
    assert.equal((await a.put(`/api/vendor/products/${theirs._id}`).send({ ...input, previousStock: 12 })).status, 404);
    assert.equal((await a.delete(`/api/vendor/products/${theirs._id}`)).status, 404);
    assert.equal(w.products.some((p) => p.title === 'Their Tee'), true);
    assert.equal((await a.put(`/api/vendor/products/${created._id}`).send({ ...input, title: 'My Tee 2', previousStock: 12 })).status, 200);
    assert.equal(created.title, 'My Tee 2');
    // editing without touching the picture must keep an uploaded picture
    created.imageUrl = 'data:image/png;base64,iVBORw0KGgo=';
    await a.put(`/api/vendor/products/${created._id}`).send({ ...input, previousStock: 12, imageUrl: `/api/products/${created._id}/image?v=1` });
    assert.equal(created.imageUrl, 'data:image/png;base64,iVBORw0KGgo=', 'a served picture address means: keep the stored picture');
    await a.put(`/api/vendor/products/${created._id}`).send({ ...input, previousStock: 12 });
    assert.equal(created.imageUrl, 'data:image/png;base64,iVBORw0KGgo=', 'no imageUrl sent: picture unchanged');
    assert.equal((await a.delete(`/api/vendor/products/${created._id}`)).status, 200);
    assert.equal((await a.put('/api/vendor/products/not-an-id').send({ ...input, previousStock: 12 })).status, 400);

    mine.status = 'suspended';
    assert.equal((await a.post('/api/vendor/products').send(input)).status, 403);
  }));
});

const address = { address: '1 Main St', city: 'Dhaka', postcode: '1200', country: 'Bangladesh' };
function checkoutBody(productIds, qty = 2) {
  return {
    customerName: 'Buyer', customerEmail: 'buyer@example.com', customerPhone: '01700000000', deliveryAddress: address, paymentGateway: 'cod',
    items: productIds.map((id) => ({ productId: id, quantity: qty, size: 'M' }))
  };
}
function checkoutStubs(w, log) {
  log.created = [];
  return [
    quiet,
    [Vendor, 'findOne', (f) => chain(w.vendors.find((v) => matches(v, f)) || null)],
    [Product, 'findById', async (id) => w.products.find((p) => String(p._id) === String(id)) || null],
    [Product, 'findOneAndUpdate', async () => ({})], [Product, 'updateOne', async () => ({})],
    [Order, 'create', async (d) => { log.created.push(d); return { _id: oid(), ...d }; }], [Order, 'updateOne', async () => ({})],
    [emailService, 'sendOrderConfirmation', () => Promise.resolve()],
    [SSLCommerzPayment.prototype, 'init', async () => ({ GatewayPageURL: 'https://pay.example/x' })]
  ];
}
test('checkout stores vendor and commission on each item and one fulfillment entry per vendor', async () => {
  const w = newWorld(); const log = {};
  const v1 = seedVendor(w, { commissionPercent: 15 }); const v2 = seedVendor(w, { name: 'Two', slug: 'two', commissionPercent: 5 });
  const own = seedProduct(w, null, { title: 'Store Tee', price: 100 });
  const p1 = seedProduct(w, v1, { title: 'A Tee', price: 200 }); const p2 = seedProduct(w, v2, { title: 'B Tee', price: 300 });
  await withEnv(ON, () => withStubs(checkoutStubs(w, log), async () => {
    const res = await request(app).post('/api/orders').send(checkoutBody([own._id, p1._id, p2._id]));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const order = log.created[0];
    assert.equal(order.totalAmount, 1200);                                       // (100+200+300) x 2: the buyer pays the same as before
    const byTitle = Object.fromEntries(order.items.map((i) => [i.title, i]));
    assert.equal('vendorId' in byTitle['Store Tee'], false);
    assert.equal(String(byTitle['A Tee'].vendorId), String(v1._id)); assert.equal(byTitle['A Tee'].commissionPercent, 15);
    assert.equal(String(byTitle['B Tee'].vendorId), String(v2._id)); assert.equal(byTitle['B Tee'].commissionPercent, 5);
    assert.deepEqual(order.fulfillment.map((f) => String(f.vendorId)).sort(), [String(v1._id), String(v2._id)].sort());
  }));
});
test('checkout refuses a product whose vendor is suspended, and vendor products while the marketplace is off', async () => {
  const w = newWorld(); const log = {};
  const bad = seedVendor(w, { status: 'suspended' }); const p = seedProduct(w, bad);
  await withEnv(ON, () => withStubs(checkoutStubs(w, log), async () => {
    const res = await request(app).post('/api/orders').send(checkoutBody([p._id]));
    assert.equal(res.status, 409);
    assert.deepEqual(res.body.unavailable, [String(p._id)]);
    assert.equal(log.created.length, 0);
  }));
  const good = seedVendor(w, { name: 'Good', slug: 'good' }); const q = seedProduct(w, good);
  await withEnv({ ...ON, MULTIVENDOR_ENABLED: undefined }, () => withStubs(checkoutStubs(w, log), async () => {
    assert.equal((await request(app).post('/api/orders').send(checkoutBody([q._id]))).status, 409);
  }));
});

test('earnings: per-item commission, coupons and shipping stay with the marketplace', () => {
  const v = 'v1';
  const order = { items: [
    { vendorId: v, price: 100.1, quantity: 3, commissionPercent: 10 },
    { vendorId: v, price: 50, quantity: 1, commissionPercent: 20 },
    { vendorId: 'other', price: 999, quantity: 1, commissionPercent: 0 }
  ] };
  assert.deepEqual(marketplace.vendorShare(order, v), { gross: 35030, commission: 4003, net: 31027 });
  assert.deepEqual(marketplace.vendorShare(order, 'nobody'), { gross: 0, commission: 0, net: 0 });
  assert.equal(marketplace.defaultCommission({ MARKETPLACE_COMMISSION_PERCENT: '95' }), 10);     // out of range: the safe default
  assert.equal(marketplace.defaultCommission({ MARKETPLACE_COMMISSION_PERCENT: '12.5' }), 12.5);
});

function paidOrder(w, vendor, over = {}) {
  const o = wrap({ _id: oid(), status: 'CONFIRMED', paidAt: new Date(), createdAt: new Date(), customerName: 'Buyer', customerPhone: '017', deliveryAddress: address, paymentGateway: 'cod',
    items: [{ title: 'Tee', price: 500, quantity: 2, size: 'M', vendorId: vendor._id, commissionPercent: 10 }, { title: 'Hidden Other Item', price: 70, quantity: 1, size: 'L', vendorId: oid(), commissionPercent: 10 }],
    fulfillment: [{ vendorId: vendor._id, status: 'PENDING', note: '' }], ...over });
  w.orders.push(o); return o;
}
test('a vendor sees only their own items, ships step by step, and cannot touch unpaid orders', async () => {
  const w = newWorld();
  const a = await shopper(w, 4);
  const me = seedVendor(w, { ownerUserId: w.users[0]._id }); w.users[0].vendorId = me._id;
  const order = paidOrder(w, me);
  const unpaid = paidOrder(w, me, { status: 'PENDING' });
  await withEnv(ON, () => withStubs(stubsFor(w), async () => {
    const orders = (await a.get('/api/vendor/orders')).body.orders;
    assert.equal(orders.length, 1, 'unpaid (PENDING) orders are not shown');
    assert.deepEqual(orders[0].items.map((i) => i.title), ['Tee'], 'other vendors\' items are not shown');
    assert.deepEqual(orders[0].earnings, { gross: 1000, commission: 100, net: 900 });
    assert.equal(JSON.stringify(orders[0]).includes('Hidden Other Item'), false);
    assert.equal(JSON.stringify(orders[0]).includes('buyer@example.com'), false, 'the buyer\'s email is not shared');

    const step = (id, status) => a.patch(`/api/vendor/orders/${id}/fulfillment`).send({ status, note: 'Pathao #1' });
    assert.equal((await step(order._id, 'DELIVERED')).status, 400);             // cannot skip shipping
    assert.equal((await step(order._id, 'SHIPPED')).status, 200);
    assert.equal(order.fulfillment[0].status, 'SHIPPED');
    assert.equal((await step(order._id, 'SHIPPED')).status, 400);               // no going back / repeating
    assert.equal((await step(order._id, 'DELIVERED')).status, 200);
    assert.equal((await step(unpaid._id, 'SHIPPED')).status, 409);
    assert.equal((await step(oid(), 'SHIPPED')).status, 404);
  }));
});
test('another vendor cannot ship or see my order', async () => {
  const w = newWorld();
  const b = await shopper(w, 5);
  const mine = seedVendor(w, { name: 'Other Owner', slug: 'other-owner', ownerUserId: w.users[0]._id }); w.users[0].vendorId = mine._id;
  const stranger = seedVendor(w, { name: 'Stranger', slug: 'stranger' });
  const order = paidOrder(w, stranger);
  await withEnv(ON, () => withStubs(stubsFor(w), async () => {
    assert.equal((await b.get('/api/vendor/orders')).body.orders.length, 0);
    assert.equal((await b.patch(`/api/vendor/orders/${order._id}/fulfillment`).send({ status: 'SHIPPED' })).status, 404);
    assert.equal(order.fulfillment[0].status, 'PENDING');
  }));
});

test('earnings split into pending, payable (delivered) and paid out', async () => {
  const w = newWorld();
  const v = seedVendor(w);
  paidOrder(w, v);                                                             // 900 net, not delivered
  const done = paidOrder(w, v); done.fulfillment[0].status = 'DELIVERED';      // 900 net, payable
  const paid = paidOrder(w, v); paid.fulfillment[0].status = 'DELIVERED';      // 900 net, already paid out
  paidOrder(w, v, { status: 'CANCELLED' });                                    // cancelled: earns nothing
  paidOrder(w, v, { paidAt: null });                                           // unpaid: earns nothing
  w.payouts.push(wrap({ _id: oid(), vendorId: v._id, amount: 900, orderIds: [paid._id], lineKeys: [`${v._id}:${paid._id}`], createdAt: new Date() }));
  await withStubs(stubsFor(w), async () => {
    const e = await marketplace.earningsFor(v._id);
    assert.deepEqual(e.totals, { gross: 3000, commission: 300, net: 2700, paidOut: 900, payable: 900, pending: 900, clawback: 0, payableNow: 900 });
    assert.equal(e.lines.length, 3);
  });
});

async function ownerLogin() {
  const agent = request.agent(app);
  const res = await agent.post('/admin/login').send(OWNER);
  assert.equal(res.status, 200);
  return { agent, csrf: res.body.csrfToken };
}
test('admin approves and suspends vendors, sets commission with validation, and it is audited', async () => {
  const w = newWorld(); const v = seedVendor(w, { status: 'pending', approvedAt: null });
  const o = await ownerLogin();
  await withEnv(ON, () => withStubs(stubsFor(w), async () => {
    const patch = (body) => o.agent.patch(`/admin/vendors/${v._id}`).set('X-CSRF-Token', o.csrf).send(body);
    assert.equal((await o.agent.patch(`/admin/vendors/${v._id}`).send({ status: 'approved' })).status, 403);   // CSRF needed
    assert.equal((await patch({ status: 'banned' })).status, 400);
    assert.equal((await patch({ commissionPercent: '95' })).status, 400);
    assert.equal((await patch({ commissionPercent: '-1' })).status, 400);
    assert.equal((await patch({})).status, 400);
    assert.equal((await patch({ status: 'approved', commissionPercent: '12.5' })).status, 200);
    assert.equal(v.status, 'approved'); assert.equal(v.commissionPercent, 12.5); assert.ok(v.approvedAt);
    assert.equal((await patch({ status: 'suspended' })).status, 200);
    assert.equal(v.status, 'suspended');
    assert.equal((await o.agent.get('/admin/vendors')).body[0].name, 'Urban Loom');
  }));
  await withEnv({ MULTIVENDOR_ENABLED: undefined }, async () => {
    assert.equal((await o.agent.get('/admin/vendors')).status, 404);
  });
});
test('admin vendor controls need the vendor permission', async () => {
  await Role.create({ name: 'NoVendors', permissions: ['product.view'] });
  await addAccount('novendor1', 'NoVendorPass123', ['NoVendors']);
  const agent = request.agent(app);
  const login = await agent.post('/admin/login').send({ username: 'novendor1', password: 'NoVendorPass123' });
  assert.equal(login.status, 200);
  const w = newWorld(); const v = seedVendor(w);
  await withEnv(ON, () => withStubs(stubsFor(w), async () => {
    assert.equal((await agent.get('/admin/vendors')).status, 403);
    assert.equal((await agent.patch(`/admin/vendors/${v._id}`).set('X-CSRF-Token', login.body.csrfToken).send({ status: 'approved' })).status, 403);
    assert.equal((await agent.post(`/admin/vendors/${v._id}/payouts`).set('X-CSRF-Token', login.body.csrfToken).send({})).status, 403);
  }));
});
test('payout: pays only delivered unpaid orders, once, and the database refuses a double payment', async () => {
  const w = newWorld(); const v = seedVendor(w);
  const a = paidOrder(w, v); a.fulfillment[0].status = 'DELIVERED';
  const b = paidOrder(w, v); b.fulfillment[0].status = 'DELIVERED';
  paidOrder(w, v);                                                              // not delivered yet
  const o = await ownerLogin();
  await withEnv(ON, () => withStubs(stubsFor(w), async () => {
    const pay = () => o.agent.post(`/admin/vendors/${v._id}/payouts`).set('X-CSRF-Token', o.csrf).send({ note: 'bKash 01711' });
    const first = await pay();
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.amount, 1800); assert.equal(first.body.orders, 2);
    assert.equal(w.payouts[0].paidBy.length > 0, true);
    assert.equal((await pay()).status, 400, 'nothing left to pay');
    // two admins at once: the second one passes the check but the unique key refuses it
    const original = Payout.find;
    Payout.find = () => chain([]);                                              // pretend the first payout is not visible yet
    assert.equal((await pay()).status, 409);
    Payout.find = original;
    assert.equal(w.payouts.length, 1);
  }));
});

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('the storefront, seller dashboard and admin pages contain what their scripts need', () => {
  const index = read('public/index.html');
  for (const id of ['shopGrid', 'sellCta', 'applyShopModal', 'applyShopBtn', 'navSellerLink', 'featuredProducts', 'productGrid', 'viewCartLink', 'cartCount', 'wishlistModal', 'footerYear']) {
    assert.ok(index.includes(`id="${id}"`), `index.html: #${id}`);
  }
  assert.equal((index.match(/data-category="(Men|Women|Kids)"/g) || []).length, 3, 'three category tiles');
  assert.ok(index.indexOf('src="/js/app-extras.js"') > -1 && index.indexOf('src="/js/app-extras.js"') < index.indexOf('src="/js/marketplace.js"'), 'marketplace.js loads after app-extras.js');
  assert.ok(index.includes('/css/marketplace.css'));

  const vendor = read('public/vendor.html');
  for (const id of ['vState', 'vApp', 'vProducts', 'vOrders', 'vEarnings', 'productForm', 'fImage', 'profileForm', 'addProductBtn']) assert.ok(vendor.includes(`id="${id}"`), `vendor.html: #${id}`);
  assert.ok(vendor.includes('/js/vendor.js') && vendor.includes('name="robots" content="noindex"'), 'seller pages are not indexed');
  assert.ok((vendor.match(/integrity=/g) || []).length >= 2, 'CDN files keep their integrity hashes');

  const admin = read('public/admin.html');
  for (const id of ['vendorsNavLink', 'vendors-section', 'vendorsTable', 'vendorModal']) assert.ok(admin.includes(`id="${id}"`), `admin.html: #${id}`);
});

test('the new scripts follow the page security rules and draw data safely', () => {
  for (const f of ['public/js/marketplace.js', 'public/js/vendor.js']) {
    const src = read(f);
    assert.ok(!/\son(click|error|load|change|submit)\s*=/.test(src), `${f}: no inline handlers (the CSP forbids them)`);
    assert.ok(!/localStorage|sessionStorage/.test(src) || f.includes('marketplace'), `${f}: no browser storage`);
  }
  // The seller dashboard builds elements; it must never push data through innerHTML.
  assert.equal(/innerHTML\s*=/.test(read('public/js/vendor.js')), false, 'vendor.js never uses innerHTML');
});

test('no wording from the old single-product shop is left in what ships', () => {
  const files = [];
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).forEach((e) => {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'tests' ? null : walk(rel);
    if (/\.(html|js|css|svg|md|json|yml)$/.test(e.name) && e.name !== 'package-lock.json') files.push(rel);
  });
  ['public', 'routes', 'services', 'models', 'seed', 'scripts', 'config'].forEach(walk);
  files.push('README.md', 'package.json', '.env.example', 'server.js');
  const hits = files.filter((f) => new RegExp(['jack','et'].join(''), 'i').test(read(f)));
  assert.deepEqual(hits, []);
});

test('the demo catalog is consistent: unique products, real shops, a picture for each', () => {
  const { VENDORS, PRODUCTS } = require('../seed/catalog');
  const shops = new Set(VENDORS.map((v) => v.slug));
  assert.equal(new Set(PRODUCTS.map((p) => p.slug)).size, PRODUCTS.length);
  assert.equal(new Set(PRODUCTS.map((p) => p.title)).size, PRODUCTS.length);
  for (const p of PRODUCTS) {
    assert.ok(!p.vendor || shops.has(p.vendor), `${p.slug}: unknown shop`);
    assert.ok(['Men', 'Women', 'Kids', 'Accessories'].includes(p.category), `${p.slug}: category`);
    assert.ok(p.price > 0 && p.stock >= 0, `${p.slug}: price/stock`);
    assert.ok(fs.existsSync(path.join(ROOT, 'public/img/products', `${p.slug}.svg`)), `${p.slug}: picture`);
  }
  // nothing left over from the old catalog
  const onDisk = fs.readdirSync(path.join(ROOT, 'public/img/products')).filter((f) => f.endsWith('.svg'));
  assert.equal(onDisk.length, PRODUCTS.length);
});

test('every garment shape draws, and light colours get an outline so they stay visible', () => {
  const g = require('../scripts/lib/garments');
  for (const type of Object.keys(g.SHAPES)) {
    const svg = g.productSvg({ title: `A <b>${type}</b> & more`, type, color: '#f7f7f5' });
    assert.ok(svg.startsWith('<svg') && svg.includes('stroke-opacity'), type);
    assert.ok(!svg.includes('<b>'), 'titles are escaped in the picture');
  }
  assert.throws(() => g.garment('cape', '#000000'), /Unknown garment/);
});

test('the seller page is served and kept out of search engines', async () => {
  const res = await request(app).get('/vendor.html');
  assert.equal(res.status, 200);
  assert.match(res.text, /noindex/);
});

test('a Bengali, Arabic or Hindi shop name gets a unique slug', () => {
  const names = { Bengali: 'আমার দোকান', Arabic: 'متجر الأزياء', Hindi: 'मेरी दुकान' };
  for (const [language, name] of Object.entries(names)) {
    const slugs = new Set();
    for (let i = 0; i < 25; i++) slugs.add(marketplace.slugify(name));
    assert.equal(slugs.size, 25, `${language}: 25 shops, 25 different slugs`);
    for (const slug of slugs) assert.match(slug, /^shop-[0-9a-f]{6}$/);
  }
  assert.equal(marketplace.slugify('Urban Loom!'), 'urban-loom');
  assert.equal(marketplace.slugify('Café Été'), 'cafe-ete');
  assert.ok(marketplace.slugify('a'.repeat(80)).length <= 50);
});

test('hidden vendor products do not take up room in a page of products', async () => {
  const w = newWorld();
  const bad = seedVendor(w, { name: 'Bad', slug: 'bad', status: 'suspended' });
  for (let i = 0; i < 5; i++) seedProduct(w, bad, { title: `Hidden ${i}`, createdAt: new Date(Date.now() + i) });
  for (let i = 0; i < 3; i++) seedProduct(w, null, { title: `Store ${i}`, createdAt: new Date(1000 + i) });
  await withEnv(ON, () => withStubs(stubsFor(w), async () => {
    const first = await request(app).get('/api/products?limit=2');
    assert.equal(first.body.length, 2);
    assert.equal(first.headers['x-has-more'], 'true');
    const second = await request(app).get('/api/products?limit=2&skip=2');
    assert.equal(second.body.length, 1);
    assert.equal(second.headers['x-has-more'], 'false');
  }));
  await withEnv({ MULTIVENDOR_ENABLED: undefined }, () => withStubs(stubsFor(w), async () => {
    const all = await request(app).get('/api/products?limit=3');
    assert.equal(all.body.length, 3, 'with the marketplace off only the store\'s own products are listed');
    assert.equal(all.headers['x-has-more'], 'false');
  }));
});
