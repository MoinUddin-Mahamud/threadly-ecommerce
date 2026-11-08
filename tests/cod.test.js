// Tests for Cash on Delivery: the settings, the checkout rules, stock, the
// unpaid-order expiry job leaving COD orders alone, cancelling, marking cash as
// received, permissions, emails and the storefront markup.
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
const Role = require('../models/Role');
const emailService = require('../services/emailService');
const { codSettings, isUsablePhone, checkCodOrder } = require('../services/cod');
const { cancelPendingOrder, expirePendingOrders } = require('../services/orderService');

const PRODUCT_ID = '64b7f0c2a1b2c3d4e5f60999';
const ORDER_ID = '64b7f0c2a1b2c3d4e5f60718';
const quiet = [console, 'error', () => {}];

// Replaces methods for the duration of one test and puts them back afterwards.
async function withStubs(stubs, fn) {
  const saved = stubs.map(([target, name]) => [target, name, target[name]]);
  stubs.forEach(([target, name, impl]) => { target[name] = impl; });
  try { await fn(); } finally { saved.forEach(([target, name, original]) => { target[name] = original; }); }
}

// Sets environment variables for one test (undefined removes one).
async function withEnv(vars, fn) {
  const saved = Object.keys(vars).map((k) => [k, process.env[k]]);
  Object.entries(vars).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  try { await fn(); } finally { saved.forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; }); }
}

const address = { address: '1 Main St', city: 'Dhaka', postcode: '1200', country: 'Bangladesh' };
const codBody = (extra = {}) => ({
  customerName: 'Buyer', customerEmail: 'buyer@example.com', customerPhone: '01700000000',
  deliveryAddress: address, paymentGateway: 'cod',
  items: [{ productId: PRODUCT_ID, quantity: 2, size: 'M' }], ...extra
});

// A store with plenty of stock. Records what was reserved, saved and sent.
function codStore(log = {}) {
  log.reserved = []; log.created = []; log.restocked = []; log.mails = 0; log.gatewayCalls = 0;
  return [
    quiet,
    [Product, 'findById', async () => ({ _id: PRODUCT_ID, title: 'Bomber', price: 100, stock: 50 })],
    [Product, 'findOneAndUpdate', async (f, u) => { log.reserved.push([f.stock.$gte, u.$inc.stock]); return {}; }],
    [Product, 'updateOne', async (f, u) => { log.restocked.push(u.$inc.stock); return {}; }],
    [Order, 'create', async (doc) => { log.created.push(doc); return { _id: ORDER_ID, ...doc }; }],
    [emailService, 'sendOrderConfirmation', () => { log.mails++; return Promise.resolve(); }],
    [SSLCommerzPayment.prototype, 'init', async () => { log.gatewayCalls++; return { GatewayPageURL: 'https://pay.example/x' }; }]
  ];
}

async function ownerLogin() {
  const agent = request.agent(app);
  const res = await agent.post('/admin/login').send(OWNER);
  assert.equal(res.status, 200);
  return { agent, csrf: res.body.csrfToken };
}
const markPaid = (o, id = ORDER_ID) => o.agent.put(`/admin/orders/${id}/cod-paid`).set('X-CSRF-Token', o.csrf).send({});
const setStatus = (o, status) => o.agent.put(`/admin/orders/${ORDER_ID}/status`).set('X-CSRF-Token', o.csrf).send({ status });
const codOrder = (extra = {}) => ({ _id: ORDER_ID, paymentGateway: 'cod', status: 'DELIVERED', totalAmount: 200, items: [{ productId: PRODUCT_ID, quantity: 2, size: 'M' }], ...extra });

test('Cash on Delivery is off unless COD_ENABLED is "true" (any capitalisation)', () => {
  assert.equal(codSettings({}).enabled, false);
  assert.equal(codSettings({ COD_ENABLED: 'false' }).enabled, false);
  assert.equal(codSettings({ COD_ENABLED: '1' }).enabled, false);
  assert.equal(codSettings({ COD_ENABLED: 'yes' }).enabled, false);
  assert.equal(codSettings({ COD_ENABLED: 'true' }).enabled, true);
  assert.equal(codSettings({ COD_ENABLED: ' TRUE ' }).enabled, true);
});

