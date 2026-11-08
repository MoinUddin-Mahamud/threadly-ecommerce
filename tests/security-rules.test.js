// Tests for login with template values, the /setup token rule,
// /setup.html, the demo guard and no mail in demo mode.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
require('./helpers');
const request = require('supertest');
const Admin = require('../models/Admin');

const TEMPLATE_HASH = 'replace-with-output-of-scripts/hash-password.js';
const realOwner = () => ({ username: 'owner1', passwordHash: bcrypt.hashSync('a-long-password-1', 4), roles: ['Admin'], role: 'owner', active: true });

// admin.js reads ADMIN_USERNAME and the hash once, so load a fresh copy of the app for each case.
function freshApp(env) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  for (const k of Object.keys(require.cache)) if (/[\\/](routes[\\/]admin|server)\.js$/.test(k)) delete require.cache[k];
  const { app } = require('../server');
  return { app, restore() { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } } };
}

async function loginWithTemplate(hash) {
  const owner = realOwner();
  const orig = Admin.findOne;
  Admin.findOne = async (q) => (q && q.username && q.username !== owner.username ? null : owner);
  const { app, restore } = freshApp({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD_HASH: hash });
  try {
    const bypass = await request(app).post('/admin/login').send({ username: 'admin', password: 'no-env-admin' });
    const real = await request(app).post('/admin/login').send({ username: 'owner1', password: 'a-long-password-1' });
    return { bypass: bypass.status, real: real.status };
  } finally { Admin.findOne = orig; restore(); }
}

test('template .env values do not open a login with the built-in dummy password', async () => {
  const r = await loginWithTemplate(TEMPLATE_HASH);
  assert.equal(r.bypass, 401);
  assert.equal(r.real, 200);
});

test('a malformed hash does not open a login either', async () => {
  const r = await loginWithTemplate("'$2b$12$cut-short'");
  assert.equal(r.bypass, 401);
  assert.equal(r.real, 200);
});

test('a valid .env admin still logs in', async () => {
  const orig = Admin.findOne;
  Admin.findOne = async () => null;
  const { app, restore } = freshApp({ ADMIN_USERNAME: 'envowner', ADMIN_PASSWORD_HASH: bcrypt.hashSync('Env-pass-1234', 4) });
  try {
    const ok = await request(app).post('/admin/login').send({ username: 'envowner', password: 'Env-pass-1234' });
    const bad = await request(app).post('/admin/login').send({ username: 'envowner', password: 'no-env-admin' });
    assert.equal(ok.status, 200);
    assert.equal(bad.status, 401);
  } finally { Admin.findOne = orig; restore(); }
});

const { tokenRequired, requestIsLocal } = require('../routes/setup');
const LOCAL_ENV = { NODE_ENV: 'development', BASE_URL: 'http://localhost:3000' };
const localReq = (extra = {}) => ({ headers: { host: 'localhost:3000', ...(extra.headers || {}) }, socket: { remoteAddress: extra.addr || '127.0.0.1' } });

test('the setup token is optional only for a plain local request', () => {
  assert.equal(tokenRequired(LOCAL_ENV, localReq()), false);
  assert.equal(tokenRequired(LOCAL_ENV, localReq({ addr: '::ffff:127.0.0.1' })), false);
});

test('the setup token is required in each non-local case', () => {
  assert.equal(tokenRequired({ ...LOCAL_ENV, NODE_ENV: 'production' }, localReq()), true);
  assert.equal(tokenRequired({ ...LOCAL_ENV, BASE_URL: 'https://shop.example.com' }, localReq()), true);
  assert.equal(tokenRequired({ ...LOCAL_ENV, BASE_URL: '' }, localReq()), true);
  assert.equal(tokenRequired({ ...LOCAL_ENV, TRUST_PROXY: '1' }, localReq()), true);
  assert.equal(tokenRequired(LOCAL_ENV, localReq({ headers: { 'x-forwarded-for': '203.0.113.9' } })), true);
  assert.equal(tokenRequired(LOCAL_ENV, localReq({ headers: { forwarded: 'for=203.0.113.9' } })), true);
  assert.equal(tokenRequired(LOCAL_ENV, localReq({ headers: { host: 'shop.example.com' } })), true);
  assert.equal(tokenRequired(LOCAL_ENV, localReq({ addr: '203.0.113.9' })), true);
  assert.equal(tokenRequired(LOCAL_ENV, localReq({ addr: '192.168.1.20' })), true);
  assert.equal(tokenRequired({ ...LOCAL_ENV, SETUP_TOKEN: 'x'.repeat(16) }, localReq()), true);
});

