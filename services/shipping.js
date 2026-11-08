'use strict';

// Shipping rates (optional, off by default).

const { toMinor, isPlainAmount } = require('./money');

const MAX_RATE = 100000;

// "60", "60.5" or "60.50" give a number (as many decimals as the shop currency has). Anything else
// (negative, text, too many decimals, absurdly large) gives null, so a typo does not turn into a
// surprise fee.
function parseRate(value) {
  const v = String(value === undefined || value === null ? '' : value).trim();
  if (!isPlainAmount(v)) return null;
  const n = Number(v);
  return n <= MAX_RATE ? n : null;
}

function shippingSettings(env = process.env) {
  const enabled = String(env.SHIPPING_ENABLED || '').trim().toLowerCase() === 'true';
  const flatRate = parseRate(env.SHIPPING_FLAT_RATE);
  const freeOver = parseRate(env.SHIPPING_FREE_OVER);
  const homeCity = String(env.SHIPPING_HOME_CITY || '').trim().slice(0, 100);
  const homeRate = parseRate(env.SHIPPING_HOME_RATE);
  return {
    enabled,
    flatRate: flatRate === null ? 0 : flatRate,
    freeOver: freeOver === null ? 0 : freeOver,
    homeCity,
    // The home rate only exists when a home city is named too.
    homeRate: homeCity && homeRate !== null ? homeRate : null
  };
}

// "  DHAKA " and "Dhaka" are the same city; accents are ignored.
function normalizeCity(city) {
  return String(city || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// The shipping fee for an order. goodsTotal is the goods cost after any coupon discount, city is the
// delivery city typed by the customer. Returns { fee, free, zone }.
function quoteShipping(goodsTotal, city, settings = shippingSettings()) {
  if (!settings.enabled) return { fee: 0, free: false, zone: null };

  if (settings.freeOver > 0 && toMinor(goodsTotal) >= toMinor(settings.freeOver)) {
    return { fee: 0, free: true, zone: 'free' };
  }
  const wanted = normalizeCity(city);
  const isHome = settings.homeRate !== null && wanted !== '' && wanted === normalizeCity(settings.homeCity);
  const fee = isHome ? settings.homeRate : settings.flatRate;
  return { fee, free: fee === 0, zone: isHome ? 'home' : 'standard' };
}

// What the storefront needs to repeat the same rules.
function publicShippingOptions(settings = shippingSettings()) {
  if (!settings.enabled) return { enabled: false };
  return {
    enabled: true,
    flatRate: settings.flatRate,
    freeOver: settings.freeOver,
    homeCity: settings.homeRate !== null ? settings.homeCity : '',
    homeRate: settings.homeRate
  };
}

module.exports = { shippingSettings, quoteShipping, publicShippingOptions, normalizeCity, parseRate };
