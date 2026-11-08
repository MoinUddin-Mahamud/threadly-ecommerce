'use strict';

// Cross-site write protection for cookie-authenticated routes (/api/users and /api/vendor).

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

const hostOf = (value) => {
  try { return new URL(String(value).trim()).host.toLowerCase(); } catch (err) { return ''; }
};

function allowedHosts(req, env = process.env) {
  const list = [req.headers.host];
  // A forwarded host is believed only when the app was told to trust its proxy: otherwise any
  // client could write it.
  if (req.app && typeof req.app.get === 'function' && req.app.get('trust proxy')) {
    list.push(String(req.headers['x-forwarded-host'] || '').split(',')[0]);
  }
  for (const v of [env.BASE_URL, ...String(env.ALLOWED_ORIGIN || '').split(',')]) {
    if (v && String(v).trim()) list.push(hostOf(v));
  }
  return list.map((h) => String(h || '').trim().toLowerCase()).filter(Boolean);
}

function sameOrigin(req, res, next) {
  if (SAFE.has(req.method)) return next();
  const refuse = () => res.status(403).json({ message: 'Cross-site request refused.' });

  const origin = req.headers.origin;
  if (origin === undefined) {
    // No Origin: allowed, except when the browser reports a cross-site request anyway.
    return String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site' ? refuse() : next();
  }
  const host = origin === 'null' ? '' : hostOf(origin);
  if (!host || !allowedHosts(req).includes(host)) return refuse();
  next();
}

module.exports = sameOrigin;
module.exports.allowedHosts = allowedHosts;
