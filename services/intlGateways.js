'use strict';

// Extra international payment gateways: PayPal, Flutterwave and Mollie.

const crypto = require('crypto');
const { toMinor, minorUnit } = require('./money');
const { paypalConfigured, flutterwaveConfigured, mollieConfigured, cardCurrency, cardRate, cardRateProblem, currencyExponent, paypalExponent } = require('./paymentConfig');

const INTL_GATEWAYS = ['paypal', 'flutterwave', 'mollie'];
const MIN_INTL_MINOR = 50;            // the smallest charge (in minor units) these gateways accept
const REQUEST_TIMEOUT_MS = 15000;

function isIntlGateway(name) {
  return INTL_GATEWAYS.includes(name);
}

function isConfigured(gateway, env = process.env) {
  if (gateway === 'paypal') return paypalConfigured(env);
  if (gateway === 'flutterwave') return flutterwaveConfigured(env);
  if (gateway === 'mollie') return mollieConfigured(env);
  return false;
}

const GATEWAY_NAMES = { paypal: 'PayPal', flutterwave: 'Flutterwave', mollie: 'Mollie' };

// The number of decimals a gateway counts in.
function exponentFor(gateway, currency) {
  return gateway === 'paypal' ? paypalExponent(currency) : currencyExponent(currency);
}

// Order total to whole minor units of the card currency (same rule for Stripe, PayPal, Flutterwave
// and Mollie).
const RATE_DIGITS = 12;
function rateScaled(rate) {
  const fixed = Number(rate).toFixed(RATE_DIGITS);   // a plain decimal string, e.g. "0.009100000000"
  return BigInt(fixed.replace('.', ''));
}
function divideHalfUp(numerator, denominator) {
  return (numerator * 2n + denominator) / (denominator * 2n);   // numerator >= 0
}
function toMinorUnits(total, env = process.env, gateway) {
  const shopMinor = toMinor(total, env);                         // minor units of the shop currency, exact
  if (shopMinor <= 0) return 0;
  const scaled = BigInt(shopMinor) * rateScaled(cardRate(env));  // shop minor units * rate * 10^12
  const unit = 10n ** BigInt(RATE_DIGITS);
  const wholeShop = BigInt(minorUnit(env));                      // shop minor units in one whole unit (100, 1 or 1000)
  const exp = exponentFor(gateway, cardCurrency(env));
  // Currencies with 3 decimals are charged in a multiple of 10 (hundredths, times 10).
  const digits = BigInt(exp === 3 ? 2 : exp);
  const result = Number(divideHalfUp(scaled * 10n ** digits, unit * wholeShop));
  return exp === 3 ? result * 10 : result;
}

// The smallest charge, in the minor units the gateway counts in. For Stripe the amounts come from
// stripeMinCharge.json: the minimums Stripe documents, in whole currency units. Stripe applies the
// minimum of the account's settlement currency; this uses the card currency, which is the same when
// the Stripe account settles in the currency it charges in. PayPal, Flutterwave and Mollie, and any
// currency that is not in the table, use MIN_INTL_MINOR (times 10 for currencies with 3 decimals);
// those gateways still apply their own limits and refuse a payment that is too small.
const STRIPE_MIN_CHARGE = require('./stripeMinCharge.json').minimums;
function minChargeMinor(currency, gateway) {
  const code = String(currency || '').toUpperCase();
  const exp = exponentFor(gateway, code);
  const isStripe = gateway === undefined || gateway === 'stripe';
  if (isStripe && Object.prototype.hasOwnProperty.call(STRIPE_MIN_CHARGE, code)) return Math.round(STRIPE_MIN_CHARGE[code] * 10 ** exp);
  return exp === 3 ? MIN_INTL_MINOR * 10 : MIN_INTL_MINOR;
}

