// PayPal whole amounts for HUF, TWD and JPY, wording, create-admin password rule, first-run docs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const request = require('supertest');
const mongoose = require('mongoose');
const { app } = require('./helpers');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const Coupon = require('../models/Coupon');
const CouponRedemption = require('../models/CouponRedemption');
const intl = require('../services/intlGateways');
const { currencyExponent, paypalExponent } = require('../services/paymentConfig');
const { releaseCoupon, reclaimCoupon } = require('../services/couponService');

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
    calls.push({ url: String(url), body: opts.body });
    const hit = replies.find(([m]) => String(url).includes(m));
    if (!hit) throw new Error(`unexpected request to ${url}`);
    const [, status, body] = hit;
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  };
  try { await fn(calls); } finally { globalThis.fetch = saved; }
}

test('PayPal counts HUF, TWD and JPY in whole units; every other gateway keeps the currency\'s own decimals', () => {
  for (const c of ['HUF', 'TWD', 'JPY', 'huf']) assert.equal(paypalExponent(c), 0, c);
  assert.equal(paypalExponent('USD'), 2);
  assert.equal(paypalExponent('KWD'), 3, 'other currencies follow currencyExponent');
  assert.equal(paypalExponent(undefined), 2);
  // The shared rule is NOT changed: Stripe still counts HUF and TWD in hundredths.
  assert.equal(currencyExponent('HUF'), 2);
  assert.equal(currencyExponent('TWD'), 2);
  assert.equal(currencyExponent('JPY'), 0);
});

test('PayPal in HUF, TWD and JPY: amounts are sent, stored and read back as whole units', () => {
  for (const c of ['HUF', 'TWD', 'JPY']) {
    const env = { CURRENCY_CODE: c };
    const minor = intl.toMinorUnits(1000, env, 'paypal');
    assert.equal(minor, 1000, `${c}: stored amount is the total itself`);
    assert.equal(intl.minorToDecimal(minor, c, 'paypal'), '1000', `${c}: the value sent to PayPal has no decimals`);
    assert.equal(intl.decimalToMinor('1000', c, 'paypal'), 1000, `${c}: the captured amount is read back the same way`);
    assert.equal(intl.decimalToMinor(intl.minorToDecimal(minor, c, 'paypal'), c, 'paypal'), minor, `${c}: round trip`);
  }
  assert.equal(intl.toMinorUnits(1000.6, { CURRENCY_CODE: 'HUF' }, 'paypal'), 1001, 'a fraction is rounded to a whole unit');
  assert.equal(intl.toMinorUnits(100, { CURRENCY_CODE: 'XXX', CARD_CURRENCY: 'HUF', CARD_RATE: '3.5' }, 'paypal'), 350, 'CARD_RATE applies first');
});

test('the same currencies on Stripe, Flutterwave and Mollie are unchanged (two decimals for HUF and TWD)', () => {
  for (const c of ['HUF', 'TWD']) {
    const env = { CURRENCY_CODE: c };
    assert.equal(intl.toMinorUnits(1000, env), 100000, `${c} on Stripe`);
    assert.equal(intl.toMinorUnits(1000, env, 'stripe'), 100000);
    assert.equal(intl.toMinorUnits(1000, env, 'mollie'), 100000);
    assert.equal(intl.toMinorUnits(1000, env, 'flutterwave'), 100000);
    assert.equal(intl.minorToDecimal(100000, c), '1000.00');
    assert.equal(intl.minorToDecimal(100000, c, 'mollie'), '1000.00');
    assert.equal(intl.decimalToMinor('1000.00', c, 'flutterwave'), 100000);
  }
  assert.equal(intl.toMinorUnits(1000, { CURRENCY_CODE: 'JPY' }), 1000, 'JPY on Stripe is still whole units');
  assert.equal(intl.toMinorUnits(12.34, { CURRENCY_CODE: 'USD' }, 'paypal'), 1234, 'USD on PayPal is unchanged');
  assert.equal(intl.minorToDecimal(1234, 'USD', 'paypal'), '12.34');
});

test('a PayPal capture in HUF is read as whole units (the amount check when the customer comes back)', () => {
  const captured = (value, code) => intl.readPaypalOrder({ id: 'O1', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'C1', status: 'COMPLETED', amount: { value, currency_code: code } }] } }] });
  assert.equal(captured('1000', 'HUF').amountMinor, 1000);
  assert.equal(captured('1000', 'TWD').amountMinor, 1000);
  assert.equal(captured('12.34', 'USD').amountMinor, 1234);
});

