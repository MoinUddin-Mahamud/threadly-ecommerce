'use strict';

// ALLOWED_ORIGIN may be one origin or a comma separated list
// ("https://shop.com,https://www.shop.com").
function parseOrigins(value) {
  return String(value || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

// What to give the "cors" package / Socket.IO: '*' outside production, otherwise the configured
// origin(s) or false.
function corsOrigin(isProduction, value) {
  if (!isProduction) return '*';
  const list = parseOrigins(value);
  if (!list.length) return false;
  return list.length === 1 ? list[0] : list;
}

module.exports = { parseOrigins, corsOrigin };