// 1234 gives "12.34" (2 decimals); 1000 gives "1000" for JPY; 1234 gives "1.234" for KWD
function minorToDecimal(minor, currency, gateway) {
  const exp = exponentFor(gateway, currency);
  const m = Math.round(Number(minor));
  if (exp === 0) return String(m);
  return (m / Math.pow(10, exp)).toFixed(exp);
}

// "12.34" or 12.34 to 1234 (NaN when it is not a number); the number of decimals follows the
// currency
function decimalToMinor(value, currency, gateway) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * Math.pow(10, exponentFor(gateway, currency))) : NaN;
}

// One request with a timeout. Resolves to { ok, status, data } and never throws
// for an HTTP error status; network errors and timeouts do throw.
async function http(url, { method = 'GET', headers = {}, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await globalThis.fetch(url, { method, headers, body, signal: controller.signal });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    return { ok: !!res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

const jsonHeaders = (extra) => ({ 'Content-Type': 'application/json', Accept: 'application/json', ...extra });
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

function paypalBase(env = process.env) {
  const live = String(env.PAYPAL_IS_LIVE || '').trim().toLowerCase() === 'true';
  return live ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

async function paypalToken(env = process.env) {
  const basic = Buffer.from(`${String(env.PAYPAL_CLIENT_ID).trim()}:${String(env.PAYPAL_CLIENT_SECRET).trim()}`).toString('base64');
  const res = await http(`${paypalBase(env)}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok || !res.data || !res.data.access_token) {
    throw new Error(`PayPal sign-in failed (HTTP ${res.status}). Check PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_IS_LIVE.`);
  }
  return res.data.access_token;
}

// Creates a PayPal order and resolves to { url, ref }: the page the customer
// approves the payment on, and the PayPal order id (kept on our order).
async function paypalCreate(p, env = process.env) {
  const token = await paypalToken(env);
  const res = await http(`${paypalBase(env)}/v2/checkout/orders`, {
    method: 'POST',
    headers: jsonHeaders({ ...bearer(token), 'PayPal-Request-Id': p.transactionId }),
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        custom_id: p.transactionId,
        invoice_id: p.transactionId,
        description: String(p.description || '').slice(0, 127),
        amount: { currency_code: p.currency, value: minorToDecimal(p.amountMinor, p.currency, 'paypal') }
      }],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: String(p.brandName || 'Store').slice(0, 127),
            shipping_preference: 'NO_SHIPPING',
            user_action: 'PAY_NOW',
            return_url: p.returnUrl,
            cancel_url: p.cancelUrl
          }
        }
      }
    })
  });
  const link = res.data && Array.isArray(res.data.links)
    ? res.data.links.find((l) => l && (l.rel === 'payer-action' || l.rel === 'approve'))
    : null;
  if (!res.ok || !res.data || !res.data.id || !link || !link.href) {
    throw new Error(`PayPal did not create the order (HTTP ${res.status}).`);
  }
  return { url: link.href, ref: String(res.data.id) };
}

// Reads a PayPal order object into { paid, amountMinor, currency, ref, customId }.
function readPaypalOrder(data) {
  const unit = data && Array.isArray(data.purchase_units) ? data.purchase_units[0] : null;
  const capture = unit && unit.payments && Array.isArray(unit.payments.captures) ? unit.payments.captures[0] : null;
  if (!data || data.status !== 'COMPLETED' || !capture || capture.status !== 'COMPLETED' || !capture.amount) {
    return { paid: false };
  }
  return {
    paid: true,
    amountMinor: decimalToMinor(capture.amount.value, capture.amount.currency_code, 'paypal'),
    currency: String(capture.amount.currency_code || '').toUpperCase(),
    ref: String(capture.id || data.id || ''),
    customId: capture.custom_id || (unit && unit.custom_id) || null
  };
}

// Takes the money for an order the customer approved. Safe to call twice: when
// PayPal says the order was already captured, the order is read instead.
async function paypalCapture(orderRef, env = process.env) {
  if (!/^[A-Za-z0-9_-]{5,64}$/.test(String(orderRef))) return { paid: false };
  const token = await paypalToken(env);
  const base = `${paypalBase(env)}/v2/checkout/orders/${encodeURIComponent(orderRef)}`;
  const res = await http(`${base}/capture`, {
    method: 'POST',
    headers: jsonHeaders({ ...bearer(token), 'PayPal-Request-Id': `capture-${orderRef}` }),
    body: '{}'
  });
  if (res.ok) return readPaypalOrder(res.data);

  const issue = res.data && Array.isArray(res.data.details) && res.data.details[0] ? res.data.details[0].issue : '';
  if (issue === 'ORDER_ALREADY_CAPTURED') {
    const again = await http(base, { headers: jsonHeaders(bearer(token)) });
    return again.ok ? readPaypalOrder(again.data) : { paid: false };
  }
  return { paid: false, status: res.status };
}

// Reads a PayPal order WITHOUT capturing it: { paid: true, ... } only when it was already captured.
async function paypalStatus(orderRef, env = process.env) {
  if (!/^[A-Za-z0-9_-]{5,64}$/.test(String(orderRef))) return { paid: false };
  const token = await paypalToken(env);
  const res = await http(`${paypalBase(env)}/v2/checkout/orders/${encodeURIComponent(orderRef)}`, { headers: jsonHeaders(bearer(token)) });
  return res.ok ? readPaypalOrder(res.data) : { paid: false, unknown: true };
}

// Asks PayPal whether a webhook call is genuine. `headers` is a function that reads a request header.
async function paypalVerifyWebhook(headers, event, env = process.env) {
  const webhookId = String(env.PAYPAL_WEBHOOK_ID || '').trim();
  if (!webhookId || !event || typeof event !== 'object') return false;
  const token = await paypalToken(env);
  const res = await http(`${paypalBase(env)}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: jsonHeaders(bearer(token)),
    body: JSON.stringify({
      auth_algo: headers('paypal-auth-algo'),
      cert_url: headers('paypal-cert-url'),
      transmission_id: headers('paypal-transmission-id'),
      transmission_sig: headers('paypal-transmission-sig'),
      transmission_time: headers('paypal-transmission-time'),
      webhook_id: webhookId,
      webhook_event: event
    })
  });
  return res.ok && !!res.data && res.data.verification_status === 'SUCCESS';
}

const FLUTTERWAVE_BASE = 'https://api.flutterwave.com/v3';

async function flutterwaveCreate(p, env = process.env) {
  const res = await http(`${FLUTTERWAVE_BASE}/payments`, {
    method: 'POST',
    headers: jsonHeaders(bearer(String(env.FLUTTERWAVE_SECRET_KEY).trim())),
    body: JSON.stringify({
      tx_ref: p.transactionId,
      amount: Number(minorToDecimal(p.amountMinor, p.currency)),
      currency: p.currency,
      redirect_url: p.returnUrl,
      customer: { email: p.customerEmail, name: p.customerName, phonenumber: p.customerPhone || undefined },
      customizations: {
        title: String(p.brandName || 'Store').slice(0, 60),
        description: String(p.description || '').slice(0, 200)
      }
    })
  });
  const link = res.data && res.data.data && res.data.data.link;
  if (!res.ok || !res.data || res.data.status !== 'success' || !link) {
    throw new Error(`Flutterwave did not create the payment (HTTP ${res.status}).`);
  }
  // Flutterwave identifies the payment by the tx_ref we sent.
  return { url: link, ref: p.transactionId };
}

// Asks Flutterwave about a transaction. Resolves to { paid, amountMinor, currency, ref, txRef }.
async function flutterwaveVerify(transactionId, env = process.env) {
  if (!/^[0-9]{1,20}$/.test(String(transactionId))) return { paid: false };
  const res = await http(`${FLUTTERWAVE_BASE}/transactions/${transactionId}/verify`, {
    headers: jsonHeaders(bearer(String(env.FLUTTERWAVE_SECRET_KEY).trim()))
  });
  const d = res.data && res.data.data;
  if (!res.ok || !res.data || res.data.status !== 'success' || !d || d.status !== 'successful') return { paid: false };
  return {
    paid: true,
    amountMinor: decimalToMinor(d.amount, d.currency),
    currency: String(d.currency || '').toUpperCase(),
    ref: String(d.id || transactionId),
    txRef: typeof d.tx_ref === 'string' ? d.tx_ref : null
  };
}

// The webhook secret is checked in constant time.
function flutterwaveWebhookAllowed(headerValue, env = process.env) {
  const secret = String(env.FLUTTERWAVE_WEBHOOK_HASH || '').trim();
  if (!secret || typeof headerValue !== 'string') return false;
  const a = Buffer.from(headerValue);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const MOLLIE_BASE = 'https://api.mollie.com/v2';

// Mollie must be able to reach the webhook, so it is only sent for a public
// https address (not for localhost during development).
function isPublicHttps(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(u.hostname);
  } catch (e) {
    return false;
  }
}

async function mollieCreate(p, env = process.env) {
  const body = {
    amount: { currency: p.currency, value: minorToDecimal(p.amountMinor, p.currency) },
    description: String(p.description || `Order ${p.transactionId}`).slice(0, 255),
    redirectUrl: p.returnUrl,
    cancelUrl: p.cancelUrl,
    metadata: { transactionId: p.transactionId }
  };
  if (p.webhookUrl && isPublicHttps(p.webhookUrl)) body.webhookUrl = p.webhookUrl;

  const res = await http(`${MOLLIE_BASE}/payments`, {
    method: 'POST',
    headers: jsonHeaders(bearer(String(env.MOLLIE_API_KEY).trim())),
    body: JSON.stringify(body)
  });
  const url = res.data && res.data._links && res.data._links.checkout && res.data._links.checkout.href;
  if (!res.ok || !res.data || !res.data.id || !url) {
    throw new Error(`Mollie did not create the payment (HTTP ${res.status}).`);
  }
  return { url, ref: String(res.data.id) };
}

// Resolves to { status, paid, amountMinor, currency, ref } ("status" is Mollie's own word:
// open, paid, canceled, expired, failed, pending, authorized).
async function mollieGet(paymentId, env = process.env) {
  if (!/^tr_[A-Za-z0-9]{1,64}$/.test(String(paymentId))) return { status: 'unknown', paid: false };
  const res = await http(`${MOLLIE_BASE}/payments/${paymentId}`, {
    headers: jsonHeaders(bearer(String(env.MOLLIE_API_KEY).trim()))
  });
  const d = res.data;
  if (!res.ok || !d) return { status: 'unknown', paid: false };
  const paid = d.status === 'paid' && !!d.amount;
  return {
    status: String(d.status || 'unknown'),
    paid,
    amountMinor: paid ? decimalToMinor(d.amount.value, d.amount.currency) : undefined,
    currency: paid ? String(d.amount.currency || '').toUpperCase() : undefined,
    ref: String(d.id || paymentId)
  };
}

// Starts a payment with the chosen gateway.
async function createPayment(gateway, p, env = process.env) {
  if (gateway === 'paypal') return paypalCreate(p, env);
  if (gateway === 'flutterwave') return flutterwaveCreate(p, env);
  if (gateway === 'mollie') return mollieCreate(p, env);
  throw new Error(`Unknown gateway: ${gateway}`);
}

module.exports = {
  INTL_GATEWAYS, MIN_INTL_MINOR, GATEWAY_NAMES,
  isIntlGateway, isConfigured,
  cardCurrency, cardRate, cardRateProblem,
  toMinorUnits, minorToDecimal, decimalToMinor, minChargeMinor,
  createPayment,
  paypalCapture, paypalStatus, paypalVerifyWebhook, readPaypalOrder,
  flutterwaveVerify, flutterwaveWebhookAllowed,
  mollieGet, isPublicHttps
};