test('a PayPal checkout in HUF sends and stores whole units, while Mollie in HUF keeps two decimals', async () => {
  const PRODUCT_ID = '64b7f0c2a1b2c3d4e5f60999';
  const ORDER_ID = '64b7f0c2a1b2c3d4e5f60718';
  const cases = {
    paypal: { env: { PAYPAL_CLIENT_ID: 'client-id-123', PAYPAL_CLIENT_SECRET: 'secret-456' }, replies: [['/v1/oauth2/token', 200, { access_token: 'T' }], ['/v2/checkout/orders', 201, { id: 'PP1', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=PP1' }] }]], sent: /"value":"1000"/, notSent: /1000\.00|100000/, hundredths: false },
    mollie: { env: { MOLLIE_API_KEY: 'test_abcdefghijklmnopqrstuvwxyz1234' }, replies: [['/v2/payments', 201, { id: 'tr_test123', _links: { checkout: { href: 'https://www.mollie.com/checkout/test123' } } }]], sent: /"value":"1000\.00"/, notSent: /"value":"1000"/, hundredths: true }
  };
  const none = { PAYPAL_CLIENT_ID: undefined, PAYPAL_CLIENT_SECRET: undefined, FLUTTERWAVE_SECRET_KEY: undefined, FLUTTERWAVE_WEBHOOK_HASH: undefined, MOLLIE_API_KEY: undefined };
  for (const [g, c] of Object.entries(cases)) {
    const created = [];
    await withEnv({ ...none, ...c.env, CURRENCY_CODE: 'HUF', CARD_CURRENCY: undefined, CARD_RATE: undefined, MIN_ORDER_TOTAL: '0' }, () => withStubs([
      quiet,
      [Product, 'findById', async () => ({ _id: PRODUCT_ID, title: 'Bomber', price: 1000, stock: 50 })],
      [Product, 'findOneAndUpdate', async () => ({})],
      [Product, 'updateOne', async () => ({})],
      [Order, 'create', async (doc) => { created.push(doc); return { _id: ORDER_ID, ...doc }; }],
      [Order, 'updateOne', async () => ({})]
    ], () => withFetch(c.replies, async (calls) => {
      const res = await request(app).post('/api/orders').send({
        customerName: 'Buyer', customerEmail: 'buyer@example.com', customerPhone: '01700000000', paymentGateway: g,
        deliveryAddress: { address: '1 Main St', city: 'Budapest', postcode: '1051', country: 'Hungary' },
        items: [{ productId: PRODUCT_ID, quantity: 1, size: 'M' }]
      });
      assert.equal(res.status, 200, `${g}: ${JSON.stringify(res.body)}`);
      assert.equal(created[0].gatewayCurrency, 'HUF', g);
      const total = Math.round(created[0].totalAmount);
      assert.equal(created[0].gatewayAmountMinor, c.hundredths ? total * 100 : total, `${g}: the stored amount uses the same decimals as the request`);
      const sent = calls.map((x) => String(x.body || '')).join('\n');
      assert.match(sent, c.sent, g);
      assert.doesNotMatch(sent, c.notSent, g);
    })));
  }
});

test('UGX and ISK stay at two decimals (Stripe wants hundredths) and the README mentions them', () => {
  assert.equal(currencyExponent('UGX'), 2);
  assert.equal(currencyExponent('ISK'), 2);
  const readme = read('README.md');
  assert.match(readme, /UGX/);
  assert.match(readme, /ISK/);
  assert.match(read('services/paymentConfig.js'), /ISK and UGX keep 2/);
});

test('the kept-earnings row says it is a deduction that is already taken off the store revenue', () => {
  const admin = read('public/js/admin.js');
  assert.match(admin, /Less: earnings kept by sellers on cancelled orders \(already deducted from Store revenue\)/);
  assert.doesNotMatch(admin, /Included above: earnings kept/);
  assert.match(admin, /&minus; \$\{money\(revenue\.keptEarningsCost\)\}/, 'the amount still comes from money(), not from raw HTML');
  for (const f of ['README.md', 'TESTING_GUIDE.md']) assert.doesNotMatch(read(f), /Included above: earnings kept/, f);
});

function jsFiles(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'tests' || e.name === 'public') continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) jsFiles(rel, out); else if (e.name.endsWith('.js')) out.push(rel);
  }
  return out;
}
test('every place that loads .env asks dotenv to stay quiet', () => {
  const callers = jsFiles('.')
    .map((f) => f.split(path.sep).join('/'))
    .filter((f) => /require\('dotenv'\)/.test(read(f)));
  for (const f of ['server.js', 'seed/seed.js', 'scripts/create-admin.js', 'scripts/reset-2fa.js', 'scripts/chat-check.js']) {
    assert.ok(callers.includes(f), `${f} loads dotenv`);
  }
  for (const f of callers) assert.match(read(f), /require\('dotenv'\)\.config\(\{ quiet: true \}\)/, f);
});

test('starting a script does not print the dotenv "injected env" line', () => {
  const r = spawnSync(process.execPath, ['scripts/create-admin.js'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, MONGODB_URI: '' } });
  assert.equal(r.status, 1, 'it stops with the usage message');
  assert.doesNotMatch(r.stdout + r.stderr, /injected env|dotenv/i);
});

