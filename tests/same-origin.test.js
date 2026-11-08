// Cross-site write protection (middleware/sameOrigin.js): refuses a foreign or "null" Origin on
// /api/users and /api/vendor writes, and leaves the payment gateway callbacks alone.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sameOrigin = require('../middleware/sameOrigin');

function run(req, env = {}) {
  const saved = {};
  for (const k of ['BASE_URL', 'ALLOWED_ORIGIN']) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  try {
    let nextCalled = false; let status = null; let body = null;
    const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
    sameOrigin({ method: 'POST', headers: {}, app: { get: () => false }, ...req }, res, () => { nextCalled = true; });
    return { nextCalled, status, body };
  } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('same site: an Origin that matches the Host header passes', () => {
  assert.equal(run({ headers: { host: 'shop.example.com', origin: 'https://shop.example.com' } }).nextCalled, true);
  assert.equal(run({ headers: { host: 'localhost:3000', origin: 'http://localhost:3000' } }).nextCalled, true);
});

test('cross site: a foreign Origin is refused with 403 for every write method', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const r = run({ method, headers: { host: 'shop.example.com', origin: 'https://evil.example.net' } });
    assert.equal(r.nextCalled, false, method); assert.equal(r.status, 403, method);
    assert.match(r.body.message, /Cross-site/);
  }
});

test('the opaque Origin "null" and a malformed Origin are refused', () => {
  assert.equal(run({ headers: { host: 'shop.example.com', origin: 'null' } }).status, 403);
  assert.equal(run({ headers: { host: 'shop.example.com', origin: 'not a url' } }).status, 403);
  assert.equal(run({ headers: { host: 'shop.example.com', origin: '' } }).status, 403, 'an empty Origin is not "no Origin"');
});

test('a look-alike host is not the same host', () => {
  assert.equal(run({ headers: { host: 'shop.example.com', origin: 'https://shop.example.com.evil.net' } }).status, 403);
  assert.equal(run({ headers: { host: 'shop.example.com', origin: 'https://evil.net/shop.example.com' } }).status, 403);
  assert.equal(run({ headers: { host: 'shop.example.com', origin: 'https://shop.example.com:8443' } }).status, 403, 'another port is another site');
});

test('no Origin (curl, server to server) passes, unless the browser itself says cross-site', () => {
  assert.equal(run({ headers: { host: 'shop.example.com' } }).nextCalled, true);
  assert.equal(run({ headers: { host: 'shop.example.com', 'sec-fetch-site': 'same-origin' } }).nextCalled, true);
  assert.equal(run({ headers: { host: 'shop.example.com', 'sec-fetch-site': 'cross-site' } }).status, 403);
});

test('safe methods are never checked', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    assert.equal(run({ method, headers: { host: 'shop.example.com', origin: 'https://evil.example.net' } }).nextCalled, true, method);
  }
});

test('ALLOWED_ORIGIN and BASE_URL count as this site (the address people really use)', () => {
  const req = { headers: { host: 'internal-app:3000', origin: 'https://www.shop.example.com' } };
  assert.equal(run(req).status, 403, 'without either setting, a proxy that rewrites Host is refused');
  assert.equal(run(req, { ALLOWED_ORIGIN: 'https://www.shop.example.com' }).nextCalled, true);
  assert.equal(run(req, { BASE_URL: 'https://www.shop.example.com/' }).nextCalled, true);
  assert.equal(run(req, { ALLOWED_ORIGIN: 'https://other.example.org, https://www.shop.example.com' }).nextCalled, true, 'a comma list works');
  assert.equal(run(req, { ALLOWED_ORIGIN: 'https://other.example.org' }).status, 403);
});

test('reverse proxy: X-Forwarded-Host is believed only when the app trusts its proxy', () => {
  const headers = { host: 'internal-app:3000', 'x-forwarded-host': 'www.shop.example.com', origin: 'https://www.shop.example.com' };
  assert.equal(run({ headers, app: { get: () => false } }).status, 403, 'proxy not trusted: anyone could write that header');
  assert.equal(run({ headers, app: { get: (k) => (k === 'trust proxy' ? 1 : undefined) } }).nextCalled, true);
  // A forged forwarded host does not help an attacker's own Origin when the proxy is not trusted.
  assert.equal(run({ headers: { host: 'shop.example.com', 'x-forwarded-host': 'evil.net', origin: 'https://evil.net' }, app: { get: () => false } }).status, 403);
});

