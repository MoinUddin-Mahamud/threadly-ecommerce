// Chatbot retry and fallback models, reopen and cancel safety, coupon keys, payout hold, passwords.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getChatReply } = require('../services/llm');
const { modelList } = require('../services/llm/config');
const { parseRetryAfter, retryDelayMs } = require('../services/llm/retry');
const Order = require('../models/Order');
const User = require('../models/User');
const orderService = require('../services/orderService');
const marketplace = require('../services/marketplace');
const { normalizeCustomerKey } = require('../services/couponService');
const { takeChatBudget } = require('../routes/api');
const { brandName } = require('../services/brand');

async function withStubs(stubs, fn) {
  const saved = stubs.map(([target, name]) => [target, name, target[name]]);
  stubs.forEach(([target, name, impl]) => { target[name] = impl; });
  try { await fn(); } finally { saved.forEach(([target, name, original]) => { target[name] = original; }); }
}
const quiet = [console, 'error', () => {}];
const quietLog = [console, 'log', () => {}];

const reply = (status, body = {}, headers = {}) => ({
  ok: status < 400, status,
  headers: { get: (k) => headers[String(k).toLowerCase()] || null },
  text: async () => JSON.stringify(body),
  json: async () => body
});
const answer = (text) => reply(200, { candidates: [{ content: { parts: [{ text }] } }] });
const ENV = { GEMINI_API_KEY: 'real-key-123', GEMINI_MODEL: 'primary-model', GEMINI_FALLBACK_MODELS: 'backup-model', GEMINI_RETRY_BASE_MS: '1', GEMINI_MAX_RETRIES: '1' };
const modelOf = (url) => url.match(/models\/([^:]+):/)[1];
function script(...steps) {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(modelOf(url)); const s = steps[Math.min(urls.length - 1, steps.length - 1)]; if (s instanceof Error) throw s; return s; };
  return { urls, fetchImpl, sleep: async () => {} };
}

test('a 503 is retried on the same model and then answers', async () => {
  const s = script(reply(503), answer('Hello!'));
  await withStubs([quiet, quietLog], async () => {
    assert.equal(await getChatReply({ userMessage: 'hi', env: ENV, fetch: s.fetchImpl, sleep: s.sleep }), 'Hello!');
  });
  assert.deepEqual(s.urls, ['primary-model', 'primary-model']);
});

test('a model that keeps failing hands over to the fallback model', async () => {
  const s = script(reply(429), reply(429), answer('From the backup'));
  await withStubs([quiet, quietLog], async () => {
    assert.equal(await getChatReply({ userMessage: 'hi', env: ENV, fetch: s.fetchImpl, sleep: s.sleep }), 'From the backup');
  });
  assert.deepEqual(s.urls, ['primary-model', 'primary-model', 'backup-model']);
});

test('a network error or timeout is retried', async () => {
  const s = script(new Error('socket hang up'), answer('Back again'));
  await withStubs([quiet, quietLog], async () => {
    assert.equal(await getChatReply({ userMessage: 'hi', env: ENV, fetch: s.fetchImpl, sleep: s.sleep }), 'Back again');
  });
  assert.equal(s.urls.length, 2);
});

test('a bad request or a bad key stops at once: retrying cannot fix it', async () => {
  for (const status of [400, 401, 403]) {
    const s = script(reply(status), answer('never reached'));
    await withStubs([quiet], async () => {
      await assert.rejects(getChatReply({ userMessage: 'hi', env: ENV, fetch: s.fetchImpl, sleep: s.sleep }), (err) => err.status === status);
    });
    assert.equal(s.urls.length, 1);
  }
});

test('a model that does not exist (404) is skipped without retrying it', async () => {
  const s = script(reply(404), answer('Fallback ok'));
  await withStubs([quiet, quietLog], async () => {
    assert.equal(await getChatReply({ userMessage: 'hi', env: ENV, fetch: s.fetchImpl, sleep: s.sleep }), 'Fallback ok');
  });
  assert.deepEqual(s.urls, ['primary-model', 'backup-model']);
});

