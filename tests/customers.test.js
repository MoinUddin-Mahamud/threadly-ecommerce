// Tests for customer accounts: email verification and what "My Orders" returns.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { app } = require('./helpers');
const User = require('../models/User');
const Order = require('../models/Order');
const emailService = require('../services/emailService');

const USER_ID = '64b7f0c2a1b2c3d4e5f60aaa';
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

async function withStubs(stubs, fn) {
  const saved = stubs.map(([target, name]) => [target, name, target[name]]);
  stubs.forEach(([target, name, impl]) => { target[name] = impl; });
  try { await fn(); } finally { saved.forEach(([target, name, original]) => { target[name] = original; }); }
}

// Registers a customer through the real route (stubbing only the database) and
// returns the logged-in agent, what was stored, and the link that was "emailed".
async function registerCustomer(email = 'buyer@example.com') {
  const links = [];
  const stored = {};
  const agent = request.agent(app);
  let res;
  await withStubs([
    [emailService, 'sendVerificationEmail', async (u, l) => { links.push(l); return false; }],
    [User, 'findOne', async () => null],
    [User, 'create', async (doc) => { Object.assign(stored, doc); return { _id: USER_ID, name: doc.name, email: doc.email }; }]
  ], async () => {
    res = await agent.post('/api/users/register').send({ name: 'Buyer One', email, password: 'LongEnough123' });
  });
  assert.equal(res.status, 201, `registration should succeed, got ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, res, stored, link: links[0] };
}

// The sign-up route is rate limited per IP, so the tests share one customer.
let sharedCustomer = null;
async function customer() {
  if (!sharedCustomer) sharedCustomer = await registerCustomer();
  return sharedCustomer;
}

test('registration only accepts text fields', async () => {
  for (const body of [
    { name: 'A', email: 'a@b.com', password: { length: 99 } },
    { name: ['A'], email: 'a@b.com', password: 'LongEnough123' },
    { name: 'A', email: { $gt: '' }, password: 'LongEnough123' }
  ]) {
    assert.equal((await request(app).post('/api/users/register').send(body)).status, 400);
  }
  assert.equal((await request(app).post('/api/users/login').send({ email: { $gt: '' }, password: 'x' })).status, 400);
});

test('registering stores only a hash of the verification token and emails the link', async () => {
  const { res, stored, link } = await customer();
  assert.equal(res.status, 201);
  assert.equal(res.body.user.emailVerified, false);
  assert.equal(res.body.verificationEmailSent, false);   // email is not configured in the test environment

  assert.match(stored.verifyTokenHash, /^[0-9a-f]{64}$/);
  assert.ok(stored.verifyTokenExpires > new Date());
  assert.ok(link, 'the verification link is built for the email');
  const token = link.split('token=')[1];
  assert.equal(sha256(token), stored.verifyTokenHash);
  assert.ok(!JSON.stringify(res.body).includes(token), 'the raw token is never sent back to the browser');
  assert.ok(!Object.values(stored).includes(token), 'the raw token is never stored');
});

test('opening the emailed link changes nothing and passes the token in the fragment', async () => {
  const { link } = await customer();
  const token = link.split('token=')[1];
  let writes = 0;
  await withStubs([[User, 'findOneAndUpdate', async () => { writes++; return { _id: USER_ID }; }]], async () => {
    const res = await request(app).get(`/api/users/verify-email?token=${token}`);
    assert.equal(res.status, 302);
    assert.match(res.headers.location, new RegExp(`/#verifyToken=${token}$`));
  });
  assert.equal(writes, 0);
});

test('the page confirms the link with a POST and the account is verified once', async () => {
  const { link } = await customer();
  const token = link.split('token=')[1];
  let filter, update;
  await withStubs([[User, 'findOneAndUpdate', async (f, u) => { filter = f; update = u; return { _id: USER_ID }; }]], async () => {
    const res = await request(app).post('/api/users/verify-email').send({ token });
    assert.equal(res.status, 200);
  });
  assert.equal(filter.verifyTokenHash, sha256(token));
  assert.ok(filter.verifyTokenExpires.$gt instanceof Date);   // expired links do not work
  assert.equal(update.$set.emailVerified, true);
  assert.deepEqual(update.$unset, { verifyTokenHash: 1, verifyTokenExpires: 1 });   // the link works once
});