test('requestIsLocal handles a missing request and an IPv6 host', () => {
  assert.equal(requestIsLocal(undefined), false);
  assert.equal(requestIsLocal({ headers: { host: '[::1]:3000' }, socket: { remoteAddress: '::1' } }), true);
});

test('the status endpoint applies the same token rule to a proxied request', async () => {
  const express = require('express');
  const { createSetupRouter } = require('../routes/setup');
  const saved = { ...process.env };
  Object.assign(process.env, LOCAL_ENV); delete process.env.SETUP_TOKEN; delete process.env.TRUST_PROXY;
  try {
    const app = express().use(express.json()).use('/api/setup', createSetupRouter());
    const direct = await request(app).get('/api/setup/status');
    const proxied = await request(app).get('/api/setup/status').set('X-Forwarded-For', '203.0.113.9');
    assert.equal(direct.body.tokenRequired, false);
    assert.equal(proxied.body.tokenRequired, true);
    assert.equal(proxied.body.tokenMissing, true);
    const post = await request(app).post('/api/setup').set('X-Forwarded-For', '203.0.113.9')
      .send({ username: 'attacker', password: 'another-password-2' });
    assert.equal(post.status, 503);
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
});

test('a wrong token is refused before the busy check', async () => {
  const express = require('express');
  const { createSetupRouter } = require('../routes/setup');
  const SetupLock = require('../models/SetupLock');
  const saved = { ...process.env };
  Object.assign(process.env, { NODE_ENV: 'production', SETUP_TOKEN: 'a-real-setup-token-123' });
  const origCreate = SetupLock.create, origFind = Admin.findOne;
  Admin.findOne = async () => null;
  SetupLock.create = async () => { await new Promise((r) => setTimeout(r, 50)); return {}; };
  try {
    const app = express().use(express.json()).use('/api/setup', createSetupRouter());
    const good = request(app).post('/api/setup').set('Origin', 'http://127.0.0.1').send({ setupToken: 'a-real-setup-token-123', username: 'owner1', password: 'a-long-password-1' });
    const first = good.then((r) => r);
    await new Promise((r) => setTimeout(r, 10));
    const wrong = await request(app).post('/api/setup').send({ setupToken: 'nope', username: 'x', password: 'y' });
    assert.equal(wrong.status, 403);
    await first;
  } finally { SetupLock.create = origCreate; Admin.findOne = origFind; for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
});

test('/setup.html redirects to /setup and does not serve the file', async () => {
  const { app } = require('../server');
  const r = await request(app).get('/setup.html');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/setup');
});

const demoMode = require('../middleware/demoMode');
function runGuard(method, baseUrl, path) {
  let out = null;
  demoMode({ method, baseUrl, path }, { status(c) { return { json(b) { out = { status: c, body: b }; } }; } }, () => { out = { next: true }; });
  return out;
}

test('demo mode refuses deletes, staff, vendor, payout and refund changes, and allows product edits', () => {
  process.env.DEMO_MODE = 'true';
  try {
    assert.equal(runGuard('DELETE', '/admin', '/products/1').status, 403);
    assert.equal(runGuard('POST', '/admin', '/staff').status, 403);
    assert.equal(runGuard('PATCH', '/admin', '/vendors/abc').status, 403);
    assert.equal(runGuard('POST', '/admin', '/vendors/abc/payouts').status, 403);
    assert.equal(runGuard('PUT', '/admin', '/orders/9/mark-refunded').status, 403);
    assert.equal(runGuard('PUT', '/admin', '/products/1').next, true);
    assert.equal(runGuard('GET', '/admin', '/staff').next, true);
    process.env.DEMO_MODE = 'false';
    assert.equal(runGuard('DELETE', '/admin', '/products/1').next, true);
  } finally { delete process.env.DEMO_MODE; }
});

test('demo mode sends no email even when SMTP is configured', async () => {
  const nodemailer = require('nodemailer');
  const email = require('../services/emailService');
  const saved = { ...process.env };
  Object.assign(process.env, { DEMO_MODE: 'true', EMAIL_HOST: 'smtp.real-host.net', EMAIL_USER: 'shop@real-host.net', EMAIL_PASS: 'a-real-password' });
  const origCreate = nodemailer.createTransport;
  let created = 0;
  nodemailer.createTransport = () => { created++; return { sendMail: async () => { created++; } }; };
  try {
    await email.sendStatusUpdate({ _id: 'o1', status: 'SHIPPED', customerEmail: 'a@b.co', customerName: 'A', items: [], totalAmount: 10 }).catch(() => {});
    await email.sendVerificationEmail({ email: 'a@b.co', name: 'A' }, 'http://localhost/x').catch(() => {});
    assert.equal(created, 0);
  } finally { nodemailer.createTransport = origCreate; for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
});