test('when everything fails the last error is thrown, and nothing loops forever', async () => {
  const s = script(reply(503));
  await withStubs([quiet], async () => {
    await assert.rejects(getChatReply({ userMessage: 'hi', env: ENV, fetch: s.fetchImpl, sleep: s.sleep }), (err) => err.status === 503);
  });
  assert.equal(s.urls.length, 4);   // 2 models x (1 try + 1 retry)
});

test('an empty reply counts as a failed attempt', async () => {
  const s = script(reply(200, { candidates: [] }), answer('Second time lucky'));
  await withStubs([quiet, quietLog], async () => {
    assert.equal(await getChatReply({ userMessage: 'hi', env: ENV, fetch: s.fetchImpl, sleep: s.sleep }), 'Second time lucky');
  });
});

test('Retry-After and the backoff are honoured and capped', () => {
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(parseRetryAfter('9999'), 10000);
  assert.equal(parseRetryAfter('nonsense'), 0);
  assert.equal(parseRetryAfter(null), 0);
  assert.equal(retryDelayMs(0, 0, 500, () => 0), 500);
  assert.equal(retryDelayMs(2, 0, 500, () => 0), 2000);
  assert.equal(retryDelayMs(0, 4000, 500, () => 0), 4000);      // never sooner than Google asked
});

test('only valid model names are used, and the primary comes first without duplicates', () => {
  assert.deepEqual(modelList({}), [], 'there is no built-in default model');
  assert.deepEqual(modelList({ GEMINI_MODEL: 'a-model', GEMINI_FALLBACK_MODELS: 'b-model, a-model ,bad name!,../x' }), ['a-model', 'b-model']);
});

test('no API key means no call', async () => {
  await assert.rejects(getChatReply({ userMessage: 'hi', env: { GEMINI_API_KEY: 'your-gemini-api-key', GEMINI_MODEL: 'primary-model' }, fetch: async () => { throw new Error('should not be called'); } }), /GEMINI_API_KEY/);
});

test('reopening a manual-payment order straight to CONFIRMED marks it paid', async () => {
  let update;
  await withStubs([
    [Order, 'findById', async () => ({ _id: 'o1', status: 'CANCELLED', stockReleased: false, paymentGateway: 'manual', paidAt: null, items: [] })],
    [Order, 'findOneAndUpdate', async (f, u) => { update = u; return { _id: 'o1', status: 'CONFIRMED' }; }]
  ], async () => {
    assert.equal((await orderService.reopenCancelledOrder('o1', 'CONFIRMED')).result, 'reopened');
  });
  assert.ok(update.paidAt instanceof Date, 'paidAt is set so revenue and seller earnings count it');
  assert.ok(update.reopenedAt instanceof Date, 'the expiry timer restarts from the reopen');
});

test('reopening a COD order does not mark it paid (it is paid on delivery)', async () => {
  let update;
  await withStubs([
    [Order, 'findById', async () => ({ _id: 'o1', status: 'CANCELLED', stockReleased: false, paymentGateway: 'cod', paidAt: null, items: [] })],
    [Order, 'findOneAndUpdate', async (f, u) => { update = u; return { _id: 'o1' }; }]
  ], async () => { await orderService.reopenCancelledOrder('o1', 'CONFIRMED'); });
  assert.equal(update.paidAt, undefined);
});

test('a gateway cancel or fail callback leaves an order held for payment review alone', async () => {
  let filter;
  await withStubs([[Order, 'findOneAndUpdate', async (f) => { filter = f; return null; }]], async () => {
    await orderService.cancelPendingOrder({ transactionId: 'TXN-1' });
  });
  assert.deepEqual(filter.paymentIssue, { $ne: 'PAYMENT_UNCONFIRMED' });
});

test('the unconfirmed-order timer counts from the reopen, not from creation', async () => {
  let filter;
  await withStubs([[Order, 'find', (f) => { filter = f; return { sort: () => ({ limit: async () => [] }) }; }]], async () => {
    await orderService.expireUnconfirmedCodOrders();
  });
  assert.ok(filter.reopenedAt && filter.reopenedAt.$not && filter.reopenedAt.$not.$gt instanceof Date);
});