test('wrong, malformed or expired verification links are rejected', async () => {
  let dbCalls = 0;
  await withStubs([[User, 'findOneAndUpdate', async () => { dbCalls++; return null; }]], async () => {
    const unknown = await request(app).post('/api/users/verify-email').send({ token: 'a'.repeat(64) });
    assert.equal(unknown.status, 400);
    assert.equal(dbCalls, 1);

    for (const body of [{}, { token: 'short' }, { token: { $ne: 1 } }, { token: 'Z'.repeat(64) }]) {
      const res = await request(app).post('/api/users/verify-email').send(body);
      assert.equal(res.status, 400);
    }
    assert.equal(dbCalls, 1, 'malformed tokens never reach the database');
    for (const q of ['', '?token=short', '?token[$ne]=1']) {
      const res = await request(app).get(`/api/users/verify-email${q}`);
      assert.match(res.headers.location, /emailVerified=0$/);
    }
  });
});

test('My Orders for an unverified email shows only orders placed while logged in', async () => {
  const { agent } = await customer();
  let filter, projection;
  await withStubs([
    [User, 'findById', async () => ({ _id: USER_ID, email: 'victim@example.com', emailVerified: false })],
    [Order, 'find', (f, p) => { filter = f; projection = p; return { sort: () => ({ skip: () => ({ limit: async () => [] }) }) }; }],
    [Order, 'countDocuments', async () => 0]
  ], async () => {
    const res = await agent.get('/api/users/my-orders');
    assert.equal(res.status, 200);
    assert.equal(res.body.emailVerified, false);
  });
  assert.deepEqual(filter, { $or: [{ userId: USER_ID }] });   // nothing is matched by email
  assert.doesNotMatch(JSON.stringify(filter), /victim@example\.com/);
  assert.equal(projection, 'items status totalAmount subtotalAmount discountAmount couponCode paymentGateway deliveryAddress createdAt transactionId');
});

test('My Orders for a verified email also includes guest orders with that email', async () => {
  const { agent } = await customer();
  let filter;
  await withStubs([
    [User, 'findById', async () => ({ _id: USER_ID, email: 'buyer@example.com', emailVerified: true })],
    [Order, 'find', (f) => { filter = f; return { sort: () => ({ skip: () => ({ limit: async () => [] }) }) }; }],
    [Order, 'countDocuments', async () => 0]
  ], async () => {
    const res = await agent.get('/api/users/my-orders');
    assert.equal(res.body.emailVerified, true);
  });
  assert.deepEqual(filter.$or, [{ userId: USER_ID }, { customerEmail: 'buyer@example.com' }]);
});

test('My Orders needs a login', async () => {
  assert.equal((await request(app).get('/api/users/my-orders')).status, 401);
});

test('a customer can ask for a new verification link, and only when logged in', async () => {
  assert.equal((await request(app).post('/api/users/resend-verification')).status, 401);

  const { agent } = await customer();
  let saved = null;
  const links = [];
  await withStubs([
    [emailService, 'sendVerificationEmail', async (u, l) => { links.push(l); return false; }],
    [User, 'findById', async () => ({ _id: USER_ID, name: 'Buyer One', email: 'buyer@example.com', emailVerified: false })],
    [User, 'updateOne', async (f, u) => { saved = u; return {}; }]
  ], async () => {
    const res = await agent.post('/api/users/resend-verification');
    assert.equal(res.status, 200);
  });
  assert.match(saved.$set.verifyTokenHash, /^[0-9a-f]{64}$/);
  const token = links[0].match(/token=([0-9a-f]{64})/)[1];
  assert.equal(sha256(token), saved.$set.verifyTokenHash);

  let updated = false;
  await withStubs([
    [User, 'findById', async () => ({ _id: USER_ID, emailVerified: true })],
    [User, 'updateOne', async () => { updated = true; return {}; }]
  ], async () => {
    const res = await agent.post('/api/users/resend-verification');
    assert.equal(res.body.emailVerified, true);
  });
  assert.equal(updated, false, 'already verified: nothing to send');
});
