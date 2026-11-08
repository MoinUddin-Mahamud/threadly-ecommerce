'use strict';

// Sizes and per-size stock.

const MAX_STOCK = 100000;
const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'One Size'];

const sizeKey = (size) => String(size).replace(/\s+/g, '');
const KEY_TO_SIZE = new Map(SIZES.map((s) => [sizeKey(s).toLowerCase(), s]));

// "m", "M", "one size" and "OneSize" all name a known size. Resolves to the size name, or null.
function canonicalSize(value) {
  if (typeof value !== 'string') return null;
  return KEY_TO_SIZE.get(sizeKey(value.trim()).toLowerCase()) || null;
}

// True when the product keeps stock per size.
function tracksSizes(product) {
  const s = product && product.sizeStock;
  return !!s && typeof s === 'object' && !Array.isArray(s) && Object.keys(s).length > 0;
}

function sizeStockTotal(sizeStock) {
  return Object.values(sizeStock || {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
}

// Units of one size that a tracked product has right now (0 when the size is not offered).
function unitsOf(product, size) {
  if (!tracksSizes(product)) return 0;
  return Math.max(0, Number(product.sizeStock[sizeKey(size)]) || 0);
}

// Reads the sizeStock a client sent. undefined / null to { ok: true, provided: false } (nothing
// sent: leave it as it is) {} or '' to { ok: true, provided: true, value: null }.
function cleanSizeStock(input) {
  if (input === undefined || input === null) return { ok: true, provided: false };
  if (input === '') return { ok: true, provided: true, value: null };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: 'Stock per size must be a list of sizes with a whole number each.' };
  }
  const entries = Object.entries(input);
  if (entries.length === 0) return { ok: true, provided: true, value: null };
  if (entries.length > SIZES.length) return { ok: false, message: 'Too many sizes.' };
  const value = {};
  for (const [name, raw] of entries) {
    const size = canonicalSize(name);
    if (!size) return { ok: false, message: `Unknown size "${String(name).slice(0, 20)}". Sizes: ${SIZES.join(', ')}.` };
    const text = String(raw === undefined || raw === null || raw === '' ? '0' : raw).trim();
    if (!/^\d+$/.test(text) || Number(text) > MAX_STOCK) {
      return { ok: false, message: `Stock for size ${size} must be a whole number from 0 to ${MAX_STOCK.toLocaleString('en-US')}.` };
    }
    value[sizeKey(size)] = Number(text);
  }
  return { ok: true, provided: true, value };
}

module.exports = { MAX_STOCK, SIZES, sizeKey, canonicalSize, tracksSizes, sizeStockTotal, unitsOf, cleanSizeStock };