test('the same mailbox is the same coupon customer', () => {
  assert.equal(normalizeCustomerKey(' Jane.Doe+sale@Gmail.com '), 'janedoe@gmail.com');
  assert.equal(normalizeCustomerKey('jane.doe@googlemail.com'), 'janedoe@gmail.com');
  assert.equal(normalizeCustomerKey('a.b+x@example.com'), 'a.b@example.com');   // dots only mean nothing at Gmail
  assert.equal(normalizeCustomerKey(''), null);
});

test('PAYOUT_HOLD_DAYS keeps delivered earnings pending until the hold is over', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const vendorId = '64b7f0c2a1b2c3d4e5f60aaa';
  const order = (daysAgo) => ({ status: 'CONFIRMED', fulfillment: [{ vendorId, status: 'DELIVERED', updatedAt: new Date(now - daysAgo * DAY) }] });
  assert.equal(marketplace.payoutHoldDays({}), 7, 'the default is a 7-day hold');
  assert.equal(marketplace.payoutHoldDays({ PAYOUT_HOLD_DAYS: '' }), 7);
  assert.equal(marketplace.payoutHoldDays({ PAYOUT_HOLD_DAYS: '0' }), 0, 'an explicit 0 still means no hold');
  assert.equal(marketplace.payoutHoldDays({ PAYOUT_HOLD_DAYS: '500' }), 90);
  assert.equal(marketplace.payoutHoldDays({ PAYOUT_HOLD_DAYS: 'x' }), 7, 'a value that is not a number falls back to the default, never to "no hold"');
  assert.equal(marketplace.isPayableNow(order(0), vendorId, now, { PAYOUT_HOLD_DAYS: '0' }), true);   // no hold
  assert.equal(marketplace.isPayableNow(order(0), vendorId, now, {}), false);                          // default hold
  assert.equal(marketplace.isPayableNow(order(8), vendorId, now, {}), true);
  assert.equal(marketplace.isPayableNow(order(3), vendorId, now, { PAYOUT_HOLD_DAYS: '7' }), false);
  assert.equal(marketplace.isPayableNow(order(8), vendorId, now, { PAYOUT_HOLD_DAYS: '7' }), true);
  const notDelivered = { status: 'CONFIRMED', fulfillment: [{ vendorId, status: 'SHIPPED', updatedAt: new Date(now) }] };
  assert.equal(marketplace.isPayableNow(notDelivered, vendorId, now, { PAYOUT_HOLD_DAYS: '0' }), false);
});

test('the daily chatbot ceiling stops further messages and starts over the next day', () => {
  const env = { CHAT_DAILY_LIMIT: '2' };
  const day1 = new Date('2030-01-01T10:00:00Z');
  assert.equal(takeChatBudget(day1, env), true);
  assert.equal(takeChatBudget(day1, env), true);
  assert.equal(takeChatBudget(day1, env), false);
  assert.equal(takeChatBudget(new Date('2030-01-02T00:00:01Z'), env), true);
  assert.equal(takeChatBudget(day1, { CHAT_DAILY_LIMIT: '0' }), true);   // 0 = no ceiling
});

test('a password longer than bcrypt can read (72 bytes) is refused, not silently cut short', async () => {
  const bad = await new User({ name: 'A', email: 'a@b.co', password: 'x'.repeat(73) }).validate().catch((e) => e);
  assert.ok(bad.errors && bad.errors.password);
  const ok = await new User({ name: 'A', email: 'a@b.co', password: 'x'.repeat(72) }).validate().catch((e) => e);
  assert.equal(ok, undefined);
});

test('the shop name for emails and the chatbot comes from SITE_NAME', () => {
  assert.equal(brandName({}), 'Threadly');
  assert.equal(brandName({ SITE_NAME: '  Blue Door <b>  ' }), 'Blue Door  b');
});
