// Per-account brake on password guessing. The per-IP limiter stops one machine; this stops many
// machines aimed at one account. After MAX_FAILURES wrong passwords within WINDOW_MS the account
// refuses further attempts for LOCK_MS (a correct password does not get through during the lock).
// State is kept in this process's memory (a restart or a second server instance starts fresh), and
// the account key is hashed so no email or username sits in memory longer than needed.
const crypto = require('crypto');

const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_TRACKED = 10000;

const entries = new Map();   // key -> { count, first, lockedUntil }

function keyOf(scope, account) {
  return crypto.createHash('sha256').update(`${scope}:${String(account || '').trim().toLowerCase()}`).digest('hex');
}

function prune(now) {
  if (entries.size < MAX_TRACKED) return;
  for (const [k, v] of entries) {
    if (v.lockedUntil <= now && now - v.first > WINDOW_MS) entries.delete(k);
  }
  if (entries.size >= MAX_TRACKED) entries.clear();   // under attack: forget rather than grow
}

// Seconds the account is locked for, or 0 when attempts are allowed.
function lockedFor(scope, account, now = Date.now()) {
  const e = entries.get(keyOf(scope, account));
  if (!e || e.lockedUntil <= now) return 0;
  return Math.ceil((e.lockedUntil - now) / 1000);
}

function recordFailure(scope, account, now = Date.now()) {
  prune(now);
  const key = keyOf(scope, account);
  let e = entries.get(key);
  if (!e || now - e.first > WINDOW_MS) e = { count: 0, first: now, lockedUntil: 0 };
  e.count += 1;
  if (e.count >= MAX_FAILURES) { e.lockedUntil = now + LOCK_MS; e.count = 0; e.first = now; }
  entries.set(key, e);
}

function recordSuccess(scope, account) {
  entries.delete(keyOf(scope, account));
}

function reset() { entries.clear(); }

module.exports = { lockedFor, recordFailure, recordSuccess, reset, MAX_FAILURES, WINDOW_MS, LOCK_MS };
