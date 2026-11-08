// Tests for login lockout, mail caps, chat bookkeeping,
// COD limits and settings, the picture fallback, noindex paths and a few smaller rules.
// None of these needs a database, so the file also runs without the fakes in helpers.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('loginGuard locks an account after repeated failures and a success clears the count', () => {
  const g = require('../services/loginGuard');
  g.reset();
  const t0 = 1_000_000;
  for (let i = 0; i < g.MAX_FAILURES - 1; i++) g.recordFailure('user', 'A@x.com', t0 + i);
  assert.equal(g.lockedFor('user', 'a@x.com', t0 + 100), 0, 'not locked yet (and the email is case-insensitive)');
  g.recordFailure('user', 'a@x.com', t0 + 200);
  assert.ok(g.lockedFor('user', 'a@x.com', t0 + 300) > 0, 'locked');
  assert.equal(g.lockedFor('admin', 'a@x.com', t0 + 300), 0, 'scopes are separate');
  assert.equal(g.lockedFor('user', 'other@x.com', t0 + 300), 0, 'other accounts are not affected');
  assert.equal(g.lockedFor('user', 'a@x.com', t0 + 200 + g.LOCK_MS + 1), 0, 'the lock ends');
  g.reset();
  for (let i = 0; i < 5; i++) g.recordFailure('user', 'b@x.com', t0);
  g.recordSuccess('user', 'b@x.com');
  for (let i = 0; i < 5; i++) g.recordFailure('user', 'b@x.com', t0);
  assert.equal(g.lockedFor('user', 'b@x.com', t0 + 1), 0, 'a success starts the count again');
});

test('failures older than the window do not add up to a lock', () => {
  const g = require('../services/loginGuard');
  g.reset();
  const t0 = 2_000_000;
  for (let i = 0; i < g.MAX_FAILURES - 1; i++) g.recordFailure('user', 'slow@x.com', t0);
  g.recordFailure('user', 'slow@x.com', t0 + g.WINDOW_MS + 1);
  assert.equal(g.lockedFor('user', 'slow@x.com', t0 + g.WINDOW_MS + 2), 0);
});

