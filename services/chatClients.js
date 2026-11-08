// Chat bookkeeping that never touches the session store:
//  - the last turns of a conversation, kept in memory under a random cookie (an anonymous visitor
//    does not create a session document in MongoDB for every chat);
//  - a daily share of the shop's chat budget per visitor address, so one abuser cannot use up the
//    whole shop limit (CHAT_DAILY_LIMIT_PER_IP, default 100, 0 = no per-visitor limit).
// Both live in this process's memory: a restart empties them.
const crypto = require('crypto');

const COOKIE = 'tl_chat';
const TTL_MS = 30 * 60 * 1000;
const MAX_CONVERSATIONS = 5000;
const MAX_ADDRESSES = 20000;
const ID_PATTERN = /^[a-f0-9]{32}$/;

const conversations = new Map();   // id -> { turns, at }
const perAddress = { day: '', counts: new Map() };

function readCookie(header, name) {
  const part = String(header || '').split(';').map((p) => p.trim()).find((p) => p.startsWith(name + '='));
  return part ? part.slice(name.length + 1) : '';
}

// The visitor's conversation id: the cookie when it is valid, else a new one (set on the response).
function clientId(req, res, env = process.env) {
  const existing = readCookie(req.headers && req.headers.cookie, COOKIE);
  if (ID_PATTERN.test(existing)) return existing;
  const id = crypto.randomBytes(16).toString('hex');
  if (res && typeof res.cookie === 'function') {
    // The same rule as the session cookie in server.js.
    const secureEnv = String(env.COOKIE_SECURE || '').trim().toLowerCase();
    const secure = secureEnv === 'true' ? true : secureEnv === 'false' ? false : env.NODE_ENV === 'production';
    res.cookie(COOKIE, id, { httpOnly: true, sameSite: 'lax', secure, maxAge: TTL_MS, path: '/api/chat' });
  }
  return id;
}

function sweep(now) {
  for (const [id, c] of conversations) if (now - c.at > TTL_MS) conversations.delete(id);
  if (conversations.size >= MAX_CONVERSATIONS) conversations.clear();
}

function getTurns(id, now = Date.now()) {
  const c = conversations.get(id);
  if (!c || now - c.at > TTL_MS) { conversations.delete(id); return []; }
  return c.turns.slice(-10);
}

function saveTurns(id, turns, now = Date.now()) {
  if (conversations.size >= MAX_CONVERSATIONS) sweep(now);
  conversations.set(id, { turns: turns.slice(-10), at: now });
}

function perAddressLimit(env = process.env) {
  const n = parseInt(env.CHAT_DAILY_LIMIT_PER_IP, 10);
  return Number.isFinite(n) ? Math.max(0, n) : 100;
}

function rollDay(now) {
  const day = now.toISOString().slice(0, 10);
  if (perAddress.day !== day) { perAddress.day = day; perAddress.counts = new Map(); }
}

function takeAddressBudget(address, now = new Date(), env = process.env) {
  const max = perAddressLimit(env);
  if (max === 0) return true;
  rollDay(now);
  const key = String(address || 'unknown');
  const used = perAddress.counts.get(key) || 0;
  if (used >= max) return false;
  if (!perAddress.counts.has(key) && perAddress.counts.size >= MAX_ADDRESSES) return true;   // table full: do not block strangers
  perAddress.counts.set(key, used + 1);
  return true;
}

function refundAddressBudget(address) {
  const key = String(address || 'unknown');
  const used = perAddress.counts.get(key) || 0;
  if (used > 0) perAddress.counts.set(key, used - 1);
}

function reset() { conversations.clear(); perAddress.day = ''; perAddress.counts = new Map(); }

module.exports = { clientId, getTurns, saveTurns, takeAddressBudget, refundAddressBudget, perAddressLimit, reset, COOKIE };
