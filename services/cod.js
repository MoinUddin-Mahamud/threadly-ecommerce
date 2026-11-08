const COD_GATEWAY = 'cod';
const CODE_PREFIX = 'COD-';

const { isPlainAmount } = require('./money');

// Same ceiling as a product price; anything bigger is a typo in .env.
const MAX_AMOUNT_CEILING = 100_000_000;

function codSettings(env = process.env) {
  const enabled = String(env.COD_ENABLED || '').trim().toLowerCase() === 'true';
  const raw = String(env.COD_MAX_AMOUNT || '').trim();
  let maxAmount = null;
  if (isPlainAmount(raw, env)) {
    const n = parseFloat(raw);
    if (n > 0 && n <= MAX_AMOUNT_CEILING) maxAmount = n;
  }
  // Out-of-range or non-numeric values fall back to the default. A negative COD_CONFIRM_HOURS
  // would otherwise put the cutoff in the future and cancel every open COD order at once.
  const inRange = (value, min, max, fallback) => {
    const n = parseInt(value, 10);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
  };
  const confirmHours = inRange(env.COD_CONFIRM_HOURS, 1, 720, 24);
  const maxOpenOrders = inRange(env.COD_MAX_OPEN_ORDERS, 1, 50, 2);
  const maxQtyPerLine = inRange(env.COD_MAX_QUANTITY_PER_LINE, 1, 99, 3);

  return { enabled, maxAmount, confirmHours, maxOpenOrders, maxQtyPerLine };
}

// Phone: digits with optional + ( ) - . and spaces, at least 6 digits.
function isUsablePhone(phone) {
  if (typeof phone !== 'string') return false;
  const value = phone.trim();
  if (value.length === 0 || value.length > 30) return false;
  if (!/^[0-9+()\-. ]+$/.test(value)) return false;
  return value.replace(/\D/g, '').length >= 6;
}

// Checks one cash-on-delivery order before anything is reserved.
// `phone` is the already trimmed phone, `address` the cleaned address object.
// Resolves to { ok: true } or { ok: false, message }.
function checkCodOrder({ phone, address, totalAmount, items }, settings = codSettings()) {
  if (!settings.enabled) {
    return { ok: false, message: 'Cash on Delivery is not available. Please choose another payment method.' };
  }
  if (!isUsablePhone(phone)) {
    return { ok: false, message: 'Cash on Delivery needs a valid phone number so the courier can reach you.' };
  }
  const a = address || {};
  if (!a.address || !a.city) {
    return { ok: false, message: 'Cash on Delivery needs a delivery address (street address and city).' };
  }
  if (settings.maxAmount != null && Number(totalAmount) > settings.maxAmount) {
    return {
      ok: false,
      message: `Cash on Delivery is only available for orders up to ${settings.maxAmount}. Please choose another payment method.`
    };
  }
  if (Array.isArray(items)) {
    for (const item of items) {
      if (item.quantity > settings.maxQtyPerLine) {
        return {
          ok: false,
          message: `Cash on Delivery orders are limited to ${settings.maxQtyPerLine} items per product line.`
        };
      }
    }
  }
  return { ok: true };
}

module.exports = { COD_GATEWAY, CODE_PREFIX, codSettings, isUsablePhone, checkCodOrder };

