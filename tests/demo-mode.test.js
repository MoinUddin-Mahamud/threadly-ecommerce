// Demo mode: blocked routes, the reset guard and what the reset removes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const request = require('supertest');
const { app } = require('./helpers');
const { demoResetProblem } = require('../scripts/lib/demoGuard');
const { purgeDemoData } = require('../scripts/lib/demoPurge');

const ID = '64b7f0c2a1b2c3d4e5f60999';
const BLOCKED = [
  ['patch', `/admin/vendors/${ID}`],
  ['post', `/admin/vendors/${ID}/payouts`],
  ['put', `/admin/orders/${ID}/mark-refunded`]
];

async function demo(on, fn) {
  const saved = process.env.DEMO_MODE;
  if (on) process.env.DEMO_MODE = 'true'; else delete process.env.DEMO_MODE;
  try { await fn(); } finally { if (saved === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = saved; }
}

for (const [method, url] of BLOCKED) {
  test(`demo mode refuses ${method.toUpperCase()} ${url.replace(ID, ':id')}`, async () => {
    await demo(true, async () => {
      const r = await request(app)[method](url).send({ status: 'approved' });
      assert.equal(r.status, 403);
      assert.match(r.body.message, /demo mode/i);
    });
    await demo(false, async () => {
      const r = await request(app)[method](url).send({ status: 'approved' });
      assert.notEqual(r.status, 403, 'outside demo mode the route answers for itself (login required)');
      assert.equal(r.status, 401);
    });
  });
}

test('demo mode still allows reading vendors and orders', async () => {
  await demo(true, async () => {
    for (const url of ['/admin/vendors', `/admin/vendors/${ID}/earnings`]) {
      assert.notEqual((await request(app).get(url)).status, 403, url);
    }
  });
});

test('demo mode refuses the same routes through other write methods', async () => {
  await demo(true, async () => {
    assert.equal((await request(app).put(`/admin/vendors/${ID}`).send({})).status, 403);
    assert.equal((await request(app).post(`/admin/orders/${ID}/mark-refunded`).send({})).status, 403);
    assert.equal((await request(app).patch(`/admin/orders/${ID}/mark-refunded`).send({})).status, 403);
  });
});

const run = (env) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'demo-reset.js')], {
  env: { PATH: process.env.PATH, ...env }, encoding: 'utf8'
});
const PW = 'x'.repeat(12);

test('demo:reset refuses without DEMO_MODE=true', () => {
  const r = run({ DEMO_MODE: 'false', DEMO_ADMIN_PASSWORD: PW, DB_NAME: 'shop_demo' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /DEMO_MODE=true/);
});

test('demo:reset refuses without DEMO_ADMIN_PASSWORD', () => {
  const r = run({ DEMO_MODE: 'true', DB_NAME: 'shop_demo' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /DEMO_ADMIN_PASSWORD/);
});

test('demo:reset refuses a database whose name has no "demo"', () => {
  for (const db of ['ecommerce', 'shop', undefined]) {
    const r = run({ DEMO_MODE: 'true', DEMO_ADMIN_PASSWORD: PW, MONGODB_URI: 'mongodb://127.0.0.1:1', ...(db ? { DB_NAME: db } : {}) });
    assert.equal(r.status, 1, String(db));
    assert.match(r.stderr, /does not contain "demo"/, String(db));
    assert.doesNotMatch(r.stdout, /Removed:/);
  }
});

test('demo:reset gets past the guard for a demo database or DEMO_ALLOW_ANY_DB', () => {
  // No MONGODB_URI, so it stops right after the guard, before touching any database.
  for (const env of [{ DB_NAME: 'threadly_demo' }, { DB_NAME: 'Demo2' }, { DB_NAME: 'shop', DEMO_ALLOW_ANY_DB: 'true' }]) {
    const r = run({ DEMO_MODE: 'true', DEMO_ADMIN_PASSWORD: PW, ...env });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /MONGODB_URI is missing/, JSON.stringify(env));
  }
});

test('guard function: every condition is checked', () => {
  const ok = { DEMO_MODE: 'true', DEMO_ADMIN_PASSWORD: PW, DB_NAME: 'my_demo' };
  assert.equal(demoResetProblem(ok), null);
  assert.equal(demoResetProblem({ ...ok, DEMO_MODE: 'yes' }) !== null, true);
  assert.equal(demoResetProblem({ ...ok, DEMO_ADMIN_PASSWORD: '' }) !== null, true);
  assert.equal(demoResetProblem({ ...ok, DB_NAME: 'ecommerce' }) !== null, true);
  assert.equal(demoResetProblem({ ...ok, DB_NAME: 'ecommerce', DEMO_ALLOW_ANY_DB: 'true' }), null);
  assert.equal(demoResetProblem({ ...ok, DB_NAME: 'ecommerce', DEMO_ALLOW_ANY_DB: '1' }) !== null, true);
});

test('demo:reset removes orders, coupons, redemptions, reviews, payouts and customers', async () => {
  const models = ['Order', 'Coupon', 'CouponRedemption', 'Review', 'Payout', 'User'].map((n) => require(`../models/${n}`));
  const filters = [];
  const saved = models.map((m) => m.deleteMany);
  models.forEach((m) => { m.deleteMany = async (f) => { filters.push([m.modelName, f]); return { deletedCount: 3 }; }; });
  try {
    const counts = await purgeDemoData();
    assert.deepEqual(filters.map(([n]) => n).sort(), ['Coupon', 'CouponRedemption', 'Order', 'Payout', 'Review', 'User']);
    assert.ok(filters.every(([, f]) => Object.keys(f).length === 0));
    assert.equal(Object.keys(counts).length, 6);
    assert.ok(Object.values(counts).every((n) => n === 3));
  } finally { models.forEach((m, i) => { m.deleteMany = saved[i]; }); }
});

test('demo:reset does not touch admins, roles, products or shops', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'demoPurge.js'), 'utf8');
  for (const name of ['Admin', 'Role', 'Product', 'Vendor']) assert.doesNotMatch(src, new RegExp(`models/${name}'`));
});