test('COD_MAX_AMOUNT is a positive number, and anything else means no limit', () => {
  const max = (v) => codSettings({ COD_ENABLED: 'true', COD_MAX_AMOUNT: v }).maxAmount;
  assert.equal(max('5000'), 5000);
  assert.equal(max('2500.50'), 2500.5);
  assert.equal(max(' 100 '), 100);
  for (const bad of [undefined, '', '0', '-5', 'abc', '1e9', '12.345', '999999999999']) {
    assert.equal(max(bad), null, `${bad} should mean no limit`);
  }
});

test('phone numbers: digits with common separators, at least 6 digits', () => {
  for (const ok of ['01700000000', '+880 1700-000000', '(02) 123 4567']) assert.equal(isUsablePhone(ok), true, ok);
  for (const bad of ['', '   ', '12345', 'call me', '<script>', '1'.repeat(31), null, undefined, 5551234, { $gt: '' }]) {
    assert.equal(isUsablePhone(bad), false, String(bad));
  }
});

test('checkCodOrder enforces enabled, phone, address and the maximum', () => {
  const on = { enabled: true, maxAmount: 1000 };
  const good = { phone: '01700000000', address, totalAmount: 1000 };
  assert.deepEqual(checkCodOrder(good, on), { ok: true });
  assert.match(checkCodOrder(good, { enabled: false, maxAmount: null }).message, /not available/);
  assert.match(checkCodOrder({ ...good, phone: '' }, on).message, /phone/);
  assert.match(checkCodOrder({ ...good, address: { city: 'Dhaka' } }, on).message, /delivery address/);
  assert.match(checkCodOrder({ ...good, address: { address: 'x' } }, on).message, /delivery address/);
  assert.match(checkCodOrder({ ...good, totalAmount: 1000.01 }, on).message, /up to 1000/);
  assert.deepEqual(checkCodOrder({ ...good, totalAmount: 1e9 }, { enabled: true, maxAmount: null }), { ok: true });
});

test('the Order model accepts "cod" as a payment method and still rejects others', async () => {
  const base = { customerName: 'A', customerEmail: 'a@b.com', totalAmount: 1 };
  assert.equal(await new Order({ ...base, paymentGateway: 'cod' }).validate(), undefined);
  await assert.rejects(new Order({ ...base, paymentGateway: 'bitcoin' }).validate());
});

test('/api/payment-options reports whether Cash on Delivery is on, and its limit', async () => {
  await withEnv({ COD_ENABLED: undefined, COD_MAX_AMOUNT: undefined }, async () => {
    const body = (await request(app).get('/api/payment-options')).body;
    assert.deepEqual(body.cod, { enabled: false, maxAmount: null });
    assert.equal(body.manual.enabled, false);
    assert.equal(body.sslcommerz.enabled, true);    // the test setup configures a gateway
    assert.equal(body.stripe.enabled, false);
  });
  await withEnv({ COD_ENABLED: 'true', COD_MAX_AMOUNT: '7000' }, async () => {
    assert.deepEqual((await request(app).get('/api/payment-options')).body.cod, { enabled: true, maxAmount: 7000 });
  });
});

test('a COD order is refused while COD_ENABLED is off, and takes no stock', async () => {
  const log = {};
  await withEnv({ COD_ENABLED: undefined }, async () => {
    await withStubs(codStore(log), async () => {
      const res = await request(app).post('/api/orders').send(codBody());
      assert.equal(res.status, 400);
      assert.match(res.body.message, /not available/i);
    });
  });
  assert.equal(log.reserved.length, 0);
  assert.equal(log.created.length, 0);
});

test('a COD order needs a phone number and a delivery address, and takes no stock without them', async () => {
  const log = {};
  await withEnv({ COD_ENABLED: 'true', COD_MAX_AMOUNT: undefined }, async () => {
    await withStubs(codStore(log), async () => {
      for (const [change, pattern] of [
        [{ customerPhone: '' }, /phone/i],
        [{ customerPhone: undefined }, /phone/i],
        [{ customerPhone: '12345' }, /phone/i],
        [{ deliveryAddress: undefined }, /delivery address/i],
        [{ deliveryAddress: { address: '1 Main St' } }, /delivery address/i],
        [{ deliveryAddress: { city: 'Dhaka' } }, /delivery address/i]
      ]) {
        const res = await request(app).post('/api/orders').send(codBody(change));
        assert.equal(res.status, 400, JSON.stringify(change));
        assert.match(res.body.message, pattern);
      }
    });
  });
  assert.equal(log.reserved.length, 0);
  assert.equal(log.created.length, 0);
});

