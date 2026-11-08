'use strict';

// One set of rules for product prices, used everywhere a product can be entered: the admin panel,
// CSV import and the seller dashboard (and the Product model as a last safety net).

const { decimalsOf, isPlainAmount, decimalsRule } = require('./money');

const MAX_PRICE = 10_000_000;

// Returns { ok: true, value: 799.5 } or { ok: false, message }
function parsePrice(value, env = process.env) {
  const rule = `Price must be a valid number with ${decimalsRule(env) === 'a whole number' ? 'no decimals (a whole number)' : decimalsRule(env)}.`;
  const factor = 10 ** decimalsOf(env);
  let text;
  if (typeof value === 'number') {
    // 1799.99 arrives as a number from JSON; tidy float noise (0.1 + 0.2) before checking.
    if (!Number.isFinite(value)) return { ok: false, message: rule };
    const minor = Math.round(value * factor);
    text = Math.abs(value * factor - minor) < 1e-6 ? String(minor / factor) : String(value);
  } else {
    text = String(value === undefined || value === null ? '' : value).trim();
  }
  if (!isPlainAmount(text, env)) return { ok: false, message: rule };
  const n = Number(text);
  if (n <= 0 || n > MAX_PRICE) return { ok: false, message: 'Price must be above 0 and at most 10,000,000.' };
  return { ok: true, value: n };
}

// A stock figure: a whole number, or text that is only digits ("12"). "12abc", "1.5", true and
// negative numbers are refused (the seller routes and the CSV import use the same rule).
// Returns the number, or null.
function parseWholeStock(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && /^\d{1,9}$/.test(value.trim())) return Number(value.trim());
  return null;
}

module.exports = { MAX_PRICE, parsePrice, parseWholeStock };
