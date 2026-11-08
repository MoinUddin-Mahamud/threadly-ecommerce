// Currency decimals, card amounts, payout hold, session and log security.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const bcrypt = require('bcrypt');
const request = require('supertest');
const { app, OWNER } = require('./helpers');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const intl = require('../services/intlGateways');
const marketplace = require('../services/marketplace');
const { redactUrl } = require('../services/logRedact');
const { corsOrigin, parseOrigins } = require('../services/origins');
const { passwordProblem } = require('../services/passwordRules');
const { endUserSessions } = require('../services/sessions');
const { currencyExponent } = require('../services/paymentConfig');
const api = require('../routes/api');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
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
async function withFetch(replies, fn) {
  const calls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body });
    const hit = replies.find(([m]) => String(url).includes(m));
    if (!hit) throw new Error(`unexpected request to ${url}`);
    const [, status, body] = hit;
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  };
  try { await fn(calls); } finally { globalThis.fetch = saved; }
}
const chain = (rows) => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => rows, then: (res, rej) => Promise.resolve(rows).then(res, rej) });

test('currencies have the right number of decimals', () => {
  for (const c of ['JPY', 'KRW', 'VND', 'CLP', 'XOF']) assert.equal(currencyExponent(c), 0, c);
  for (const c of ['KWD', 'BHD', 'JOD', 'OMR', 'TND']) assert.equal(currencyExponent(c), 3, c);
  for (const c of ['USD', 'EUR', 'BDT', 'INR', 'XXX', '', undefined]) assert.equal(currencyExponent(c), 2, String(c));
  assert.equal(currencyExponent('jpy'), 0, 'lower case works too');
});

test('amounts sent to the card gateways: whole units for JPY, thousandths for KWD, hundredths for the rest', () => {
  assert.equal(intl.toMinorUnits(1000, { CURRENCY_CODE: 'JPY' }), 1000, 'not 100000');
  assert.equal(intl.toMinorUnits(12.34, { CURRENCY_CODE: 'USD' }), 1234);
  assert.equal(intl.toMinorUnits(1.234, { CURRENCY_CODE: 'KWD' }), 1230, 'Stripe wants three-decimal amounts to end in 0');
  assert.equal(intl.toMinorUnits(5, { CURRENCY_CODE: 'KWD' }), 5000);
  assert.equal(intl.toMinorUnits(100, { CURRENCY_CODE: 'XXX', CARD_CURRENCY: 'JPY', CARD_RATE: '1.5' }), 150, 'the CARD currency decides, with the rate applied first');
  assert.equal(intl.toMinorUnits(100, { CURRENCY_CODE: 'XXX', CARD_CURRENCY: 'USD', CARD_RATE: '0.0085' }), 85);
});

test('decimal strings for PayPal, Flutterwave and Mollie follow the currency, and read back the same', () => {
  assert.equal(intl.minorToDecimal(1000, 'JPY'), '1000');
  assert.equal(intl.minorToDecimal(1234, 'USD'), '12.34');
  assert.equal(intl.minorToDecimal(1230, 'KWD'), '1.230');
  assert.equal(intl.minorToDecimal(1234), '12.34', 'no currency given keeps the old two-decimal behaviour');
  assert.equal(intl.decimalToMinor('1000', 'JPY'), 1000);
  assert.equal(intl.decimalToMinor('12.34', 'USD'), 1234);
  assert.equal(intl.decimalToMinor('1.230', 'KWD'), 1230);
  assert.ok(Number.isNaN(intl.decimalToMinor('abc', 'JPY')));
  for (const [minor, cur] of [[1000, 'JPY'], [1234, 'USD'], [1230, 'KWD'], [50, 'JPY'], [5, 'USD']]) {
    assert.equal(intl.decimalToMinor(intl.minorToDecimal(minor, cur), cur), minor, `${cur} ${minor}`);
  }
});

test('a captured PayPal payment in JPY is read as whole units (the amount check on return)', () => {
  const read1 = intl.readPaypalOrder({ id: 'O1', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'C1', status: 'COMPLETED', amount: { value: '1000', currency_code: 'JPY' } }] } }] });
  assert.equal(read1.amountMinor, 1000);
  assert.equal(read1.currency, 'JPY');
});