test('COD_MAX_AMOUNT is checked against the total worked out on the server', async () => {
  const log = {};
  await withEnv({ COD_ENABLED: 'true', COD_MAX_AMOUNT: '150' }, async () => {
    await withStubs(codStore(log), async () => {
      // 2 x 100 = 200 is over the limit, whatever the browser claims the total is
      const over = await request(app).post('/api/orders').send(codBody({ totalAmount: 1, total: 1 }));
      assert.equal(over.status, 400);
      assert.match(over.body.message, /up to 150/);
      assert.equal(log.reserved.length, 0);

      // 1 x 100 is under it
      const ok = await request(app).post('/api/orders').send(codBody({ items: [{ productId: PRODUCT_ID, quantity: 1, size: 'M' }] }));
      assert.equal(ok.status, 200);
    });
  });
});

test('a valid COD order reserves stock, is PLACED at once, and never calls a gateway', async () => {
  const log = {};
  await withEnv({ COD_ENABLED: 'true', COD_MAX_AMOUNT: undefined }, async () => {
    await withStubs(codStore(log), async () => {
      const res = await request(app).post('/api/orders').send(codBody({ totalAmount: 1 }));
      assert.equal(res.status, 200);
      assert.equal(res.body.cod, true);
      assert.equal(res.body.paymentUrl, undefined);
      assert.equal(res.body.amount, 200);
      assert.match(res.body.transactionId, /^COD-[0-9A-Z]{24}$/);
    });
  });
  assert.deepEqual(log.reserved, [[2, -2]]);
  const saved = log.created[0];
  assert.equal(saved.paymentGateway, 'cod');
  assert.equal(saved.status, 'PLACED');
  assert.equal(saved.totalAmount, 200);            // from the database price, not the browser
  assert.equal(saved.paidAt, undefined);           // unpaid until the cash is received
  assert.ok(saved.transactionId.length <= 30);
  assert.equal(log.gatewayCalls, 0);
  assert.equal(log.mails, 1, 'the normal confirmation email is sent');
});

test('a COD order does not wait for the mail server', async () => {
  const log = {};
  await withEnv({ COD_ENABLED: 'true' }, async () => {
    await withStubs([...codStore(log), [emailService, 'sendOrderConfirmation', () => new Promise(() => {})]], async () => {
      const reply = request(app).post('/api/orders').send(codBody()).then((r) => r.status);
      const status = await Promise.race([reply, new Promise((r) => setTimeout(() => r('timed out'), 3000))]);
      assert.equal(status, 200);
    });
  });
});

test('if saving a COD order fails, the reserved stock goes back once', async () => {
  const log = {};
  await withEnv({ COD_ENABLED: 'true' }, async () => {
    await withStubs([...codStore(log), [Order, 'create', async () => { throw new Error('db down'); }]], async () => {
      const res = await request(app).post('/api/orders').send(codBody());
      assert.equal(res.status, 500);
    });
  });
  assert.deepEqual(log.restocked, [2]);
});

test('card orders are unchanged: they stay PENDING and go to the gateway', async () => {
  const log = {};
  await withEnv({ COD_ENABLED: 'true' }, async () => {
    await withStubs(codStore(log), async () => {
      const res = await request(app).post('/api/orders').send(codBody({ paymentGateway: 'sslcommerz' }));
      assert.equal(res.status, 200);
      assert.equal(res.body.paymentUrl, 'https://pay.example/x');
      assert.equal(res.body.cod, undefined);
    });
  });
  assert.equal(log.created[0].status, 'PENDING');
  assert.equal(log.created[0].paymentGateway, 'sslcommerz');
  assert.match(log.created[0].transactionId, /^TXN-/);
  assert.equal(log.mails, 0);
});

// In-memory Order collection that honours the status in a filter.
function fakeOrders(rows) {
  const matchesFilter = (row, f) => Object.entries(f).every(([k, v]) => {
    if (v && typeof v === 'object' && v.$lt) return row[k] < v.$lt;
    if (v && typeof v === 'object' && v.$ne !== undefined) return row[k] !== v.$ne;
    return row[k] === v;
  });
  return [
    [Order, 'find', (f) => ({ select() { return this; }, limit() { return this; }, lean: async () => rows.filter((r) => matchesFilter(r, f)) })],
    [Order, 'findOneAndUpdate', async (f, u) => {
      const row = rows.find((r) => matchesFilter(r, f));
      if (row) Object.assign(row, u);
      return row || null;
    }]
  ];
}

