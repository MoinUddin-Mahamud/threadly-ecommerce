// Setup page, demo mode, demo reset script, locale files and the language wiring.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const bcrypt = require('bcrypt');
const request = require('supertest');
const { app } = require('./helpers');
const Admin = require('../models/Admin');
const SetupLock = require('../models/SetupLock');

const pub = (f) => path.join(__dirname, '..', 'public', f);
const GOOD = { username: 'owner1', password: 'a-long-password-1' };

// An in-memory Admin collection and setup claim. create() waits a tick, like a real database write.
function fakeAdmins() {
  const rows = [];
  const locks = new Set();
  const saved = { findOne: Admin.findOne, create: Admin.create, lockCreate: SetupLock.create, lockDelete: SetupLock.deleteOne };
  Admin.findOne = async () => rows[0] || null;
  Admin.create = async (doc) => { await new Promise((r) => setImmediate(r)); rows.push(doc); return doc; };
  SetupLock.create = async (doc) => {
    if (locks.has(doc._id)) throw Object.assign(new Error('duplicate key'), { code: 11000 });
    locks.add(doc._id); return doc;
  };
  SetupLock.deleteOne = async (f) => ({ deletedCount: locks.delete(f._id) ? 1 : 0 });
  return {
    rows,
    restore: () => {
      Admin.findOne = saved.findOne; Admin.create = saved.create;
      SetupLock.create = saved.lockCreate; SetupLock.deleteOne = saved.lockDelete;
    }
  };
}
async function withSetup(env, fn) {
  const keys = ['ADMIN_USERNAME', 'ADMIN_PASSWORD_HASH', 'SETUP_TOKEN', 'NODE_ENV', 'BASE_URL'];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', BASE_URL: 'http://localhost:3000' }, env);
  const db = fakeAdmins();
  try { await fn(db); } finally {
    db.restore();
    for (const k of keys) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
  }
}

test('setup creates one owner with a hashed password, then closes', async () => {
  await withSetup({}, async (db) => {
    assert.equal((await request(app).get('/api/setup/status')).body.needed, true);
    const r = await request(app).post('/api/setup').send(GOOD);
    assert.equal(r.status, 201);
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0].role, 'owner');
    assert.notEqual(db.rows[0].passwordHash, GOOD.password);
    assert.ok(await bcrypt.compare(GOOD.password, db.rows[0].passwordHash));
    assert.equal((await request(app).get('/api/setup/status')).body.needed, false);
    assert.equal((await request(app).post('/api/setup').send({ username: 'attacker', password: 'another-password-2' })).status, 404);
    assert.equal(db.rows.length, 1);
  });
});

