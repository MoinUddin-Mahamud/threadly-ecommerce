'use strict';

// Which payment methods this store can really offer right now.

// .env.example ships placeholder values ("your-sslcommerz-store-id"). They look
// like settings but are not, so they count as "not configured".
function isRealValue(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  return !/^(your[-_ ]|replace[-_ ]|changeme|xxx)/i.test(v);
}

// The shop shows plain numbers and never a currency.
function currencyCode(env = process.env) {
  const v = String(env.CURRENCY_CODE || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(v) ? v : '';
}

// Card gateways (Stripe, PayPal, Flutterwave, Mollie) may need another currency than the one the
// prices are in.
function cardCurrency(env = process.env) {
  const v = String(env.CARD_CURRENCY || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(v) ? v : currencyCode(env);
}

function hasExplicitCardRate(env = process.env) {
  const rate = parseFloat(env.CARD_RATE);
  return Number.isFinite(rate) && rate > 0;
}

function cardRate(env = process.env) {
  return hasExplicitCardRate(env) ? parseFloat(env.CARD_RATE) : 1;
}

// A message when the card currency differs from the shop currency but no rate was given, otherwise
// null.
function cardRateProblem(env = process.env) {
  const code = currencyCode(env);
  const card = cardCurrency(env);
  if (!code || !card || card === code) return null;
  return hasExplicitCardRate(env) ? null : 'CARD_CURRENCY differs from CURRENCY_CODE but CARD_RATE is missing or invalid. Set CARD_RATE to the current rate (card currency per 1 unit of your price currency)';
}

// Decimal places per currency: gateways count the smallest unit (1000 JPY is sent as 1000, 1 KWD as
// 1000). ISK and UGX keep 2 here because Stripe still wants them in hundredths.
const ZERO_DECIMAL_CURRENCIES = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const THREE_DECIMAL_CURRENCIES = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);

function currencyExponent(code) {
  const c = String(code || '').trim().toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(c)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(c)) return 3;
  return 2;
}

// PayPal wants whole amounts (no decimals) in HUF, JPY and TWD.
const PAYPAL_WHOLE_UNIT_CURRENCIES = new Set(['HUF', 'JPY', 'TWD']);

function paypalExponent(code) {
  const c = String(code || '').trim().toUpperCase();
  return PAYPAL_WHOLE_UNIT_CURRENCIES.has(c) ? 0 : currencyExponent(c);
}

// How many decimals the shop's own prices are shown with: 0 for currencies without minor units (JPY,
// KRW, VND ...), 3 for BHD, JOD, KWD, OMR and TND, otherwise 2. Never a currency sign or name.
function displayDecimals(env = process.env) {
  const code = currencyCode(env);
  return code ? currencyExponent(code) : 2;
}

function sslcommerzConfigured(env = process.env) {
  return isRealValue(env.SSLCOMMERZ_STORE_ID) && isRealValue(env.SSLCOMMERZ_STORE_PASSWORD) && !!currencyCode(env);
}

function stripeConfigured(env = process.env) {
  return isRealValue(env.STRIPE_SECRET_KEY) && !!cardCurrency(env);
}

// The three extra international gateways. Each needs only its own keys; the
// placeholder values from .env.example count as "not configured".
function paypalConfigured(env = process.env) {
  return isRealValue(env.PAYPAL_CLIENT_ID) && isRealValue(env.PAYPAL_CLIENT_SECRET) && !!cardCurrency(env);
}

function flutterwaveConfigured(env = process.env) {
  return isRealValue(env.FLUTTERWAVE_SECRET_KEY) && !!cardCurrency(env);
}

function mollieConfigured(env = process.env) {
  return isRealValue(env.MOLLIE_API_KEY) && !!cardCurrency(env);
}

function manualSettings(env = process.env) {
  const enabled = String(env.MANUAL_PAYMENT_ENABLED || '').trim().toLowerCase() === 'true';
  const hours = Math.min(720, Math.max(1, parseInt(env.MANUAL_PAYMENT_HOURS, 10) || 24));
  const instructions = String(env.MANUAL_PAYMENT_INSTRUCTIONS || '').trim().slice(0, 1000);
  // After MANUAL_PAYMENT_HOURS an order that already has a payment reference is NOT cancelled at
  // once (the customer may really have paid).
  const parsedReview = parseInt(env.MANUAL_PAYMENT_REVIEW_HOURS, 10);
  const reviewHours = Math.min(720, Math.max(0, Number.isNaN(parsedReview) ? 72 : parsedReview));
  return { enabled, hours, reviewHours, instructions };
}

module.exports = {
  currencyCode, cardCurrency, cardRate, hasExplicitCardRate, cardRateProblem, currencyExponent, paypalExponent,
  displayDecimals, isRealValue, sslcommerzConfigured, stripeConfigured,
  paypalConfigured, flutterwaveConfigured, mollieConfigured,
  manualSettings
};