test('the expiry job cancels a stale unpaid card order but never a COD order', async () => {
  const old = new Date(Date.now() - 24 * 3600 * 1000);
  const rows = [
    { _id: 'card', status: 'PENDING', paymentGateway: 'sslcommerz', createdAt: old, items: [] },
    { _id: 'cod-unpaid', status: 'CONFIRMED', paymentGateway: 'cod', createdAt: old, items: [] },
    { _id: 'cod-delivered', status: 'DELIVERED', paymentGateway: 'cod', createdAt: old, items: [] }
  ];
  await withStubs(fakeOrders(rows), async () => {
    assert.equal(await expirePendingOrders(), 1);
  });
  assert.equal(rows[0].status, 'CANCELLED');
  assert.equal(rows[1].status, 'CONFIRMED');
  assert.equal(rows[2].status, 'DELIVERED');
});

test('a gateway "fail" or "cancel" callback carrying a COD order number does not cancel it', async () => {
  const rows = [{ _id: 'cod', transactionId: 'COD-1', status: 'CONFIRMED', paymentGateway: 'cod', items: [{ productId: 'p', quantity: 1, size: 'M' }] }];
  let restocked = 0;
  await withStubs([
    ...fakeOrders(rows),
    [Order, 'findOne', async (f) => rows.find((r) => r.transactionId === f.transactionId) || null],
    [Product, 'updateOne', async () => { restocked++; return {}; }]
  ], async () => {
    assert.equal(await cancelPendingOrder({ transactionId: 'COD-1' }), null);
    await request(app).post('/api/payment/fail').send({ tran_id: 'COD-1' });
    await request(app).post('/api/payment/cancel').send({ tran_id: 'COD-1' });
    await request(app).get('/api/payment/cancel?tran_id=COD-1');
  });
  assert.equal(rows[0].status, 'CONFIRMED');
  assert.equal(restocked, 0);
});

test('a forged gateway "success" for a COD order does not change it', async () => {
  let updated = false;
  await withStubs([
    quiet,
    [Order, 'findOne', async () => ({ _id: 'cod', transactionId: 'COD-1', status: 'CONFIRMED', paymentGateway: 'cod', totalAmount: 200 })],
    [Order, 'findOneAndUpdate', async () => { updated = true; return null; }],
    [Order, 'updateOne', async () => { updated = true; return {}; }]
  ], async () => {
    const res = await request(app).post('/api/payment/success').type('form').send({ tran_id: 'COD-1', val_id: 'v' });
    assert.match(res.headers.location, /already=true/);
  });
  assert.equal(updated, false);
});

test('cancelling a COD order returns its stock once; a second cancel does not', async () => {
  const o = await ownerLogin();
  const restocked = [];
  let filter;
  await withStubs([
    [Order, 'findById', async () => codOrder({ status: 'CONFIRMED' })],
    [Order, 'findOneAndUpdate', async (f) => { filter = f; return codOrder({ status: 'CANCELLED' }); }],
    [Product, 'updateOne', async (f, u) => { restocked.push(u.$inc.stock); return {}; }]
  ], async () => {
    assert.equal((await setStatus(o, 'CANCELLED')).status, 200);
  });
  assert.deepEqual(restocked, [2]);
  assert.deepEqual(filter.stockReleased, { $ne: true });

  // already cancelled: the conditional update matches nothing, so nothing is restocked again
  restocked.length = 0;
  await withStubs([
    [Order, 'findById', async () => codOrder({ status: 'CANCELLED', stockReleased: true })],
    [Order, 'findOneAndUpdate', async () => null],
    [Order, 'findByIdAndUpdate', async (id, u) => ({ ...codOrder(), status: u.status })],
    [Product, 'updateOne', async () => { restocked.push(1); return {}; }]
  ], async () => {
    await setStatus(o, 'CANCELLED');
  });
  assert.equal(restocked.length, 0);
});

test('a COD order goes from PLACED to SHIPPED to DELIVERED, and cancelling a delivered one keeps the stock out', async () => {
  const o = await ownerLogin();
  let restocked = 0;
  for (const [from, to] of [['PLACED', 'CONFIRMED'], ['CONFIRMED', 'SHIPPED'], ['SHIPPED', 'DELIVERED']]) {
    let update;
    await withStubs([
      [Order, 'findById', async () => codOrder({ status: from })],
      [Order, 'findOneAndUpdate', async (filter, u) => { update = u; return codOrder({ status: u.$set.status }); }]
    ], async () => {
      const res = await setStatus(o, to);
      assert.equal(res.status, 200);
      assert.equal(res.body.status, to);
    });
    assert.deepEqual(update, { $set: { status: to } });
  }
  await withStubs([
    [Order, 'findById', async () => codOrder({ status: 'DELIVERED' })],
    [Order, 'findOneAndUpdate', (() => { let n = 0; return async () => (n++ === 0 ? null : codOrder({ status: 'CANCELLED' })); })()],   // 1st: not restockable; 2nd: plain cancel
    [Product, 'updateOne', async () => { restocked++; return {}; }]
  ], async () => {
    assert.equal((await setStatus(o, 'CANCELLED')).status, 200);
  });
  assert.equal(restocked, 0);
});