test('two setup requests at the same moment create only one owner', async () => {
  await withSetup({}, async (db) => {
    const [a, b] = await Promise.all([
      request(app).post('/api/setup').send(GOOD),
      request(app).post('/api/setup').send({ username: 'attacker', password: 'another-password-2' })
    ]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    assert.equal(db.rows.length, 1);
  });
});

test('the .env template placeholders do not count as an admin', async () => {
  await withSetup({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD_HASH: 'replace-with-output-of-scripts/hash-password.js' }, async () => {
    assert.equal((await request(app).get('/api/setup/status')).body.needed, true);
  });
});

test('a real .env admin closes setup', async () => {
  const hash = await bcrypt.hash('some-password-1', 4);
  await withSetup({ ADMIN_USERNAME: 'boss', ADMIN_PASSWORD_HASH: hash }, async (db) => {
    assert.equal((await request(app).get('/api/setup/status')).body.needed, false);
    assert.equal((await request(app).post('/api/setup').send(GOOD)).status, 404);
    assert.equal(db.rows.length, 0);
  });
});

test('in production setup needs SETUP_TOKEN', async () => {
  await withSetup({ NODE_ENV: 'production' }, async (db) => {
    assert.equal((await request(app).post('/api/setup').send(GOOD)).status, 503);
    process.env.SETUP_TOKEN = 'a-secret-token-1234';
    assert.equal((await request(app).post('/api/setup').send(GOOD)).status, 403);
    assert.equal((await request(app).post('/api/setup').send({ ...GOOD, setupToken: 'wrong-token-123456' })).status, 403);
    assert.equal(db.rows.length, 0);
    assert.equal((await request(app).post('/api/setup').send({ ...GOOD, setupToken: 'a-secret-token-1234' })).status, 201);
    assert.equal(db.rows.length, 1);
  });
});

test('setup rejects a weak password, a bad username and cross-site requests', async () => {
  await withSetup({}, async (db) => {
    assert.equal((await request(app).post('/api/setup').send({ username: 'owner1', password: 'short' })).status, 400);
    assert.equal((await request(app).post('/api/setup').send({ username: 'a b', password: GOOD.password })).status, 400);
    const x = await request(app).post('/api/setup').set('Origin', 'https://evil.example').send(GOOD);
    assert.equal(x.status, 403);
    assert.equal(db.rows.length, 0);
  });
});

test('demo mode refuses deletes and staff, role and password changes, but not reads', async () => {
  const saved = process.env.DEMO_MODE;
  process.env.DEMO_MODE = 'true';
  try {
    assert.equal((await request(app).delete('/admin/products/64b7f0c2a1b2c3d4e5f60999')).status, 403);
    assert.equal((await request(app).post('/admin/staff').send({ username: 'x1x1', password: 'a-long-password-1' })).status, 403);
    assert.equal((await request(app).post('/admin/roles').send({ name: 'Boss' })).status, 403);
    assert.notEqual((await request(app).get('/admin/csrf-token')).status, 403);
  } finally { if (saved === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = saved; }
});

test('demo:reset refuses to run without DEMO_MODE or without a password', () => {
  const run = (env) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'demo-reset.js')], { env: { ...process.env, ...env }, encoding: 'utf8' });
  const a = run({ DEMO_MODE: 'false', DEMO_ADMIN_PASSWORD: 'x'.repeat(12) });
  assert.equal(a.status, 1); assert.match(a.stderr, /DEMO_MODE=true/);
  const b = run({ DEMO_MODE: 'true', DEMO_ADMIN_PASSWORD: '' });
  assert.equal(b.status, 1); assert.match(b.stderr, /DEMO_ADMIN_PASSWORD/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'demo-reset.js'), 'utf8'), /demo-admin-2026/);
});

test('locale files: every key present, real translations, same placeholders', () => {
  const en = JSON.parse(fs.readFileSync(pub('locales/en.json'), 'utf8'));
  const script = { bn: /[\u0980-\u09FF]/, ar: /[\u0600-\u06FF]/, hi: /[\u0900-\u097F]/ };
  for (const l of ['bn', 'ar', 'es', 'fr', 'hi']) {
    const d = JSON.parse(fs.readFileSync(pub(`locales/${l}.json`), 'utf8'));
    let same = 0;
    for (const k of Object.keys(en)) {
      assert.ok(d[k] && d[k].trim(), `${l} is missing ${k}`);
      if (d[k] === en[k]) same++;
      if (script[l]) assert.match(d[k], script[l], `${l}.${k} is not written in the ${l} script`);
      // the order may change: some languages put the values in a different place
      assert.deepEqual((d[k].match(/\{\w+\}/g) || []).sort(), (en[k].match(/\{\w+\}/g) || []).sort(), `${l}.${k} changes a placeholder`);
    }
    assert.ok(same / Object.keys(en).length < 0.2, `${l} leaves too many strings in English`);
  }
});

test('every customer page loads the language script after brand.js; admin, setup and offline do not', () => {
  for (const f of fs.readdirSync(pub('.')).filter((n) => n.endsWith('.html'))) {
    const html = fs.readFileSync(pub(f), 'utf8');
    if (['admin.html', 'setup.html', 'offline.html'].includes(f)) { assert.ok(!html.includes('/js/i18n.js'), f); continue; }
    assert.ok(html.includes('/js/i18n.js'), `${f} has no language script`);
    assert.ok(html.indexOf('/js/brand.js') < html.indexOf('/js/i18n.js'), `${f} loads i18n before brand`);
  }
});

test('right-to-left: the script sets dir and swaps in the RTL Bootstrap build', () => {
  const js = fs.readFileSync(pub('js/i18n.js'), 'utf8');
  assert.match(js, /RTL = \{ ar: true \}/);
  assert.match(js, /documentElement\.dir = RTL\[l\] \? 'rtl' : 'ltr'/);
  assert.match(js, /document\.cookie\.match/);
  assert.match(js, /bootstrap\.rtl\.min\.css/);
});

test('checkout form ids are still in the page', () => {
  const html = fs.readFileSync(pub('index.html'), 'utf8');
  for (const id of ['checkoutForm', 'customerName', 'customerEmail', 'cartCouponCode', 'cartTotal']) assert.match(html, new RegExp(`id="${id}"`));
});