test('create-admin refuses a password the admin panel would refuse (too short, or more than 72 bytes)', () => {
  for (const [password, expected] of [['short', /8\+ characters/], ['x'.repeat(80), /at most 72 bytes/]]) {
    const r = spawnSync(process.execPath, ['scripts/create-admin.js', 'jane', password, 'staff'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, MONGODB_URI: '' } });
    assert.equal(r.status, 1, password.slice(0, 8));
    assert.match(r.stderr, expected);
  }
  assert.match(read('scripts/create-admin.js'), /passwordProblem\(password\)/);
});

test('the README starts with a quick start that works on a fresh copy', () => {
  const readme = read('README.md');
  const quick = readme.slice(readme.indexOf('## Quick start'), readme.indexOf('## Features'));
  assert.ok(readme.indexOf('## Quick start') > 0 && readme.indexOf('## Quick start') < readme.indexOf('## Features'), 'it comes before everything else');
  assert.ok(readme.indexOf('## Quick start') < readme.indexOf('## Installation'));
  for (const needle of ['cp .env.example .env', 'NODE_ENV=development', 'MONGODB_URI', 'ADMIN_PASSWORD_HASH', 'scripts/hash-password.js',
    'npm install', 'npm run seed', 'npm start', 'http://localhost:3000', '/admin.html', 'npm run create-admin',
    'docker compose up --build', 'randomBytes(32)', 'COOKIE_SECURE=false']) {
    assert.ok(quick.includes(needle), `the quick start mentions ${needle}`);
  }
  // Every command it names exists
  const scripts = JSON.parse(read('package.json')).scripts;
  for (const s of ['start', 'seed', 'create-admin']) assert.ok(scripts[s], `npm run ${s} exists`);
  for (const f of ['scripts/hash-password.js', 'scripts/create-admin.js', 'docker-compose.yml', '.env.example']) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  // The example file ships the local-friendly default, as the quick start says
  assert.match(read('.env.example'), /^NODE_ENV=development$/m);
  assert.match(read('.env.example'), /^SESSION_SECRET=replace-this/m);
});

test('a database call that a test forgot to stub fails after half a second, not ten', async () => {
  assert.equal(mongoose.get('bufferTimeoutMS'), 500);
  const started = Date.now();
  await assert.rejects(User.findOne({ email: 'nobody@example.com' }), /buffering timed out/);
  assert.ok(Date.now() - started < 3000, 'it did not wait for the default 10 seconds');
});

test('the per-customer coupon count is written when a use is given back or taken again', async () => {
  const log = [];
  await withStubs([
    [CouponRedemption, 'updateOne', async (f, u, o) => { log.push({ f, u, o }); return { modifiedCount: 1 }; }],
    [Coupon, 'updateOne', async () => ({ modifiedCount: 1 })],
    [Coupon, 'findOneAndUpdate', async () => ({ _id: 'c1', usedCount: 1 })]
  ], async () => {
    await releaseCoupon('c1', 'cust-key');
    assert.deepEqual(log[0].u, { $inc: { count: -1 } });
    assert.equal(log[0].f.customerKey, 'cust-key');
    assert.deepEqual(log[0].f.count, { $gt: 0 }, 'never goes below zero');
    await reclaimCoupon('c1', 'cust-key');
    assert.deepEqual(log[1].u, { $inc: { count: 1 } });
    assert.deepEqual(log[1].o, { upsert: true });
    await releaseCoupon('c1');
    assert.equal(log.length, 2, 'no customer key, no per-customer write');
  });
});