test('reopening a cancelled COD order takes its stock again', async () => {
  const o = await ownerLogin();
  const taken = [];
  await withStubs([
    [Order, 'findById', async () => codOrder({ status: 'CANCELLED', stockReleased: true })],
    [Product, 'findOneAndUpdate', async (f, u) => { taken.push(u.$inc.stock); return {}; }],
    [Order, 'findOneAndUpdate', async () => codOrder({ status: 'PLACED' })]
  ], async () => {
    assert.equal((await setStatus(o, 'PLACED')).status, 200);
  });
  assert.deepEqual(taken, [-2]);
});

test('a delivered COD order can be marked paid, with one conditional update', async () => {
  const o = await ownerLogin();
  let filter, update;
  await withStubs([
    [Order, 'findById', async () => codOrder()],
    [Order, 'findOneAndUpdate', async (f, u) => { filter = f; update = u; return codOrder({ paidAt: update.$set.paidAt }); }]
  ], async () => {
    const res = await markPaid(o);
    assert.equal(res.status, 200);
    assert.ok(res.body.paidAt);
  });
  assert.equal(filter.paymentGateway, 'cod');
  assert.equal(filter.status, 'DELIVERED');
  assert.equal(filter.paidAt, null);              // matches only while still unpaid
  assert.ok(update.$set.paidAt instanceof Date);
});

test('marking paid is refused for non-COD, undelivered, already paid and missing orders', async () => {
  const o = await ownerLogin();
  let wrote = false;
  const noWrite = [Order, 'findOneAndUpdate', async () => { wrote = true; return null; }];
  const cases = [
    [codOrder({ paymentGateway: 'sslcommerz' }), 400, /Cash on Delivery orders/],
    [codOrder({ status: 'CONFIRMED' }), 409, /DELIVERED first/],
    [codOrder({ status: 'SHIPPED' }), 409, /DELIVERED first/],
    [codOrder({ status: 'CANCELLED' }), 409, /DELIVERED first/],
    [codOrder({ paidAt: new Date() }), 409, /already marked as paid/]
  ];
  for (const [existing, status, pattern] of cases) {
    await withStubs([[Order, 'findById', async () => existing], noWrite], async () => {
      const res = await markPaid(o);
      assert.equal(res.status, status);
      assert.match(res.body.message, pattern);
    });
  }
  await withStubs([[Order, 'findById', async () => null], noWrite], async () => {
    assert.equal((await markPaid(o)).status, 404);
  });
  assert.equal((await markPaid(o, 'not-an-id')).status, 400);
  assert.equal(wrote, false);
});

test('two clicks on "mark paid": the second loses the race and gets a 409', async () => {
  const o = await ownerLogin();
  await withStubs([
    [Order, 'findById', async () => codOrder()],
    [Order, 'findOneAndUpdate', async () => null]    // someone else already changed it
  ], async () => {
    assert.equal((await markPaid(o)).status, 409);
  });
});

test('marking paid needs login, a CSRF token and the order.edit permission', async () => {
  resetData();
  assert.equal((await request(app).put(`/admin/orders/${ORDER_ID}/cod-paid`).send({})).status, 401);

  const o = await ownerLogin();
  assert.equal((await o.agent.put(`/admin/orders/${ORDER_ID}/cod-paid`).send({})).status, 403);   // no CSRF token

  await Role.create({ name: 'Viewer', permissions: ['order.view', 'order.details'] });
  await addAccount('viewer', 'ViewerPass123', ['Viewer']);
  const agent = request.agent(app);
  const login = await agent.post('/admin/login').send({ username: 'viewer', password: 'ViewerPass123' });
  assert.equal(login.status, 200);
  let wrote = false;
  await withStubs([
    [Order, 'findById', async () => codOrder()],
    [Order, 'findOneAndUpdate', async () => { wrote = true; return codOrder(); }]
  ], async () => {
    const res = await agent.put(`/admin/orders/${ORDER_ID}/cod-paid`).set('X-CSRF-Token', login.body.csrfToken).send({});
    assert.equal(res.status, 403);
  });
  assert.equal(wrote, false);

  // The built-in Staff role has order.edit, so it can record cash
  const staff = request.agent(app);
  const staffLogin = await staff.post('/admin/login').send({ username: 'helper', password: 'StaffPass123' });
  await withStubs([
    [Order, 'findById', async () => codOrder()],
    [Order, 'findOneAndUpdate', async () => codOrder({ paidAt: new Date() })]
  ], async () => {
    const res = await staff.put(`/admin/orders/${ORDER_ID}/cod-paid`).set('X-CSRF-Token', staffLogin.body.csrfToken).send({});
    assert.equal(res.status, 200);
  });
});

