// Tests for: admin hash survives Docker, email placeholders / port 465 / timeouts,
// the favicon, and the SSLCommerz library working with the patched form-data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dotenv = require('dotenv');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const { adminHashProblem } = require('../config/envCheck');

const ROOT = path.join(__dirname, '..');
const VALID_HASH = bcrypt.hashSync('Password123', 4);

// Sets environment variables for one test and restores them afterwards
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { await fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
async function withStubs(stubs, fn) {
  const saved = stubs.map(([target, name]) => [target, name, target[name]]);
  stubs.forEach(([target, name, impl]) => { target[name] = impl; });
  try { await fn(); } finally { saved.forEach(([target, name, original]) => { target[name] = original; }); }
}
// emailService caches its mail connection, so tests load a fresh copy
function freshEmailService() {
  delete require.cache[require.resolve('../services/emailService')];
  return require('../services/emailService');
}

test('a valid bcrypt hash passes; missing or mangled hashes are reported', () => {
  assert.equal(adminHashProblem(VALID_HASH), null);
  assert.match(adminHashProblem(undefined), /missing/);
  assert.match(adminHashProblem('   '), /missing/);
  assert.match(adminHashProblem('replace-with-output-of-scripts/hash-password.js'), /bcrypt/);
  assert.match(adminHashProblem(VALID_HASH.slice(0, 40)), /bcrypt/);   // truncated
});

test('hash-password prints a single-quoted line that loads back as the exact hash', () => {
  const result = spawnSync(process.execPath, ['scripts/hash-password.js', 'My Test Password 1'], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.split('\n').find((l) => l.startsWith('ADMIN_PASSWORD_HASH='));
  assert.match(line, /^ADMIN_PASSWORD_HASH='\$2b\$12\$[./A-Za-z0-9]{53}'$/, 'value must be wrapped in single quotes');

  const loaded = dotenv.parse(line).ADMIN_PASSWORD_HASH;          // what the app reads from .env
  assert.equal(adminHashProblem(loaded), null);
  assert.equal(bcrypt.compareSync('My Test Password 1', loaded), true);
  assert.equal(bcrypt.compareSync('wrong password', loaded), false);
});

test('a hash mangled by $variable substitution (what Docker Compose does) is detected', () => {
  // Compose replaces $name with an empty string when the name looks like a variable.
  // Fixed hash whose salt starts with a letter, so the substitution always applies
  // (a random bcrypt salt starts with a digit, "." or "/" about one time in five).
  const hash = '$2b$04$cYRCxx7LzQ0tqzHq1x2l5uK1v9mS3aB4cD5eF6gH7iJ8kL9mN0oPq';
  assert.equal(adminHashProblem(hash), null);
  const mangled = hash.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, '');
  assert.notEqual(mangled, hash, 'the substitution must change the hash');
  const problem = adminHashProblem(mangled);
  assert.match(problem, /single quotes/);
  assert.match(problem, /hash-password\.js/);
});

test('a hash that still has quote characters around it gets the opposite advice', () => {
  const problem = adminHashProblem(`'${VALID_HASH}'`);
  assert.match(problem, /without the surrounding quotes/);
  assert.doesNotMatch(problem, /wrap the value/);
  assert.match(adminHashProblem(`"${VALID_HASH}"`), /without the surrounding quotes/);
  assert.match(adminHashProblem(`'${VALID_HASH.slice(0, 30)}'`), /single quotes/);   // damaged AND quoted: normal advice
});

test('the example email values from .env.example count as "not configured"', () => {
  const { isEmailConfigured } = freshEmailService();
  const example = dotenv.parse(fs.readFileSync(path.join(ROOT, '.env.example')));
  assert.ok(example.EMAIL_HOST && example.EMAIL_USER && example.EMAIL_PASS, '.env.example still shows email example values');
  assert.equal(isEmailConfigured(example), false);
});

test('email counts as configured only with real values for all three settings', () => {
  const { isEmailConfigured } = freshEmailService();
  const real = { EMAIL_HOST: 'smtp.gmail.com', EMAIL_USER: 'shop@mystore.com', EMAIL_PASS: 'abcd efgh ijkl mnop' };
  assert.equal(isEmailConfigured(real), true);
  assert.equal(isEmailConfigured({ ...real, EMAIL_HOST: undefined }), false);
  assert.equal(isEmailConfigured({ ...real, EMAIL_USER: '' }), false);
  assert.equal(isEmailConfigured({ ...real, EMAIL_PASS: '   ' }), false);
  assert.equal(isEmailConfigured({ ...real, EMAIL_USER: 'someone@example.com' }), false);
  assert.equal(isEmailConfigured({ ...real, EMAIL_HOST: 'smtp.example.com' }), false);
  assert.equal(isEmailConfigured({ ...real, EMAIL_PASS: 'your-email-app-password' }), false);
  assert.equal(isEmailConfigured({ ...real, EMAIL_HOST: 'mail.example.com' }), false);
});

test('real values that merely start with your / change / replace are not mistaken for placeholders', () => {
  const { isEmailConfigured } = freshEmailService();
  const real = { EMAIL_HOST: 'smtp.gmail.com', EMAIL_USER: 'shop@mystore.com', EMAIL_PASS: 'abcd efgh ijkl mnop' };
  assert.equal(isEmailConfigured({ ...real, EMAIL_USER: 'your-shop@gmail.com' }), true);
  assert.equal(isEmailConfigured({ ...real, EMAIL_USER: 'change_orders@mystore.com' }), true);
  assert.equal(isEmailConfigured({ ...real, EMAIL_PASS: 'Change_Me_2025' }), true);
  assert.equal(isEmailConfigured({ ...real, EMAIL_PASS: 'your-secret-9x' }), true);
});

test('port 465 uses a secure connection, 587 does not, and EMAIL_SECURE overrides', () => {
  const { useSecureConnection } = freshEmailService();
  assert.equal(useSecureConnection({ EMAIL_PORT: '465' }), true);
  assert.equal(useSecureConnection({ EMAIL_PORT: '587' }), false);
  assert.equal(useSecureConnection({ EMAIL_PORT: '25' }), false);
  assert.equal(useSecureConnection({}), false);
  assert.equal(useSecureConnection({ EMAIL_PORT: '587', EMAIL_SECURE: 'true' }), true);
  assert.equal(useSecureConnection({ EMAIL_PORT: '465', EMAIL_SECURE: 'false' }), false);
  assert.equal(useSecureConnection({ EMAIL_PORT: '587', EMAIL_SECURE: 'TRUE' }), true);
  assert.equal(useSecureConnection({ EMAIL_PORT: '587', EMAIL_SECURE: ' True ' }), true);
  assert.equal(useSecureConnection({ EMAIL_PORT: '465', EMAIL_SECURE: ' FALSE' }), false);
  assert.equal(useSecureConnection({ EMAIL_PORT: '465', EMAIL_SECURE: 'maybe' }), true);   // unknown value: port guess
});

async function transportOptionsFor(port) {
  let options = null;
  await withEnv({ EMAIL_HOST: 'smtp.mystore-mail.com', EMAIL_PORT: port, EMAIL_USER: 'shop@mystore.com', EMAIL_PASS: 'real-secret-value', EMAIL_SECURE: undefined }, async () => {
    await withStubs([[nodemailer, 'createTransport', (o) => { options = o; return { sendMail: async () => ({}) }; }]], async () => {
      const email = freshEmailService();
      assert.equal(await email.sendVerificationEmail({ name: 'A', email: 'a@b.org' }, 'http://x/y'), true);
    });
  });
  return options;
}

test('the mail transport is secure on 465, plain+STARTTLS on 587, and always has short timeouts', async () => {
  const on465 = await transportOptionsFor('465');
  const on587 = await transportOptionsFor('587');
  assert.equal(on465.secure, true);
  assert.equal(on587.secure, false);
  for (const o of [on465, on587]) {
    assert.ok(o.connectionTimeout > 0 && o.connectionTimeout <= 15000, 'connection timeout');
    assert.ok(o.greetingTimeout > 0 && o.greetingTimeout <= 15000, 'greeting timeout');
    assert.ok(o.socketTimeout > 0 && o.socketTimeout <= 30000, 'socket timeout');
  }
});

test('with the example email values no verification link is written to the log', async () => {
  const logs = [];
  let triedToConnect = false;
  await withEnv({ EMAIL_HOST: 'smtp.example.com', EMAIL_PORT: '587', EMAIL_USER: 'your-email@example.com', EMAIL_PASS: 'your-email-app-password' }, async () => {
    await withStubs([
      [console, 'log', (...a) => logs.push(a.join(' '))],
      [console, 'warn', () => {}],
      [nodemailer, 'createTransport', () => { triedToConnect = true; return { sendMail: async () => ({}) }; }]
    ], async () => {
      const email = freshEmailService();
      const sent = await email.sendVerificationEmail({ name: 'A', email: 'buyer@x.org' }, 'http://localhost:3000/api/users/verify-email?token=abc');
      assert.equal(sent, false);
    });
  });
  assert.equal(triedToConnect, false, 'no connection attempt to smtp.example.com');
  assert.ok(logs.some((l) => l.includes('buyer@x.org') && l.includes('skipped')), 'the skipped message names the address');
  assert.ok(!logs.some((l) => l.includes('token=abc')), 'the token is never logged');
});

test('without email settings the password reset link and token are not written to the log', async () => {
  const logs = [];
  await withStubs([
    [console, 'log', (...a) => logs.push(a.join(' '))],
    [console, 'warn', () => {}]
  ], async () => {
    const email = freshEmailService();
    const sent = await email.sendPasswordResetEmail({ name: 'A', email: 'buyer@x.org' }, 'http://localhost:3000/#resetToken=abc');
    assert.equal(sent, false);
  });
  assert.ok(logs.some((l) => l.includes('buyer@x.org') && l.includes('skipped')));
  assert.ok(!logs.some((l) => l.includes('resetToken') || l.includes('abc')));
});

test('every page has a favicon that exists', () => {
  const pages = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.html'));
  assert.ok(pages.length >= 4);
  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, 'public', page), 'utf8');
    const m = html.match(/<link rel="icon"[^>]*href="([^"]+)"/);
    assert.ok(m, `${page} needs <link rel="icon">`);
    assert.ok(fs.existsSync(path.join(ROOT, 'public', m[1])), `${page}: ${m[1]} must exist`);
  }
});

