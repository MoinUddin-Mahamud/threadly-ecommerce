'use strict';

// Money math in integer minor units, to avoid floating-point errors.
//
// The minor unit is the smallest unit of the shop's own currency (CURRENCY_CODE): a hundredth for
// most currencies, 1 for currencies without decimals (JPY, KRW ...), a thousandth for KWD, BHD, JOD,
// OMR and TND (see paymentConfig.currencyExponent). With no CURRENCY_CODE it is a hundredth.

// Decimals of the shop currency and the number of minor units in one whole unit (100, 1 or 1000).
function decimalsOf(env = process.env) {
  return require('./paymentConfig').displayDecimals(env);
}
function minorUnit(env = process.env) {
  return 10 ** decimalsOf(env);
}

// The smallest order total the shop owner wants to accept (MIN_ORDER_TOTAL, a plain number in the
// shop's own currency). Unset or invalid means no minimum (0).
function minPayableMinor(env = process.env) {
  const n = Number(String(env.MIN_ORDER_TOTAL === undefined || env.MIN_ORDER_TOTAL === '' ? '0' : env.MIN_ORDER_TOTAL).trim());
  return Number.isFinite(n) && n >= 0 && n <= 1000000 ? Math.round(n * minorUnit(env)) : 0;
}

// True when text is a plain non-negative amount with no more decimals than the shop currency has
// ("12", "12.5", "12.50"; for a currency without decimals only "12" or "12.00").
function isPlainAmount(text, env = process.env) {
  const decimals = decimalsOf(env);
  const pattern = decimals === 0 ? /^\d+(\.0+)?$/ : new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`);
  return pattern.test(String(text).trim());
}

// The same rule in words, for error messages ("a whole number", "at most 2 decimals").
function decimalsRule(env = process.env) {
  const decimals = decimalsOf(env);
  return decimals === 0 ? 'a whole number' : `at most ${decimals} decimals`;
}

// What an order total must reach: the owner's minimum, but never less than one minor unit. A total of
// 0 is refused for every payment method (a payment gateway cannot charge 0, and a free order would
// still be shipped and, in the marketplace, pay the sellers).
function minOrderMinor(env = process.env) {
  return Math.max(1, minPayableMinor(env));
}

// A price as text with the number of decimals of the shop's currency (see paymentConfig.displayDecimals).
function fixedAmount(amount, env = process.env) {
  const n = Number(amount);
  return (Number.isFinite(n) ? n : 0).toFixed(require('./paymentConfig').displayDecimals(env));
}

function toMinor(amount, env = process.env) {
  // parseFloat would read "12abc" or "1e3" as a number, so text must be a plain decimal.
  if (typeof amount === 'string' && !/^-?\d+(\.\d+)?$/.test(amount.trim())) {
    throw new TypeError(`Invalid money amount: ${amount}`);
  }
  const num = typeof amount === 'number' ? amount : parseFloat(amount);
  if (isNaN(num) || !isFinite(num)) {
    throw new TypeError(`Invalid money amount: ${amount}`);
  }
  const decimals = decimalsOf(env);
  const unit = 10 ** decimals;
  // Round the decimal digits (half up), not the binary value: 1.005 * 100 is 100.49999999999999 in
  // floating point, but the amount is meant as 1.005, which rounds to 1.01.
  if (Math.abs(num) >= 1e12) return Math.round(num * unit);
  const [whole, fraction] = Math.abs(num).toFixed(10).split('.');
  let minor = Number(whole) * unit + Number(fraction.slice(0, decimals) || 0);
  if (fraction.charCodeAt(decimals) >= 53) minor += 1;   // the next decimal digit is 5 or more
  return num < 0 && minor !== 0 ? -minor : minor;
}

function fromMinor(minor, env = process.env) {
  return Math.round(minor) / minorUnit(env);
}

function addAmounts(...amounts) {
  const totalMinor = amounts.reduce((sum, amt) => sum + toMinor(amt), 0);
  return fromMinor(totalMinor);
}

function multiplyAmount(amount, qty) {
  const minor = toMinor(amount);
  const qtyNum = typeof qty === 'number' ? qty : parseInt(qty, 10);
  if (isNaN(qtyNum)) {
    throw new TypeError(`Invalid quantity: ${qty}`);
  }
  return fromMinor(Math.round(minor * qtyNum));
}

function percentOf(amount, percent) {
  const minor = toMinor(amount);
  const pct = typeof percent === 'number' ? percent : parseFloat(percent);
  if (isNaN(pct) || pct < 0) return 0;
  const discountMinor = Math.round((minor * pct) / 100);
  return fromMinor(Math.min(minor, discountMinor));
}

// Compares two money amounts with integer precision. Returns -1 if a < b, 0 if a == b, 1 if a > b.
function compareMoney(a, b) {
  const minorA = toMinor(a);
  const minorB = toMinor(b);
  if (minorA < minorB) return -1;
  if (minorA > minorB) return 1;
  return 0;
}

module.exports = {
  decimalsOf,
  minorUnit,
  isPlainAmount,
  decimalsRule,
  minPayableMinor,
  minOrderMinor,
  fixedAmount,
  toMinor,
  fromMinor,
  addAmounts,
  multiplyAmount,
  percentOf,
  compareMoney
};