test('the smallest card charge is 50 minor units, 500 for three-decimal currencies', () => {
  assert.equal(intl.minChargeMinor('USD'), 50);
  assert.equal(intl.minChargeMinor('JPY'), 50);
  assert.equal(intl.minChargeMinor('KWD'), 500);
});

test('a PayPal, Flutterwave and Mollie checkout in JPY sends and stores whole units', async () => {
  const PRODUCT_ID = '64b7f0c2a1b2c3d4e5f60999';
  const ORDER_ID = '64b7f0c2a1b2c3d4e5f60718';
  const replies = {
    paypal: [['/v1/oauth2/token', 200, { access_token: 'T' }], ['/v2/checkout/orders', 201, { id: 'PP1', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=PP1' }] }]],
    flutterwave: [['/v3/payments', 200, { status: 'success', data: { link: 'https://checkout.flutterwave.com/v3/hosted/pay/flwlnk-1' } }]],
    mollie: [['/v2/payments', 201, { id: 'tr_test123', _links: { checkout: { href: 'https://www.mollie.com/checkout/test123' } } }]]
  };
  const keys = {
    paypal: { PAYPAL_CLIENT_ID: 'client-id-123', PAYPAL_CLIENT_SECRET: 'secret-456' },
    flutterwave: { FLUTTERWAVE_SECRET_KEY: 'FLWSECK_TEST-abc123' },
    mollie: { MOLLIE_API_KEY: 'test_abcdefghijklmnopqrstuvwxyz1234' }
  };
  const none = { PAYPAL_CLIENT_ID: undefined, PAYPAL_CLIENT_SECRET: undefined, FLUTTERWAVE_SECRET_KEY: undefined, FLUTTERWAVE_WEBHOOK_HASH: undefined, MOLLIE_API_KEY: undefined };
  for (const g of ['paypal', 'flutterwave', 'mollie']) {
    const created = [];
    await withEnv({ ...none, ...keys[g], CURRENCY_CODE: 'JPY', CARD_CURRENCY: undefined, CARD_RATE: undefined, MIN_ORDER_TOTAL: '0' }, () => withStubs([
      quiet,
      [Product, 'findById', async () => ({ _id: PRODUCT_ID, title: 'Bomber', price: 1000, stock: 50 })],
      [Product, 'findOneAndUpdate', async () => ({})],
      [Product, 'updateOne', async () => ({})],
      [Order, 'create', async (doc) => { created.push(doc); return { _id: ORDER_ID, ...doc }; }],
      [Order, 'updateOne', async () => ({})]
    ], () => withFetch(replies[g], async (calls) => {
      const res = await request(app).post('/api/orders').send({
        customerName: 'Buyer', customerEmail: 'buyer@example.com', customerPhone: '01700000000', paymentGateway: g,
        deliveryAddress: { address: '1 Main St', city: 'Tokyo', postcode: '1000001', country: 'Japan' },
        items: [{ productId: PRODUCT_ID, quantity: 1, size: 'M' }]
      });
      assert.equal(res.status, 200, `${g}: ${JSON.stringify(res.body)}`);
      assert.equal(created[0].gatewayCurrency, 'JPY', g);
      assert.equal(created[0].gatewayAmountMinor, Math.round(created[0].totalAmount), `${g}: JPY has no minor unit, so the stored amount is the total itself`);
      const sent = calls.map((c) => String(c.body || '')).join('\n');
      assert.doesNotMatch(sent, /1000\.00|100000/, `${g} must not send decimals or hundredths for JPY`);
      if (g === 'paypal') assert.match(sent, /"value":"1000"/);
      if (g === 'mollie') assert.match(sent, /"value":"1000"/);
      if (g === 'flutterwave') assert.match(sent, /"amount":1000[,}]/);
    })));
  }
});

test('the payout hold defaults to 7 days and is documented as such', () => {
  assert.equal(marketplace.payoutHoldDays({}), 7);
  assert.match(read('.env.example'), /^# PAYOUT_HOLD_DAYS=7$/m);
  assert.match(read('README.md'), /PAYOUT_HOLD_DAYS/);
});

test('revenue: what sellers keep on cancelled orders is its own line and is taken off the store revenue', async () => {
  const sold = { _id: 'a2', totalAmount: 1000, shippingAmount: 0, discountAmount: 0, items: [{ price: 1000, quantity: 1, vendorId: 'v1', commissionPercent: 10 }] };
  const keptOrder = { _id: 'a1', status: 'CANCELLED', paidAt: new Date(), keptVendorIds: ['v1'], items: [{ price: 500, quantity: 1, vendorId: 'v1', commissionPercent: 10 }] };
  await withStubs([[Order, 'find', (q) => chain(q && q.status === 'CANCELLED' ? [keptOrder] : [sold])]], async () => {
    const r = await marketplace.revenueBreakdown();
    assert.equal(r.vendorShare, 900);
    assert.equal(r.keptEarningsCost, 450, 'the seller keeps 500 minus 10% commission');
    assert.equal(r.storeRevenue, 100 - 450, 'store revenue = 1000 - 900 - 450');
  });
});

test('revenue is unchanged without kept earnings, and the admin table shows the extra line only when there is one', async () => {
  const sold = { _id: 'a2', totalAmount: 1000, shippingAmount: 0, discountAmount: 0, items: [{ price: 1000, quantity: 1, vendorId: 'v1', commissionPercent: 10 }] };
  await withStubs([[Order, 'find', (q) => chain(q && q.status === 'CANCELLED' ? [] : [sold])]], async () => {
    const r = await marketplace.revenueBreakdown();
    assert.equal(r.keptEarningsCost, 0);
    assert.equal(r.storeRevenue, 100);
  });
  assert.match(read('public/js/admin.js'), /revenue\.keptEarningsCost/);
});

test('the revenue endpoint sums rounded minor units', async () => {
  const agent = request.agent(app);
  assert.equal((await agent.post('/admin/login').send(OWNER)).status, 200);
  let pipeline;
  await withStubs([[Order, 'aggregate', async (p) => { pipeline = p; return [{ _id: null, totalRevenue: 250000, orderCount: 3 }]; }]], async () => {
    const res = await agent.get('/admin/revenue');
    assert.equal(res.status, 200);
    assert.equal(res.body.totalRevenue, 2500);
  });
  assert.match(JSON.stringify(pipeline), /\$round/);
});

test('the revenue endpoint multiplies by the minor unit of the shop currency', async () => {
  const agent = request.agent(app);
  assert.equal((await agent.post('/admin/login').send(OWNER)).status, 200);
  for (const [code, unit] of [[undefined, 100], ['USD', 100], ['JPY', 1], ['KWD', 1000]]) {
    await withEnv({ CURRENCY_CODE: code }, async () => {
      let pipeline;
      await withStubs([[Order, 'aggregate', async (p) => { pipeline = p; return [{ _id: null, totalRevenue: 1000 * unit, orderCount: 1 }]; }]], async () => {
        const res = await agent.get('/admin/revenue');
        assert.equal(res.status, 200);
        assert.equal(res.body.totalRevenue, 1000, `one paid order of 1000 in ${code || 'the default currency'}`);
      });
      assert.match(JSON.stringify(pipeline), new RegExp(`"\\$multiply":\\["\\$totalAmount",${unit}\\]`));
    });
  }
});

test('the stats endpoint multiplies by the minor unit of the shop currency', async () => {
  const agent = request.agent(app);
  assert.equal((await agent.post('/admin/login').send(OWNER)).status, 200);
  for (const [code, unit] of [[undefined, 100], ['USD', 100], ['JPY', 1], ['KWD', 1000]]) {
    await withEnv({ CURRENCY_CODE: code }, async () => {
      const pipelines = [];
      await withStubs([
        [Order, 'aggregate', async (p) => { pipelines.push(p); return JSON.stringify(p).includes('$multiply') ? [{ _id: null, minor: 1000 * unit, count: 1 }] : []; }],
        [Product, 'countDocuments', async () => 0]
      ], async () => {
        const res = await agent.get('/admin/stats');
        assert.equal(res.status, 200);
        assert.equal(res.body.totalRevenue, 1000, `one paid order of 1000 in ${code || 'the default currency'}`);
      });
      assert.match(JSON.stringify(pipelines), new RegExp(`"\\$multiply":\\["\\$totalAmount",${unit}\\]`));
    });
  }
});

test('MIN_ORDER_TOTAL is described as a number in your own currency and defaults to no minimum', () => {
  assert.match(read('.env.example'), /MIN_ORDER_TOTAL[\s\S]{0,400}YOUR currency|YOUR currency[\s\S]{0,400}MIN_ORDER_TOTAL/);
  assert.match(read('README.md'), /own currency/i);
  assert.match(read('.env.example'), /# MIN_ORDER_TOTAL=0/);
  assert.match(read('.env.example'), /\nSHIPPING_FLAT_RATE=0\n/);
});

test('the access log blanks reset tokens, transaction ids and the older secret names', () => {
  const secret = 'a'.repeat(64);
  for (const url of [
    `/?resetToken=${secret}`, `/api/users/verify-email?token=${secret}`, `/api/payment/cancel?tran_id=TXN-${secret}`,
    `/api/payment/stripe-success?session_id=cs_live_${secret}`, `/x?tx_ref=${secret}`, `/x?api_key=${secret}`,
    `/x?a=1&PASSWORD=${secret}&b=2`, `/api/payment/paypal-return?token=${secret}&PayerID=Z`
  ]) {
    const out = redactUrl(url);
    assert.ok(!out.includes(secret) && !out.includes('cs_live_') && !out.includes('TXN-'), `${url} -> ${out}`);
    assert.match(out, /\[redacted\]/);
  }
  assert.equal(redactUrl('/api/products?category=Men&page=2'), '/api/products?category=Men&page=2', 'ordinary parameters stay readable');
  assert.equal(redactUrl('/x?a=1&b=2'), '/x?a=1&b=2');
  assert.equal(redactUrl(undefined), '');
  assert.match(read('server.js'), /redactUrl\(req\.originalUrl/);
});

test('the password reset link puts its token after a # and the page reads it there (old ? links still work)', async () => {
  const links = [];
  await withStubs([
    [require('../services/emailService'), 'sendPasswordResetEmail', async (u, l) => { links.push(l); return false; }],
    [User, 'findOne', async () => ({ _id: '64b7f0c2a1b2c3d4e5f60aaa', name: 'Buyer', email: 'buyer@example.com' })],
    [User, 'updateOne', async () => ({})]
  ], async () => {
    const res = await request(app).post('/api/users/forgot-password').send({ email: 'buyer@example.com' });
    assert.equal(res.status, 200);
  });
  const link = links[0];
  assert.ok(link, 'the link was produced');
  assert.match(link, /\/#resetToken=[a-f0-9]{64}$/);
  assert.doesNotMatch(link, /\?resetToken=/);
  const page = read('public/js/app-extras.js');
  assert.match(page, /window\.location\.hash/);
  assert.match(page, /params\.get\('resetToken'\)/, 'the older link form is still accepted');
});

const USER_ID = '64b7f0c2a1b2c3d4e5f60aaa';
async function registerAgent() {
  const agent = request.agent(app);
  let res;
  await withStubs([
    quiet, [console, 'log', () => {}],
    [User, 'findOne', async () => null],
    [User, 'create', async (doc) => ({ _id: USER_ID, name: doc.name, email: doc.email })]
  ], async () => { res = await agent.post('/api/users/register').send({ name: 'Buyer One', email: 'buyer@example.com', password: 'LongEnough123' }); });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return agent;
}
// A page only a logged-in customer can open, with the database stubbed.
async function probe(agent) {
  let status;
  await withStubs([
    [User, 'findById', async () => ({ _id: USER_ID, email: 'buyer@example.com', emailVerified: false })],
    [Order, 'find', () => ({ sort: () => ({ skip: () => ({ limit: async () => [] }) }) })],
    [Order, 'countDocuments', async () => 0]
  ], async () => { status = (await agent.get('/api/users/my-orders')).status; });
  return status;
}

test('changing the password logs the customer out everywhere else but keeps this device logged in', async () => {
  const here = await registerAgent();
  const elsewhere = await registerAgent();
  assert.equal(await probe(here), 200);
  assert.equal(await probe(elsewhere), 200);
  const user = { _id: USER_ID, comparePassword: async () => true, save: async () => {} };
  await withStubs([quiet, [User, 'findById', () => ({ select: async () => user })]], async () => {
    const res = await here.post('/api/users/change-password').send({ currentPassword: 'LongEnough123', newPassword: 'AnotherLong456' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });
  assert.equal(await probe(here), 200, 'this device stays logged in');
  assert.equal(await probe(elsewhere), 401, 'the other device is logged out');
});

test('resetting the password logs the customer out of every device', async () => {
  const a = await registerAgent();
  assert.equal(await probe(a), 200);
  const user = { _id: USER_ID, save: async () => {} };
  await withStubs([quiet, [User, 'findOneAndUpdate', () => ({ select: async () => user })]], async () => {
    const res = await request(app).post('/api/users/reset-password').send({ token: 'f'.repeat(64), password: 'BrandNew12345' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });
  assert.equal(await probe(a), 401);
});

test('endUserSessions works on the MongoDB session store as well (one delete, never the current session)', async () => {
  const calls = [];
  const store = { collectionP: Promise.resolve({ deleteMany: async (f) => { calls.push(f); return { deletedCount: 2 }; } }) };
  assert.equal(await endUserSessions(store, USER_ID, 'keep-me'), 2);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]._id, { $ne: 'keep-me' });
  assert.equal(calls[0].$or[0].session.$regex, `"userId":"${USER_ID}"`, 'finds the id inside the stored session text');
  assert.equal(await endUserSessions(store, 'not-an-id'), 0, 'anything that is not an id is ignored');
  assert.equal(calls.length, 1);
  assert.equal(await endUserSessions({ collectionP: Promise.reject(new Error('db down')) }, USER_ID), 0, 'a failure never blocks the password change');
});

test('logging in with an unknown email still runs a password comparison', async () => {
  const seen = [];
  const realCompare = bcrypt.compare;
  bcrypt.compare = async (pw, hash) => { seen.push(hash); return false; };
  try {
    await withStubs([[User, 'findOne', () => ({ select: async () => null })]], async () => {
      const res = await request(app).post('/api/users/login').send({ email: 'nobody@example.com', password: 'whatever123' });
      assert.equal(res.status, 401);
      assert.equal(res.body.message, 'Invalid email or password.', 'same answer as for a wrong password');
    });
  } finally { bcrypt.compare = realCompare; }
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^\$2[aby]\$12\$/, 'a real cost-12 hash, so it takes as long as a real account');
});

test('passwords that are one repeated character or very common are refused everywhere', async () => {
  assert.match(passwordProblem('aaaaaaaa'), /repeated/);
  assert.match(passwordProblem('00000000000'), /repeated/);
  assert.match(passwordProblem('12345678'), /too common/);
  assert.match(passwordProblem('PassWord123'), /too common/, 'the list ignores case');
  assert.equal(passwordProblem('blue-Kettle-42'), null);
  const agent = request.agent(app);
  const login = await agent.post('/admin/login').send(OWNER);
  const staff = await agent.post('/admin/staff').set('X-CSRF-Token', login.body.csrfToken).send({ username: 'weakhelper', password: 'qwerty123', roles: ['Staff'] });
  assert.equal(staff.status, 400);
  assert.match(staff.body.message, /too common/);
  const customer = await request(app).post('/api/users/register').send({ name: 'Buyer', email: 'weak@example.com', password: 'zzzzzzzzzz' });
  assert.equal(customer.status, 400);
  assert.match(customer.body.message, /repeated/);
});

test('staff passwords follow the same rule as customers (8 characters, at most 72 bytes)', async () => {
  assert.equal(passwordProblem('blue-Kettle-42'), null);
  assert.match(passwordProblem('short'), /at least 8/);
  assert.match(passwordProblem('x'.repeat(73)), /72 bytes/);
  assert.match(passwordProblem('é'.repeat(37)), /72 bytes/, 'bytes, not characters');
  const agent = request.agent(app);
  const login = await agent.post('/admin/login').send(OWNER);
  assert.equal(login.status, 200);
  for (const [password, expected] of [['short', /at least 8/], ['x'.repeat(80), /72 bytes/]]) {
    const res = await agent.post('/admin/staff').set('X-CSRF-Token', login.body.csrfToken).send({ username: 'newhelper', password, roles: ['Staff'] });
    assert.equal(res.status, 400, password.slice(0, 10));
    assert.match(res.body.message, expected);
  }
});

test('ALLOWED_ORIGIN may be a comma separated list for CORS and Socket.IO', () => {
  assert.deepEqual(parseOrigins(' https://a.com/ , https://www.a.com,, '), ['https://a.com', 'https://www.a.com']);
  assert.equal(corsOrigin(true, 'https://a.com'), 'https://a.com');
  assert.deepEqual(corsOrigin(true, 'https://a.com,https://www.a.com'), ['https://a.com', 'https://www.a.com']);
  assert.equal(corsOrigin(true, ''), false, 'production with nothing set allows no other site');
  assert.equal(corsOrigin(true, undefined), false);
  assert.equal(corsOrigin(false, 'https://a.com'), '*', 'development stays open');
  const server = read('server.js');
  assert.equal((server.match(/corsOrigin\(isProduction, process\.env\.ALLOWED_ORIGIN\)/g) || []).length, 2, 'CORS and Socket.IO both use it');
});

test('a chat message that never reached the AI gives its slot back', () => {
  const env = { CHAT_DAILY_LIMIT: '2' };
  const day = new Date('2031-05-05T10:00:00Z');
  assert.equal(api.takeChatBudget(day, env), true);
  assert.equal(api.takeChatBudget(day, env), true);
  assert.equal(api.takeChatBudget(day, env), false, 'the limit is reached');
  api.refundChatBudget();
  assert.equal(api.takeChatBudget(day, env), true, 'one slot came back');
  assert.equal(api.takeChatBudget(day, env), false);
  assert.match(read('routes/api.js'), /if \(budgetTaken\) refundChatBudget\(\);/);
});

test('prices are shown with the decimals of the shop currency (0, 2 or 3), as a number only', () => {
  const { displayDecimals } = require('../services/paymentConfig');
  const { fixedAmount } = require('../services/money');
  assert.equal(displayDecimals({ CURRENCY_CODE: 'JPY' }), 0);
  assert.equal(displayDecimals({ CURRENCY_CODE: 'KWD' }), 3);
  assert.equal(displayDecimals({ CURRENCY_CODE: 'USD' }), 2);
  assert.equal(displayDecimals({}), 2);
  assert.equal(fixedAmount(1200, { CURRENCY_CODE: 'JPY' }), '1200');
  assert.equal(fixedAmount(12.5, { CURRENCY_CODE: 'KWD' }), '12.500');
  assert.equal(fixedAmount('x', { CURRENCY_CODE: 'USD' }), '0.00');
});

test('/api/site-info tells the pages how many decimals prices use, and the pages use it', async () => {
  const request = require('supertest');
  const { app } = require('./helpers');
  const res = await request(app).get('/api/site-info');
  assert.equal(res.status, 200);
  assert.equal(res.body.currencyDecimals, 2);
  const brand = read('public/js/brand.js');
  assert.match(brand, /window\.TLMoney/);
  for (const f of ['public/js/app.js', 'public/js/vendor.js', 'public/js/payment-success.js']) assert.match(read(f), /TLMoney/, f);
  assert.doesNotMatch(read('public/js/admin.js'), /toFixed\(2\)/);
  assert.doesNotMatch(read('services/emailService.js'), /toFixed\(2\)/);
});

test('the admin price and coupon inputs step by the smallest unit of the shop currency', () => {
  const m = read('public/js/admin.js').match(/function applyMoneySteps\(\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'applyMoneySteps is in admin.js');
  const run = (decimals, type) => {
    const attrs = {};
    const $ = (sel) => ({
      attr(a, b) { sel.split(', ').forEach((id) => { attrs[id] = { ...attrs[id], ...(typeof a === 'string' ? { [a]: b } : a) }; }); return this; },
      val: () => type
    });
    const sandbox = { $, TLMoney: { decimals: () => decimals } };
    vm.createContext(sandbox);
    vm.runInContext(`${m[0]}\napplyMoneySteps();`, sandbox);
    return JSON.parse(JSON.stringify(attrs));
  };
  for (const [decimals, step] of [[0, '1'], [2, '0.01'], [3, '0.001']]) {
    const a = run(decimals, 'fixed');
    for (const id of ['#price', '#editPrice', '#couponMinOrder']) assert.equal(a[id].step, step, `${decimals}: ${id}`);
    assert.deepEqual(a['#couponMaxDiscount'], { step, min: step }, `${decimals}: the smallest discount is one unit`);
    assert.deepEqual(a['#couponValue'], { step, min: step }, `${decimals}: a fixed coupon`);
    assert.deepEqual(run(decimals, 'percent')['#couponValue'], { step: '0.01', min: '0.01' }, `${decimals}: a percentage keeps 2 decimals`);
  }
  assert.match(read('public/js/vendor.js'), /\$\('fPrice'\)\.placeholder = window\.TLMoney \? window\.TLMoney\.fixed\(999\)/);
});

test('with a card currency of its own, /api/site-info and /api/payment-options say what the gateway page charges', async () => {
  const none = await request(app).get('/api/payment-options?total=100.00');
  assert.equal(none.body.card, undefined, 'same currency: nothing to explain');
  assert.equal((await request(app).get('/api/site-info')).body.cardCurrency, process.env.CURRENCY_CODE, 'the price currency unless CARD_CURRENCY is set');
  await withEnv({ CURRENCY_CODE: 'BDT', CARD_CURRENCY: 'USD', CARD_RATE: '0.0085' }, async () => {
    assert.equal((await request(app).get('/api/site-info')).body.cardCurrency, 'USD');
    const res = await request(app).get('/api/payment-options?total=1000.00');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.card, { currency: 'USD', amounts: { stripe: '8.50', paypal: '8.50', flutterwave: '8.50', mollie: '8.50' } });
    assert.doesNotMatch(JSON.stringify(res.body), /0\.0085/, 'the rate is not sent');
    assert.deepEqual((await request(app).get('/api/payment-options?total=abc')).body.card, { currency: 'USD' });
  });
  await withEnv({ CURRENCY_CODE: 'BDT', CARD_CURRENCY: 'JPY', CARD_RATE: '1.3' }, async () => {
    const res = await request(app).get('/api/payment-options?total=1000.00');
    assert.equal(res.body.card.amounts.stripe, '1300', 'whole yen, like the amount sent to the gateway');
  });
  const app_js = read('public/js/app.js');
  assert.match(app_js, /\/api\/payment-options\?total=/);
  assert.match(read('public/index.html'), /id="cardChargeNote"/);
});

test('the admin lists are drawn again when the shop decimals arrive after they were drawn', () => {
  const m = read('public/js/admin.js').match(/function redrawMoney\(e\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'redrawMoney is in admin.js');
  const run = ({ signedIn, changed, allowed = true }) => {
    const calls = [];
    const sandbox = {
      isAuthenticated: signedIn,
      can: () => allowed,
      applyMoneySteps: () => calls.push('steps'),
      loadProducts: () => calls.push('products'),
      loadOrders: () => calls.push('orders'),
      showSectionFromHash: () => calls.push('section')
    };
    vm.createContext(sandbox);
    vm.runInContext(`${m[0]}\nredrawMoney({ detail: { decimalsChanged: ${changed} } });`, sandbox);
    return calls;
  };
  assert.deepEqual(run({ signedIn: true, changed: true }), ['steps', 'products', 'orders', 'section']);
  assert.deepEqual(run({ signedIn: true, changed: false }), ['steps'], 'same decimals: nothing to draw again');
  assert.deepEqual(run({ signedIn: false, changed: true }), ['steps'], 'not signed in yet: nothing is drawn');
  assert.deepEqual(run({ signedIn: true, changed: true, allowed: false }), ['steps', 'section'], 'only what the admin may see');
  assert.match(read('public/js/admin.js'), /addEventListener\('brand:ready', redrawMoney\)/);
});
