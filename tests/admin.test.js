const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, OWNER, STAFF } = require('./helpers');

const VALID_ID = '64b7f0c2a1b2c3d4e5f60718';

// Each call returns a fresh cookie-keeping agent, logged in as the given account.
async function login(account) {
  const agent = request.agent(app);
  const res = await agent.post('/admin/login').send(account);
  assert.equal(res.status, 200, 'login should succeed');
  return { agent, csrf: res.body.csrfToken, body: res.body };
}

test('protected admin routes reject anonymous requests', async () => {
  const res = await request(app).get('/admin/products');
  assert.equal(res.status, 401);
});

test('login requires both username and password', async () => {
  const res = await request(app).post('/admin/login').send({ username: OWNER.username });
  assert.equal(res.status, 400);
});

test('login rejects a wrong password and an unknown user', async () => {
  const wrongPw = await request(app).post('/admin/login').send({ username: OWNER.username, password: 'nope-nope' });
  assert.equal(wrongPw.status, 401);
  const unknown = await request(app).post('/admin/login').send({ username: 'ghost', password: 'whatever123' });
  assert.equal(unknown.status, 401);
});

test('the admin from .env logs in as owner (as before)', async () => {
  const { agent, body } = await login(OWNER);
  assert.equal(body.role, 'owner');
  assert.ok(body.csrfToken);
  const status = await agent.get('/admin/auth/status');
  assert.equal(status.body.isAuthenticated, true);
  assert.equal(status.body.username, OWNER.username);
  assert.equal(status.body.role, 'owner');
});

test('a staff account logs in with the staff role', async () => {
  const { agent, body } = await login(STAFF);
  assert.equal(body.role, 'staff');
  const status = await agent.get('/admin/auth/status');
  assert.equal(status.body.role, 'staff');
});

test('the built-in Staff role cannot delete products, even with a valid CSRF token', async () => {
  const { agent, csrf } = await login(STAFF);
  const res = await agent.delete(`/admin/products/${VALID_ID}`).set('X-CSRF-Token', csrf);
  assert.equal(res.status, 403);
  assert.match(res.body.message, /permission/i);
});

test('staff cannot list or create admin accounts', async () => {
  const { agent, csrf } = await login(STAFF);
  assert.equal((await agent.get('/admin/staff')).status, 403);
  const create = await agent.post('/admin/staff').set('X-CSRF-Token', csrf)
    .send({ username: 'newbie', password: 'LongEnough123' });
  assert.equal(create.status, 403);
});

test('owner delete still requires a CSRF token', async () => {
  const { agent } = await login(OWNER);
  const res = await agent.delete(`/admin/products/${VALID_ID}`);
  assert.equal(res.status, 403);
  assert.match(res.body.message, /csrf/i);
});

test('the CSRF token must match exactly: a token of another length is refused, not an error', async () => {
  const { agent, csrf } = await login(OWNER);
  const wrong = [csrf.slice(0, -1), csrf + 'x', 'x'.repeat(csrf.length), '', 'a'];
  for (const token of wrong) {
    const res = await agent.post('/admin/logout').set('X-CSRF-Token', token);
    assert.equal(res.status, 403, `a token of ${token.length} characters is refused`);
  }
  const ok = await agent.post('/admin/logout').set('X-CSRF-Token', csrf);
  assert.equal(ok.status, 200);
});

test('creating an admin account validates input before touching the database', async () => {
  const { agent, csrf } = await login(OWNER);
  const post = (body) => agent.post('/admin/staff').set('X-CSRF-Token', csrf).send(body);

  assert.equal((await post({ username: 'ab', password: 'LongEnough123' })).status, 400);        // username too short
  assert.equal((await post({ username: 'good_name', password: 'short' })).status, 400);         // password too short
  assert.equal((await post({ username: OWNER.username, password: 'LongEnough123' })).status, 400); // reserved
});

const { withStubs, withEnv, fakeTwoFactorStore } = require('./fakeDb');
const totp = require('../services/totp');
const quiet = [console, 'error', () => {}];
const ownerLogin = async (extra = {}) => {
  const agent = request.agent(app);
  const res = await agent.post('/admin/login').send({ ...OWNER, ...extra });
  return { agent, res, csrf: res.body.csrfToken };
};

test('a plaintext two-factor secret from an older version still works and is encrypted after a successful login', async () => {
  const twoFactor = require('../services/twoFactor');
  const store = fakeTwoFactorStore();
  const secret = totp.generateSecret();
  store.docs.push({ _id: 'tf-old', key: 'env:owner_admin', secret, enabled: true, lastStep: 0, backupCodeHashes: [], failedAttempts: 0, lockedUntil: null });
  await withEnv({ ADMIN_2FA_ENABLED: 'true' }, () => withStubs([quiet, ...store], async () => {
    assert.equal(store.docs[0].secret, secret);
    const ok = await ownerLogin({ otp: totp.totpAt(secret) });
    assert.equal(ok.res.status, 200);
    assert.ok(twoFactor.isEncrypted(store.docs[0].secret));
    assert.equal(twoFactor.decryptSecret(store.docs[0].secret), secret);
    const next = await ownerLogin({ otp: totp.totpAt(secret, Date.now() + 30000) });
    assert.equal(next.res.status, 200, 'the encrypted copy works for the next login');
  }));
});

test('admin logins and failed logins are written to the audit log without the password or code', async () => {
  const AuditLog = require('../models/AuditLog');
  const entries = [];
  await withStubs([[AuditLog, 'create', async (d) => { entries.push(d); return {}; }]], async () => {
    await request(app).post('/admin/login').send({ username: 'owner_admin', password: 'Wrong-Pass-123', otp: '123456' });
    const ok = await ownerLogin();
    assert.equal(ok.res.status, 200);
  });
  assert.deepEqual(entries.map((e) => e.action), ['LOGIN_FAILED', 'LOGIN']);
  assert.ok(entries.every((e) => e.actor === 'owner_admin'));
  const text = JSON.stringify(entries);
  assert.ok(!text.includes('Wrong-Pass-123') && !text.includes('123456') && !text.includes(OWNER.password));
});