const request = require('supertest');
process.env.MULTIVENDOR_ENABLED = 'true';
const { app } = require('./helpers');

const HOST = '127.0.0.1';
const foreign = { Origin: 'https://evil.example.net' };
const isRefused = (res) => res.status === 403 && /Cross-site/.test((res.body && res.body.message) || '');

test('app: every kind of write under /api/users and /api/vendor refuses a foreign or null Origin', async () => {
  const writes = [
    ['post', '/api/users/register'], ['post', '/api/users/login'], ['post', '/api/users/logout'],
    ['post', '/api/users/forgot-password'], ['post', '/api/users/reset-password'], ['post', '/api/users/change-password'],
    ['post', '/api/users/wishlist'], ['delete', '/api/users/wishlist/64b7f0c2a1b2c3d4e5f60718'], ['post', '/api/users/wishlist/merge'],
    ['post', '/api/vendor/apply'], ['put', '/api/vendor/profile'], ['post', '/api/vendor/products'],
    ['put', '/api/vendor/products/64b7f0c2a1b2c3d4e5f60718'], ['delete', '/api/vendor/products/64b7f0c2a1b2c3d4e5f60718'],
    ['patch', '/api/vendor/orders/64b7f0c2a1b2c3d4e5f60718/fulfillment']
  ];
  for (const [method, url] of writes) {
    for (const origin of [foreign.Origin, 'null']) {
      const res = await request(app)[method](url).set('Origin', origin).send({});
      assert.ok(isRefused(res), `${method.toUpperCase()} ${url} with Origin ${origin} should be refused, got ${res.status}`);
    }
  }
});

test('app: the same writes from this site are not refused by the cross-site check', async () => {
  for (const [method, url] of [['post', '/api/users/login'], ['post', '/api/users/register'], ['post', '/api/vendor/apply']]) {
    const res = await request(app)[method](url).set('Host', `${HOST}:3000`).set('Origin', `http://${HOST}:3000`).send({});
    assert.ok(!isRefused(res), `${method.toUpperCase()} ${url} from the same site must get past the check (got ${res.status})`);
  }
});

test('app: reading is never blocked (GET with a foreign Origin)', async () => {
  const res = await request(app).get('/api/users/verify-email').set(foreign).query({ token: 'x' });
  assert.ok(!isRefused(res));
});

test('app: payment gateway callbacks and webhooks are NOT subject to the check (gateways call them from other sites)', async () => {
  const callbacks = [
    ['post', '/api/payment/success'], ['post', '/api/payment/fail'], ['post', '/api/payment/cancel'], ['post', '/api/payment/ipn'],
    ['post', '/api/payment/stripe-webhook'], ['get', '/api/payment/stripe-success'], ['get', '/api/payment/paypal-return']
  ];
  // No order exists in this test, so the callbacks look one up and find nothing.
  const Order = require('../models/Order');
  const realFindOne = Order.findOne;
  Order.findOne = async () => null;
  try {
    for (const [method, url] of callbacks) {
      for (const origin of [foreign.Origin, 'null']) {
        const res = await request(app)[method](url).set('Origin', origin).send({});
        assert.ok(!isRefused(res), `${method.toUpperCase()} ${url} must not be refused as cross-site (got ${res.status})`);
      }
    }
  } finally {
    Order.findOne = realFindOne;
  }
});

test('app: every admin write, including login and password reset, refuses a foreign or null Origin', async () => {
  const writes = [
    ['post', '/admin/login'], ['post', '/admin/auth/reset'], ['post', '/admin/logout'],
    ['post', '/admin/products'], ['put', '/admin/products/64b7f0c2a1b2c3d4e5f60718'], ['delete', '/admin/products/64b7f0c2a1b2c3d4e5f60718'],
    ['put', '/admin/orders/64b7f0c2a1b2c3d4e5f60718/status']
  ];
  for (const [method, url] of writes) {
    for (const origin of [foreign.Origin, 'null']) {
      const res = await request(app)[method](url).set('Origin', origin).send({});
      assert.ok(isRefused(res), `${method.toUpperCase()} ${url} with Origin ${origin} should be refused, got ${res.status}`);
    }
  }
});

test('app: admin login from this site still reaches the login handler', async () => {
  const res = await request(app).post('/admin/login').set('Host', `${HOST}:3000`).set('Origin', `http://${HOST}:3000`).send({});
  assert.ok(!isRefused(res), `got ${res.status}`);
});
