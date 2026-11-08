// /setup: token rule, .env admin states and the one-owner claim across two server processes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const bcrypt = require('bcrypt');
const Admin = require('../models/Admin');
const SetupLock = require('../models/SetupLock');
const { createSetupRouter, tokenRequired, isLocalBaseUrl, LOCK_ID } = require('../routes/setup');
const { adminEnvState, adminEnvWarning, envAdminConfigured } = require('../services/adminEnv');

const GOOD = { username: 'owner1', password: 'a-long-password-1' };
const HASH = bcrypt.hashSync('some-password-1', 4);
const LOCAL = { NODE_ENV: 'development', BASE_URL: 'http://localhost:3000' };

const makeApp = () => express().use(express.json()).use('/api/setup', createSetupRouter());

// One shared database: two routers talking to it behave like two server processes.
function sharedDb() {
  const db = { admins: [], locks: [], failCreate: 0 };
  const saved = { a: [Admin.findOne, Admin.create], l: [SetupLock.create, SetupLock.deleteOne] };
  Admin.findOne = async () => db.admins[0] || null;
  Admin.create = async (doc) => {
    await new Promise((r) => setImmediate(r));
    if (db.failCreate > 0) { db.failCreate--; throw new Error('write failed'); }
    db.admins.push(doc); return doc;
  };
  SetupLock.create = async (doc) => {
    if (db.locks.some((l) => l._id === doc._id)) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    db.locks.push({ createdAt: new Date(), ...doc }); return doc;
  };
  SetupLock.deleteOne = async (f) => {
    const i = db.locks.findIndex((l) => l._id === f._id && (!f.createdAt || l.createdAt < f.createdAt.$lt));
    if (i > -1) db.locks.splice(i, 1);
    return { deletedCount: i > -1 ? 1 : 0 };
  };
  db.restore = () => { [Admin.findOne, Admin.create] = saved.a; [SetupLock.create, SetupLock.deleteOne] = saved.l; };
  return db;
}
async function withEnv(env, fn) {
  const keys = ['ADMIN_USERNAME', 'ADMIN_PASSWORD_HASH', 'SETUP_TOKEN', 'NODE_ENV', 'BASE_URL'];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  const db = sharedDb();
  try { await fn(db); } finally {
    db.restore();
    for (const k of keys) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
  }
}

test('token rule: optional only for a non-production run on a local BASE_URL', () => {
  assert.equal(tokenRequired({ ...LOCAL }), false);
  assert.equal(tokenRequired({ NODE_ENV: 'test', BASE_URL: 'http://127.0.0.1:3000' }), false);
  assert.equal(tokenRequired({ NODE_ENV: 'production', BASE_URL: 'http://localhost:3000' }), true);
  assert.equal(tokenRequired({ NODE_ENV: 'development', BASE_URL: 'https://shop.example.com' }), true);
  assert.equal(tokenRequired({ BASE_URL: 'https://shop.example.com' }), true, 'NODE_ENV forgotten');
  assert.equal(tokenRequired({}), true, 'nothing set');
  assert.equal(tokenRequired({ NODE_ENV: 'development' }), true, 'BASE_URL unset');
  assert.equal(tokenRequired({ ...LOCAL, SETUP_TOKEN: 'a-secret-token-1234' }), true, 'a set token is always checked');
});

test('only real localhost addresses count as local', () => {
  for (const u of ['http://localhost', 'http://localhost:3000/', 'https://127.0.0.1:8443']) assert.equal(isLocalBaseUrl(u), true, u);
  for (const u of ['http://localhost.evil.com', 'http://evil.com/localhost', 'http://localhost@evil.com', 'localhost:3000', '', undefined, 'http://10.0.0.5']) {
    assert.equal(isLocalBaseUrl(u), false, String(u));
  }
});

test('a deploy that forgot NODE_ENV=production does not leave /setup open', async () => {
  await withEnv({ BASE_URL: 'https://shop.example.com' }, async (db) => {
    const app = makeApp();
    const s = (await request(app).get('/api/setup/status')).body;
    assert.deepEqual([s.needed, s.tokenRequired, s.tokenMissing], [true, true, true]);
    assert.equal((await request(app).post('/api/setup').send(GOOD)).status, 503);
    process.env.SETUP_TOKEN = 'a-secret-token-1234';
    assert.equal((await request(app).post('/api/setup').send(GOOD)).status, 403);
    assert.equal(db.admins.length, 0);
    assert.equal((await request(app).post('/api/setup').send({ ...GOOD, setupToken: 'a-secret-token-1234' })).status, 201);
  });
});

test('local development needs no token', async () => {
  await withEnv(LOCAL, async (db) => {
    const s = (await request(makeApp()).get('/api/setup/status')).body;
    assert.deepEqual([s.needed, s.tokenRequired, s.tokenMissing], [true, false, false]);
    assert.equal((await request(makeApp()).post('/api/setup').send(GOOD)).status, 201);
    assert.equal(db.admins.length, 1);
  });
});

test('a SETUP_TOKEN shorter than 16 characters is refused', async () => {
  await withEnv({ ...LOCAL, SETUP_TOKEN: 'short' }, async () => {
    const s = (await request(makeApp()).get('/api/setup/status')).body;
    assert.equal(s.tokenMissing, true);
    assert.equal((await request(makeApp()).post('/api/setup').send({ ...GOOD, setupToken: 'short' })).status, 503);
  });
});

