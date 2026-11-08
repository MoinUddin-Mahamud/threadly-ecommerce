// Caps how many shop emails one address can receive per hour. Anyone can type someone else's
// address at checkout or on the "forgot password" form; without a cap the shop would mail that
// person as often as the sender likes. Counted in this process's memory (a restart starts fresh).
const WINDOW_MS = 60 * 60 * 1000;
const LIMITS = { order: 5, link: 3 };   // order emails, and verification / reset links
const MAX_ADDRESSES = 20000;

const sent = new Map();   // "kind:address" -> [timestamps]

function allow(kind, address, now = Date.now()) {
  const max = LIMITS[kind];
  const key = `${kind}:${String(address || '').trim().toLowerCase()}`;
  if (!max || key.endsWith(':')) return true;
  if (sent.size >= MAX_ADDRESSES && !sent.has(key)) {
    for (const [k, list] of sent) if (!list.length || now - list[list.length - 1] > WINDOW_MS) sent.delete(k);
    if (sent.size >= MAX_ADDRESSES) sent.clear();
  }
  const recent = (sent.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= max) { sent.set(key, recent); return false; }
  recent.push(now);
  sent.set(key, recent);
  return true;
}

// Like allow(), but only looks: nothing is counted. A route uses it before it issues a new link, so
// a suppressed email never replaces a link that is already in the person's inbox.
function wouldAllow(kind, address, now = Date.now()) {
  const max = LIMITS[kind];
  const key = `${kind}:${String(address || '').trim().toLowerCase()}`;
  if (!max || key.endsWith(':')) return true;
  const recent = (sent.get(key) || []).filter((t) => now - t < WINDOW_MS);
  return recent.length < max;
}

function reset() { sent.clear(); }

module.exports = { allow, wouldAllow, reset, LIMITS, WINDOW_MS };