test('both logins use the guard, and a password reset lifts a customer lock', () => {
  for (const f of ['routes/users.js', 'routes/admin.js']) {
    const src = read(f);
    assert.match(src, /loginGuard\.lockedFor\(/, f);
    assert.match(src, /loginGuard\.recordFailure\(/, f);
    assert.match(src, /loginGuard\.recordSuccess\(/, f);
  }
  const users = read('routes/users.js');
  const reset = users.slice(users.indexOf("router.post('/reset-password'"), users.indexOf("router.post('/change-password'"));
  assert.match(reset, /loginGuard\.recordSuccess\('user'/);
});

test('mailBudget caps what one address receives per hour', () => {
  const m = require('../services/mailBudget');
  m.reset();
  const t0 = 5_000_000;
  for (let i = 0; i < m.LIMITS.order; i++) assert.equal(m.allow('order', 'V@x.com', t0 + i), true);
  assert.equal(m.allow('order', 'v@x.com', t0 + 10), false);
  assert.equal(m.allow('link', 'v@x.com', t0 + 10), true, 'links are counted separately');
  assert.equal(m.allow('order', 'v@x.com', t0 + m.WINDOW_MS + 100), true, 'the hour passes');
  assert.equal(m.allow('order', '', t0), true);
});

test('wouldAllow looks without counting', () => {
  const m = require('../services/mailBudget');
  m.reset();
  const t0 = 6_000_000;
  for (let i = 0; i < 10; i++) assert.equal(m.wouldAllow('link', 'p@x.com', t0), true, 'looking never uses up the budget');
  for (let i = 0; i < m.LIMITS.link; i++) assert.equal(m.allow('link', 'p@x.com', t0 + i), true);
  assert.equal(m.wouldAllow('link', 'p@x.com', t0 + 10), false);
  assert.equal(m.wouldAllow('link', 'p@x.com', t0 + m.WINDOW_MS + 100), true);
});

test('a new reset or verification link is only issued when its email may be sent', () => {
  const users = read('routes/users.js');
  const forgot = users.slice(users.indexOf("router.post('/forgot-password'"), users.indexOf("router.post('/reset-password'"));
  assert.ok(forgot.indexOf("mailBudget.wouldAllow('link'") > 0 && forgot.indexOf("mailBudget.wouldAllow('link'") < forgot.indexOf('randomBytes'));
  const resend = users.slice(users.indexOf("router.post('/resend-verification'"), users.indexOf('// Paginated history'));
  assert.ok(resend.indexOf("mailBudget.wouldAllow('link'") > 0 && resend.indexOf("mailBudget.wouldAllow('link'") < resend.indexOf('newVerificationToken()'));
});

test('if saving a new password fails, the reset link is given back', () => {
  const users = read('routes/users.js');
  const reset = users.slice(users.indexOf("router.post('/reset-password'"), users.indexOf("router.post('/change-password'"));
  assert.match(reset, /catch \(saveErr\)/);
  assert.match(reset, /\$set: \{ resetTokenHash: tokenHash, resetTokenExpires: restoredExpiry \}/);
});

test('chat history lives in memory under a random cookie, not in the session', () => {
  const c = require('../services/chatClients');
  c.reset();
  const cookies = [];
  const res = { cookie: (n, v, o) => cookies.push([n, v, o]) };
  const id = c.clientId({ headers: {} }, res);
  assert.match(id, /^[a-f0-9]{32}$/);
  assert.equal(cookies[0][0], c.COOKIE);
  assert.equal(cookies[0][2].httpOnly, true);
  assert.equal(c.clientId({ headers: { cookie: `x=1; ${c.COOKIE}=${id}` } }, res), id, 'a valid cookie is reused');
  assert.notEqual(c.clientId({ headers: { cookie: `${c.COOKIE}=not-valid` } }, res), 'not-valid');
  c.saveTurns(id, [{ role: 'user', text: 'hi' }, { role: 'bot', text: 'hello' }]);
  assert.equal(c.getTurns(id).length, 2);
  assert.deepEqual(c.getTurns('0'.repeat(32)), [], 'another visitor sees nothing');
  assert.equal(c.getTurns(id, Date.now() + 31 * 60 * 1000).length, 0, 'forgotten after 30 minutes');
  assert.doesNotMatch(read('routes/api.js'), /req\.session\.chat/);
});

test('the chat cookie is Secure in production unless COOKIE_SECURE says otherwise', () => {
  const c = require('../services/chatClients');
  const secureFor = (env) => {
    const cookies = [];
    c.clientId({ headers: {} }, { cookie: (n, v, o) => cookies.push(o) }, env);
    return cookies[0].secure;
  };
  assert.equal(secureFor({ NODE_ENV: 'production' }), true);
  assert.equal(secureFor({ NODE_ENV: 'test' }), false);
  assert.equal(secureFor({ NODE_ENV: 'production', COOKIE_SECURE: 'false' }), false, 'plain HTTP production');
  assert.equal(secureFor({ NODE_ENV: 'test', COOKIE_SECURE: ' TRUE ' }), true);
  assert.equal(secureFor({ NODE_ENV: 'production', COOKIE_SECURE: '' }), true, 'empty means the default');
});

test('one address cannot use the whole chat budget', () => {
  const c = require('../services/chatClients');
  c.reset();
  const env = { CHAT_DAILY_LIMIT_PER_IP: '3' };
  const day = new Date('2030-01-01T10:00:00Z');
  for (let i = 0; i < 3; i++) assert.equal(c.takeAddressBudget('1.1.1.1', day, env), true);
  assert.equal(c.takeAddressBudget('1.1.1.1', day, env), false);
  assert.equal(c.takeAddressBudget('2.2.2.2', day, env), true);
  c.refundAddressBudget('1.1.1.1');
  assert.equal(c.takeAddressBudget('1.1.1.1', day, env), true);
  assert.equal(c.takeAddressBudget('1.1.1.1', new Date('2030-01-02T00:00:01Z'), env), true, 'new day');
  assert.equal(c.takeAddressBudget('9.9.9.9', day, { CHAT_DAILY_LIMIT_PER_IP: '0' }), true, '0 = no per-visitor limit');
  assert.equal(c.perAddressLimit({}), 100);
});

test('COD checkouts have their own tighter limit, applied before anything is reserved', () => {
  const src = read('routes/api.js');
  assert.match(src, /const codOrderLimiter = rateLimit\(/);
  const limiterAt = src.indexOf('codOrderLimiter(req, res,');
  assert.ok(limiterAt > 0);
  assert.ok(limiterAt < src.indexOf('await applyCoupon(couponCode'), 'before a coupon is claimed');
  assert.ok(limiterAt < src.indexOf('await reserveItems(orderItems, reserved)'), 'before stock is reserved');
  assert.match(src, /res\.once\('finish', resolve\)/, 'a request the limiter answered does not wait forever');
});

test('COD settings fall back to defaults when out of range', () => {
  const { codSettings } = require('../services/cod');
  const s = codSettings({ COD_CONFIRM_HOURS: '-5', COD_MAX_OPEN_ORDERS: '-1', COD_MAX_QUANTITY_PER_LINE: '0' });
  assert.equal(s.confirmHours, 24);
  assert.equal(s.maxOpenOrders, 2);
  assert.equal(s.maxQtyPerLine, 3);
  const ok = codSettings({ COD_CONFIRM_HOURS: '48', COD_MAX_OPEN_ORDERS: '5', COD_MAX_QUANTITY_PER_LINE: '10' });
  assert.deepEqual([ok.confirmHours, ok.maxOpenOrders, ok.maxQtyPerLine], [48, 5, 10]);
  assert.equal(codSettings({ COD_CONFIRM_HOURS: '100000' }).confirmHours, 24);
  assert.equal(codSettings({ COD_CONFIRM_HOURS: 'abc' }).confirmHours, 24);
});

test('the vendor status update also checks the order status, and the admin product list is capped', () => {
  assert.match(read('routes/vendor.js'), /\{ _id: order\._id, status: order\.status, fulfillment:/);
  const admin = read('routes/admin.js');
  assert.match(admin, /X-Has-More/);
  assert.match(admin, /\$limit: limit \+ 1/);
});

test('recipient addresses with list separators or quotes are refused', () => {
  const src = read('routes/api.js');
  const m = src.match(/if \(!\/(\^\[\^\\s@,;[^\n]+\$)\/\.test\(customerEmail\)/);
  assert.ok(m, 'the order route uses the strict address pattern');
  const re = new RegExp(m[1]);
  for (const bad of ['a@b.com,c.d', 'x@y.zz;q.rr', '"a"@b.com', 'a@b.com>', 'a b@c.de']) assert.equal(re.test(bad), false, bad);
  for (const good of ['a@b.com', 'a.b+c@mail.example.co']) assert.equal(re.test(good), true, good);
});

test('parseWholeStock accepts whole numbers only', () => {
  const { parseWholeStock } = require('../services/productRules');
  for (const [v, want] of [[5, 5], ['12', 12], [' 7 ', 7], [0, 0]]) assert.equal(parseWholeStock(v), want, String(v));
  for (const v of ['12abc', '1.5', 1.5, -1, '-3', true, null, undefined, '', 'abc', {}]) assert.equal(parseWholeStock(v), null, String(v));
});

test('the product page has no inline handler and uses the styled brand class', () => {
  const src = read('services/seo.js');
  assert.doesNotMatch(src, /onerror=/);
  assert.doesNotMatch(src, /mk-brand/);
  assert.match(src, /data-fallback-src="\/img\/logo\.svg"/);
  assert.match(src, /<script src="\/js\/img-fallback\.js"><\/script>/);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'public/js/img-fallback.js')));
});

test('seller and setup pages are noindex, and the manifest makes no maskable claim', () => {
  const seo = require('../services/seo');
  for (const p of ['/vendor.html', '/vendor', '/setup', '/setup.html']) assert.equal(seo.isNoindexPath(p), true, p);
  for (const p of ['/vendors', '/setupx', '/api/vendor']) assert.equal(seo.isNoindexPath(p), false, p);
  assert.doesNotMatch(read('routes/seo.js'), /maskable/);
});

test('the account model uses the same strict address rule as checkout', () => {
  assert.match(read('models/User.js'), /\[\^\\s@,;:<>\(\)\\\[\\\]"'\\\\\]\+@/);
});

test('the setup and login protections are all in place', () => {
  // A test keeps these protections from being dropped.
  assert.match(read('routes/api.js'), /payment\/paypal-webhook/);
  assert.match(read('services/passwordRules.js'), /too common/);
  assert.match(read('services/money.js'), /Invalid money amount/);
  assert.match(read('routes/admin.js'), /action: 'LOGIN'/);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'services/productUpdate.js')));
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'services/geminiService.js')));
});