process.env.EMAIL_HOST = 'smtp.test';
process.env.EMAIL_USER = 'shop@test.example';
process.env.EMAIL_PASS = 'secret';

async function captureMail(order) {
  const sent = [];
  // emailService keeps its mail connection after first use, so load a fresh copy
  delete require.cache[require.resolve('../services/emailService')];
  await withStubs([[nodemailer, 'createTransport', () => ({ sendMail: async (m) => { sent.push(m); } })]], async () => {
    await require('../services/emailService').sendOrderConfirmation(order);
  });
  return sent[0];
}
const mailOrder = (extra) => ({
  _id: 'o1', customerName: '<b>Eve</b>', customerEmail: 'a@b.com', status: 'CONFIRMED', totalAmount: 250.5, createdAt: new Date(),
  items: [{ title: 'Bomber', quantity: 1, price: 250.5 }], ...extra
});

test('the COD confirmation email says how much to pay in cash, and still escapes customer text', async () => {
  const mail = await captureMail(mailOrder({ paymentGateway: 'cod' }));
  assert.match(mail.html, /Cash on Delivery/);
  assert.match(mail.html, /250\.50<\/strong> in cash/);
  assert.ok(!mail.html.includes('<b>Eve</b>') && mail.html.includes('&lt;b&gt;Eve&lt;/b&gt;'));
});

test('the confirmation email for a card order has no cash note', async () => {
  const mail = await captureMail(mailOrder({ paymentGateway: 'sslcommerz' }));
  assert.ok(!/Cash on Delivery/.test(mail.html));
});

const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

test('the checkout form has a hidden-until-enabled COD option and the success page has a COD message', () => {
  const index = pub('index.html');
  assert.match(index, /id="gatewayCod"[^>]*value="cod"[^>]*disabled/);
  assert.match(index, /<label[^>]*d-none[^>]*for="gatewayCod"/);
  const success = pub('js/payment-success.js');
  assert.match(success, /\/api\/payment\/status\?tran_id=/);   // what the page says comes from the server
  assert.match(success, /order\.gateway === 'cod'/);
  assert.match(success, /pay the amount below in cash/);
});

test('the admin pages show the COD badges and the mark-paid button, hidden without order.edit', () => {
  const js = pub('js/admin.js');
  assert.match(js, /COD \/ unpaid/);
  assert.match(js, /COD \/ paid/);
  assert.match(js, /\/cod-paid/);
  assert.match(pub('admin.html'), /body:not\(\.can-order-edit\) \.cod-paid-btn/);
});

test('revenue counts an order once it is paid and not cancelled (COD: after the cash arrives)', () => {
  // admin.js runs in the browser; load just its revenue rule
  const src = pub('js/admin.js');
  const body = src.slice(src.indexOf('function countsAsRevenue'), src.indexOf('function loadRevenue'));
  const { countsAsRevenue } = new Function(`${body}; return { countsAsRevenue };`)();
  const calcRevenue = (orders) => orders.reduce((sum, o) => sum + (countsAsRevenue(o) ? o.totalAmount : 0), 0);
  const orders = [
    { status: 'DELIVERED', paymentGateway: 'sslcommerz', totalAmount: 100, paidAt: '2026-01-01' },
    { status: 'DELIVERED', paymentGateway: 'cod', totalAmount: 200 },                         // cash not recorded yet
    { status: 'DELIVERED', paymentGateway: 'cod', totalAmount: 400, paidAt: '2026-01-01' },   // cash received
    { status: 'CONFIRMED', paymentGateway: 'cod', totalAmount: 800 },
    { status: 'CANCELLED', paymentGateway: 'cod', totalAmount: 1600, paidAt: '2026-01-01' }
  ];
  assert.equal(calcRevenue(orders), 500);
});