test('admin env: absent, template placeholder, valid', () => {
  assert.equal(adminEnvState({}).state, 'absent');
  assert.equal(adminEnvState({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD_HASH: '' }).state, 'absent');
  assert.equal(adminEnvState({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD_HASH: 'replace-with-output-of-scripts/hash-password.js' }).state, 'absent');
  assert.equal(adminEnvState({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD_HASH: "'your-hash-here'" }).state, 'absent');
  assert.equal(adminEnvState({ ADMIN_USERNAME: 'boss', ADMIN_PASSWORD_HASH: HASH }).state, 'valid');
  assert.equal(envAdminConfigured({ ADMIN_USERNAME: 'boss', ADMIN_PASSWORD_HASH: HASH }), true);
  assert.equal(adminEnvWarning({ ADMIN_USERNAME: 'boss', ADMIN_PASSWORD_HASH: HASH }), null);
  assert.equal(adminEnvWarning({}), null);
});

test('admin env: a hash that is set but broken is malformed', () => {
  const user = 'boss';
  const cases = {
    'quoted with single quotes': `'${HASH}'`,
    'quoted with double quotes': `"${HASH}"`,
    'cut short': HASH.slice(0, 40),
    'Docker dropped the $ parts': HASH.replace(/\$2b\$04\$/, ''),
    'plain text': 'hunter2'
  };
  for (const [name, hash] of Object.entries(cases)) {
    const r = adminEnvState({ ADMIN_USERNAME: user, ADMIN_PASSWORD_HASH: hash });
    assert.equal(r.state, 'malformed', name);
    assert.ok(r.problem, name);
    assert.equal(envAdminConfigured({ ADMIN_USERNAME: user, ADMIN_PASSWORD_HASH: hash }), false, name);
  }
  const noUser = adminEnvState({ ADMIN_PASSWORD_HASH: HASH });
  assert.equal(noUser.state, 'malformed');
  assert.match(noUser.problem, /ADMIN_USERNAME/);
});

test('one warning explains a malformed hash and the fix', () => {
  const quoted = adminEnvWarning({ ADMIN_USERNAME: 'boss', ADMIN_PASSWORD_HASH: `'${HASH}'` });
  assert.match(quoted, /without the surrounding quotes/);
  assert.match(quoted, /\/setup stays closed/);
  const mangled = adminEnvWarning({ ADMIN_USERNAME: 'boss', ADMIN_PASSWORD_HASH: HASH.slice(0, 40) });
  assert.match(mangled, /single quotes/);
  assert.match(mangled, /hash-password\.js/);
  assert.match(mangled, /\/setup stays closed/);
});

test('a malformed hash never opens /setup', async () => {
  for (const hash of [`'${HASH}'`, HASH.slice(0, 40)]) {
    await withEnv({ ...LOCAL, ADMIN_USERNAME: 'boss', ADMIN_PASSWORD_HASH: hash }, async (db) => {
      const app = makeApp();
      assert.equal((await request(app).get('/api/setup/status')).body.needed, false);
      assert.equal((await request(app).post('/api/setup').send(GOOD)).status, 404);
      assert.equal(db.admins.length, 0);
      assert.equal(db.locks.length, 0);
    });
  }
});

test('the template placeholder leaves /setup open', async () => {
  await withEnv({ ...LOCAL, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD_HASH: 'replace-with-output-of-scripts/hash-password.js' }, async () => {
    assert.equal((await request(makeApp()).get('/api/setup/status')).body.needed, true);
  });
});

test('two server processes at the same moment: exactly one owner', async () => {
  await withEnv(LOCAL, async (db) => {
    const [a, b] = await Promise.all([
      request(makeApp()).post('/api/setup').send(GOOD),
      request(makeApp()).post('/api/setup').send({ username: 'attacker', password: 'another-password-2' })
    ]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    assert.equal(db.admins.length, 1);
    assert.equal(db.locks.length, 1);
    assert.equal(db.locks[0]._id, LOCK_ID);
    assert.equal(db.admins[0].username, a.status === 201 ? 'owner1' : 'attacker');
  });
});

test('a failed owner write releases the claim, so setup can be retried', async () => {
  await withEnv(LOCAL, async (db) => {
    db.failCreate = 1;
    const first = await request(makeApp()).post('/api/setup').send(GOOD);
    assert.equal(first.status, 500);
    assert.equal(db.admins.length, 0);
    assert.equal(db.locks.length, 0, 'the claim must be released');
    assert.equal((await request(makeApp()).post('/api/setup').send(GOOD)).status, 201);
    assert.equal(db.admins.length, 1);
    assert.equal(db.locks.length, 1);
  });
});

test('when the winner fails during a race, the claim is not left behind', async () => {
  await withEnv(LOCAL, async (db) => {
    db.failCreate = 1;
    const codes = (await Promise.all([
      request(makeApp()).post('/api/setup').send(GOOD),
      request(makeApp()).post('/api/setup').send(GOOD)
    ])).map((r) => r.status).sort();
    assert.ok(codes.includes(500), String(codes));
    assert.ok(db.admins.length <= 1);
    assert.equal(db.locks.length, db.admins.length, 'a claim exists only while an owner exists');
    if (db.admins.length === 0) assert.equal((await request(makeApp()).post('/api/setup').send(GOOD)).status, 201);
    assert.equal(db.admins.length, 1);
  });
});

test('a claim left by a dead process is taken over after a while, a fresh one is not', async () => {
  await withEnv(LOCAL, async (db) => {
    db.locks.push({ _id: LOCK_ID, createdAt: new Date() });
    assert.equal((await request(makeApp()).post('/api/setup').send(GOOD)).status, 409);
    assert.equal(db.admins.length, 0);
    db.locks[0].createdAt = new Date(Date.now() - 10 * 60 * 1000);
    assert.equal((await request(makeApp()).post('/api/setup').send(GOOD)).status, 201);
    assert.equal(db.admins.length, 1);
    assert.equal(db.locks.length, 1);
  });
});
