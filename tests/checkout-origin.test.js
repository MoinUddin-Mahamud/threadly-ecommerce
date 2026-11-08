// Cross-site protection on the storefront's own write routes (orders, coupon check, chat,
// payment reference). The payment gateway callbacks under /api/payment/ are left open on purpose.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, server } = require('./helpers');

after(() => { try { server.close(); } catch (e) { /* not listening */ } });

const FOREIGN = 'https://evil.example.net';

test('a cross-site POST to the storefront write routes is refused with 403', async () => {
  for (const path of ['/api/orders', '/api/coupons/validate', '/api/chat', '/api/orders/64b7f0c2a1b2c3d4e5f60718/payment-reference']) {
    const res = await request(app).post(path).set('Origin', FOREIGN).send({});
    assert.equal(res.status, 403, path);
    assert.match(res.body.message, /Cross-site/, path);
  }
});

test('a same-site POST to /api/orders is not stopped by the origin check', async () => {
  const res = await request(app).post('/api/orders').set('Host', 'shop.example.com').set('Origin', 'https://shop.example.com').send({});
  assert.notEqual(res.status, 403);
  assert.equal(res.status, 400, 'an empty order is refused for its content, not its origin');
});

test('a POST with no Origin header (server tools, older browsers) still reaches the route', async () => {
  const res = await request(app).post('/api/orders').send({});
  assert.equal(res.status, 400);
});

test('payment gateway callbacks are not behind the origin check', async () => {
  const res = await request(app).post('/api/payment/ipn').set('Origin', FOREIGN).send({});
  assert.notEqual(res.status, 403);
});
