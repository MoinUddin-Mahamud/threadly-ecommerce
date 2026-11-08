const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('./helpers');

test('storefront page is served and includes the dark-mode assets', async () => {
  const res = await request(app).get('/');
  assert.equal(res.status, 200);
  assert.match(res.text, /Threadly/i);
  assert.match(res.text, /\/css\/theme\.css/);
  assert.match(res.text, /\/js\/theme\.js/);
});

test('security headers are set and X-Powered-By is hidden', async () => {
  const res = await request(app).get('/');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-powered-by'], undefined);
  assert.ok(res.headers['x-frame-options']);
});

test('chat rejects an empty message', async () => {
  const res = await request(app).post('/api/chat').send({ message: '   ' });
  assert.equal(res.status, 400);
});

test('chat rejects a message over 500 characters', async () => {
  const res = await request(app).post('/api/chat').send({ message: 'a'.repeat(501) });
  assert.equal(res.status, 400);
});

test('customer registration validates required fields and password length', async () => {
  const missing = await request(app).post('/api/users/register').send({ email: 'a@b.com' });
  assert.equal(missing.status, 400);
  const shortPw = await request(app).post('/api/users/register').send({ name: 'A', email: 'a@b.com', password: 'short' });
  assert.equal(shortPw.status, 400);
});

test('chat rejects a message that is not a string', async () => {
  const res = await request(app).post('/api/chat').send({ message: 12345 });
  assert.equal(res.status, 400);
});

test('chat is rate limited per IP', async () => {
  let limited = false;
  for (let i = 0; i < 15 && !limited; i++) {
    const res = await request(app).post('/api/chat').send({ message: '   ' });
    limited = res.status === 429;
  }
  assert.ok(limited, 'expected a 429 after repeated chat requests');
});

test('there is no public order list and no email lookup', async () => {
  assert.equal((await request(app).get('/api/orders')).status, 404);
  assert.equal((await request(app).get('/api/orders/history?email=a@b.com')).status, 404);
});