test('sslcommerz-lts uses form-data 4 or newer (the version without the known advisory)', () => {
  const libDir = path.dirname(require.resolve('sslcommerz-lts'));
  const pkg = require(require.resolve('form-data/package.json', { paths: [libDir] }));
  assert.ok(parseInt(pkg.version, 10) >= 4, `found form-data ${pkg.version}`);
});

test('sslcommerz-lts still builds a correct multipart payment request', async () => {
  const libDir = path.dirname(require.resolve('sslcommerz-lts'));
  const fetchPath = require.resolve('node-fetch', { paths: [libDir] });
  const original = require.cache[fetchPath];
  let captured = null;
  // fake for the network call: read the request body the library built
  require.cache[fetchPath] = { id: fetchPath, filename: fetchPath, loaded: true, exports: async (url, opts) => {
    const chunks = [];
    await new Promise((resolve, reject) => { opts.body.on('data', (c) => chunks.push(Buffer.from(c))); opts.body.on('end', resolve); opts.body.on('error', reject); opts.body.resume(); });   // form-data streams start paused
    captured = { url, headers: opts.headers || {}, contentType: opts.body.getHeaders()['content-type'], body: Buffer.concat(chunks).toString() };
    return { json: async () => ({ status: 'SUCCESS', GatewayPageURL: 'https://sandbox.example/pay' }) };
  } };
  try {
    delete require.cache[require.resolve('sslcommerz-lts')];
    delete require.cache[require.resolve('sslcommerz-lts/api/payment-controller')];
    const Ssl = require('sslcommerz-lts');
    const result = await new Ssl('store', 'pass', false).init({
      total_amount: 100, currency: 'XXX', tran_id: 'TXN-1', success_url: 'http://a/s', fail_url: 'http://a/f', cancel_url: 'http://a/c', ipn_url: 'http://a/i',
      product_name: 'x', product_category: 'c', product_profile: 'general', cus_name: 'Bob', cus_email: 'b@x.com', cus_add1: 'a', cus_city: 'c',
      cus_postcode: '1', cus_country: 'BD', cus_phone: '017', shipping_method: 'NO', num_of_item: 1
    });
    assert.equal(result.GatewayPageURL, 'https://sandbox.example/pay');
    assert.match(captured.contentType, /^multipart\/form-data; boundary=/);
    assert.match(captured.body, /name="store_id"\r\n\r\nstore/);
    assert.match(captured.body, /name="tran_id"\r\n\r\nTXN-1/);
    assert.match(captured.body, /name="total_amount"\r\n\r\n100/);
  } finally {
    if (original) require.cache[fetchPath] = original; else delete require.cache[fetchPath];
    delete require.cache[require.resolve('sslcommerz-lts')];
    delete require.cache[require.resolve('sslcommerz-lts/api/payment-controller')];
  }
});
