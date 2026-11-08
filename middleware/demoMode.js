'use strict';

// DEMO_MODE=true: deletes are refused, and so are changes to staff, roles, passwords, 2FA, vendors,
// payouts and refund marks. Products, coupons, reviews and order status stay editable.
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const BLOCKED = /\/(staff|roles?|2fa|totp|password|account)(\/|$)/i;
const MONEY_BLOCKED = /^\/admin\/(vendors\/[^/]+(\/payouts)?|orders\/[^/]+\/mark-refunded)\/?$/i;

function demoMode(req, res, next) {
  if (process.env.DEMO_MODE !== 'true' || SAFE.has(req.method)) return next();
  if (req.method === 'DELETE' || BLOCKED.test(req.path) || MONEY_BLOCKED.test(req.baseUrl + req.path)) {
    return res.status(403).json({ success: false, message: 'Disabled in demo mode.' });
  }
  return next();
}

module.exports = demoMode;
module.exports.BLOCKED = BLOCKED;
module.exports.MONEY_BLOCKED = MONEY_BLOCKED;
