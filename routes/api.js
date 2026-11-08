const crypto = require('crypto');
const chatClients = require('../services/chatClients');
const express = require('express');
const rateLimit = require('express-rate-limit');
const SSLCommerzPayment = require('sslcommerz-lts');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Review = require('../models/Review');
const { getChatReply, chatEnabled, ChatError } = require('../services/llm');
const { itemSummary } = require('../services/plainText');
const { PENDING_ORDER_TTL_MINUTES, restockItems, reserveItems, cancelPendingOrder, cancelOrderAndRestock } = require('../services/orderService');
const { applyCoupon, previewCoupon, releaseCoupon, normalizeCustomerKey } = require('../services/couponService');
const { round2 } = require('../services/coupons');
const { refreshReferenceFlag } = require('../services/paymentReference');
const { COD_GATEWAY, CODE_PREFIX, codSettings, checkCodOrder, isUsablePhone } = require('../services/cod');
const { toMinor, fromMinor, minOrderMinor } = require('../services/money');
const { brandName } = require('../services/brand');
const { sslcommerzConfigured, stripeConfigured, manualSettings, currencyCode, cardCurrency, displayDecimals } = require('../services/paymentConfig');
const { publicProduct, parseDataUri, isLocalImagePath, listImageStage } = require('../services/images');
const intl = require('../services/intlGateways');
const { shippingSettings, quoteShipping, publicShippingOptions } = require('../services/shipping');
const marketplace = require('../services/marketplace');
const sameOrigin = require('../middleware/sameOrigin');
const { SIZES, sizeKey, tracksSizes, unitsOf } = require('../services/sizes');

const router = express.Router();

const STORE_ID       = process.env.SSLCOMMERZ_STORE_ID;
const STORE_PASSWORD = process.env.SSLCOMMERZ_STORE_PASSWORD;
const IS_LIVE        = process.env.SSLCOMMERZ_IS_LIVE === 'true';
const BASE_URL       = process.env.BASE_URL || 'http://localhost:3000';

// Stripe is an optional second gateway; it is only enabled when a secret key is set.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const stripe = stripeConfigured() ? require('stripe')(STRIPE_SECRET_KEY) : null;

// Return pages and webhooks each trigger a gateway verification call, so a flood would burn API quota.
const paymentCallbackLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many payment requests. Please wait a few minutes.' }
});
router.use('/payment', paymentCallbackLimiter);

// Daily chatbot cap for the whole shop, counted in memory (resets at midnight UTC and on restart).
const chatBudget = { day: '', count: 0 };
function takeChatBudget(now = new Date(), env = process.env) {
  const limit = parseInt(env.CHAT_DAILY_LIMIT, 10);
  const max = Number.isFinite(limit) ? Math.max(0, limit) : 2000;
  if (max === 0) return true;
  const day = now.toISOString().slice(0, 10);
  if (chatBudget.day !== day) { chatBudget.day = day; chatBudget.count = 0; }
  if (chatBudget.count >= max) return false;
  chatBudget.count += 1;
  return true;
}
// A message that never reached the AI (provider down) does not count against the daily cap.
function refundChatBudget() {
  if (chatBudget.count > 0) chatBudget.count -= 1;
}

// Each chat message costs an AI provider call, so the chat endpoint gets its own, tighter limit.
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many messages. Please wait a moment and try again.' }
});

// The order id plus transaction id are the only secret here, so limit guessing and flooding.
const paymentReferenceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts. Please wait a few minutes and try again.' }
});

// Unpaid orders hold stock, so order creation has its own limit (accepted orders only).
// ORDER_RATE_LIMIT_MAX raises it for shops whose customers share an IP address.
const orderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Math.min(500, Math.max(1, parseInt(process.env.ORDER_RATE_LIMIT_MAX, 10) || 20)),
  skipFailedRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many orders from this connection. Please try again in a few minutes.' }
});

// A Cash on Delivery order holds stock for up to COD_CONFIRM_HOURS without any payment, so a bot
// could lock up inventory with fake orders. COD checkouts get a much tighter limit than the
// general order limit (COD_ORDER_RATE_LIMIT_MAX per hour per address, default 5).
const codOrderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Math.min(100, Math.max(1, parseInt(process.env.COD_ORDER_RATE_LIMIT_MAX, 10) || 5)),
  skipFailedRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many Cash on Delivery orders from this connection. Please try again later or pay online.' }
});

// The coupon box in the cart can be used to guess codes, so it has its own limit.
const couponLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { valid: false, message: 'Too many coupon attempts. Please try again in a few minutes.' }
});

// Caps on what one order can hold.
const MAX_ORDER_LINES = 20;
const MAX_QUANTITY_PER_LINE = 10;
const ADDRESS_FIELD_LIMITS = [['address', 200], ['city', 100], ['postcode', 20], ['country', 100]];

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

function manualDetails() {
  const m = manualSettings();
  return { instructions: m.instructions, hours: m.hours };
}

// n random characters from the 32-letter alphabet 0-9 A-Z minus I, L, O, U (5 bits each).
function randomBase32(n) {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = crypto.randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[bytes[i] & 31];
  return out;
}

// Tells every open page that something changed. Never throws.
function emitEvent(req, name) {
  try {
    const io = req.app.get('io');
    if (io) io.emit(name);
  } catch (err) {
    console.error('Socket error:', err.message);
  }
}
const MAX_COUPON_INPUT_LENGTH = 64;   // longer than any coupon code; stops absurd input early

// The checks one cart line must pass, for checkout and for the coupon preview alike. `seller` is what
// marketplace.sellerOf returned; `wanted` is the quantity of this product (or size) in the whole cart.
// Resolves to null, or { status, message, unavailable? }.
function cartLineProblem(item, product, seller, wanted = item.quantity) {
  const gone = { status: 409, message: 'An item in your cart is no longer available. Please review your cart.', unavailable: [item.productId] };
  if (!product || seller === false) return gone;
  if (typeof item.size !== 'string' || !SIZES.includes(item.size)) {
    return { status: 400, message: `Please choose a size for "${product.title}".` };
  }
  if (tracksSizes(product)) {
    // Stock is kept per size: the chosen size must be offered and have enough units.
    const units = unitsOf(product, item.size);
    if (units < wanted) {
      return {
        status: 409,
        message: units <= 0
          ? `"${product.title}" is out of stock in size ${item.size}.`
          : `Not enough stock for "${product.title}" in size ${item.size}. Only ${units} left.`,
        unavailable: [item.productId]
      };
    }
  } else if (product.stock < wanted) {
    return {
      status: 409,
      message: product.stock <= 0 ? `"${product.title}" is out of stock.` : `Not enough stock for "${product.title}". Only ${product.stock} left.`,
      unavailable: [item.productId]
    };
  }
  return null;
}

// Prices a cart from the database (browser prices are ignored) under the same rules as an order,
// so a coupon preview matches checkout.
async function priceCartItems(items) {
  if (!Array.isArray(items) || items.length === 0) return { ok: false, message: 'Your cart is empty.' };
  if (items.length > MAX_ORDER_LINES) return { ok: false, message: `An order can have at most ${MAX_ORDER_LINES} items.` };
  for (const item of items) {
    if (!item || typeof item.productId !== 'string' || !OBJECT_ID_PATTERN.test(item.productId) ||
        !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QUANTITY_PER_LINE) {
      return { ok: false, message: 'Invalid item in cart.' };
    }
  }
  const ids = [...new Set(items.map((i) => i.productId.toLowerCase()))];
  const products = await Product.find({ _id: { $in: ids } }).select('title price vendorId stock sizeStock').lean();
  const priceMap = new Map(products.map((p) => [String(p._id), p]));
  const wanted = new Map();   // total quantity per product (the same product may be in the cart
  const wantedBySize = new Map();   // total quantity per product and size
  for (const item of items) {
    const key = item.productId.toLowerCase();
    wanted.set(key, (wanted.get(key) || 0) + item.quantity);
    if (typeof item.size === 'string') {
      const sk = `${key}|${sizeKey(item.size)}`;
      wantedBySize.set(sk, (wantedBySize.get(sk) || 0) + item.quantity);
    }
  }
  let subtotalMinor = 0;
  const lines = [];
  for (const item of items) {
    const key = item.productId.toLowerCase();
    const product = priceMap.get(key);
    const seller = product ? await marketplace.sellerOf(product) : null;
    const inCart = tracksSizes(product || {}) && typeof item.size === 'string' ? wantedBySize.get(`${key}|${sizeKey(item.size)}`) : wanted.get(key);
    const problem = cartLineProblem(item, product, seller, inCart);
    if (problem) return { ok: false, message: problem.message };
    subtotalMinor += toMinor(product.price) * item.quantity;
    lines.push({ price: product.price, quantity: item.quantity, ...(seller ? { vendorId: seller._id, commissionPercent: seller.commissionPercent } : {}) });
  }
  return { ok: true, subtotal: fromMinor(subtotalMinor), lines };
}

// Tells the admin panels and the customer about a newly confirmed order.
// Never throws and never waits for the mail server.
function announceConfirmedOrder(order, req) {
  try {
    const io = req.app.get('io');
    if (io) io.emit('newOrder');
  } catch (err) {
    console.error('Socket error:', err.message);
  }
  // Not awaited so the customer does not wait on the mail server.
  try {
    Promise.resolve(require('../services/emailService').sendOrderConfirmation(order))
      .catch((err) => console.error('Email error:', err.message));
  } catch (err) {
    console.error('Email error:', err.message);
  }
}

// Shared by every payment path (SSLCommerz redirect and IPN, Stripe redirect and webhook) that moves an order from PENDING to CONFIRMED.
async function markOrderPaid(filter, valId, req) {
  const order = await Order.findOneAndUpdate(
    { ...filter, status: 'PENDING' },
    { status: 'CONFIRMED', paidAt: new Date(), valId },
    { returnDocument: 'after' }
  );
  if (!order) return null;

  announceConfirmedOrder(order, req);
  return order;
}

// A verified payment arrived for an already cancelled order (e.g. paid as the unpaid-order timer
// expired).
async function recordLatePayment(order, valId, req) {
  // Only the FIRST late payment is recorded.
  const flagged = await Order.updateOne(
    { _id: order._id, status: 'CANCELLED', paymentIssue: null, refundedAt: null },
    { $set: { paymentIssue: 'PAID_AFTER_CANCEL', ...(valId ? { valId: String(valId) } : {}) } }
  );
  if (!(flagged.modifiedCount || flagged.nModified)) return;   // already known: nothing to change, nothing to announce
  await Order.updateOne({ _id: order._id, paidAt: null }, { $set: { paidAt: new Date() } });
  console.error(
    `[ACTION NEEDED] Payment received for CANCELLED order ${order.transactionId} ` +
    `(${order.customerEmail}, total ${order.totalAmount}). Reopen it in the admin panel or refund the customer.`
  );
  const io = req.app.get('io');
  if (io) io.emit('orderUpdate');
}

async function settlePaidOrder(filter, valId, req) {
  const confirmed = await markOrderPaid(filter, valId, req);
  if (confirmed) return { result: 'confirmed', order: confirmed };

  const existing = await Order.findOne(filter);
  if (!existing) return { result: 'missing', order: null };
  if (existing.status === 'CANCELLED') {
    await recordLatePayment(existing, valId, req);
    return { result: 'late', order: existing };
  }
  return { result: 'already', order: existing };
}

// Verifies an SSLCommerz payment with the gateway and checks that it belongs
// to the given order and covers its full amount before the order is confirmed.
// Resolves to { result: 'confirmed' | 'late' | 'already' | 'invalid', order?, reason? }.
async function confirmSslcommerzPayment(tranId, valId, req) {
  if (typeof tranId !== 'string' || typeof valId !== 'string' || !tranId || !valId) {
    return { result: 'invalid', reason: 'invalid_status' };
  }

  const order = await Order.findOne({ transactionId: tranId });
  if (!order) return { result: 'invalid', reason: 'validation_failed' };
  if (order.status !== 'PENDING' && order.status !== 'CANCELLED') return { result: 'already', order };

  const sslcz = new SSLCommerzPayment(STORE_ID, STORE_PASSWORD, IS_LIVE);
  const validation = await sslcz.validate({ val_id: valId });

  const paidInFull =
    (validation?.status === 'VALID' || validation?.status === 'VALIDATED') &&
    validation.tran_id === tranId &&
    Math.abs(toMinor(validation.amount) - toMinor(order.totalAmount)) === 0 &&
    (!validation.currency_type || validation.currency_type === currencyCode());
  if (!paidInFull) {
    return { result: 'invalid', reason: order.status === 'CANCELLED' ? 'cancelled' : 'validation_failed' };
  }

  // risk_level 1 means medium/high risk per SSLCommerz docs. Flag for manual review instead of auto-confirming;
  // an admin confirms these in the panel.
  if (Number(validation.risk_level) === 1 && order.status === 'PENDING') {
    await Order.findOneAndUpdate(
      { _id: order._id, status: 'PENDING' },
      { $set: { paymentIssue: 'PAYMENT_UNCONFIRMED', valId } },
      { returnDocument: 'after' }
    );
    return { result: 'flagged', order };
  }

  const outcome = await settlePaidOrder({ _id: order._id }, valId, req);
  return outcome.result === 'missing' ? { result: 'invalid', reason: 'validation_failed' } : outcome;
}

// Confirms a paid Stripe Checkout session, after checking that it belongs to an
// order, was paid in the card currency and covers the exact amount the session was created for.
// Resolves like settlePaidOrder, or { result: 'invalid', reason }.
async function settleStripeSession(session, req) {
  const tranId = session && session.client_reference_id;
  if (!session || session.payment_status !== 'paid' || typeof tranId !== 'string' || !tranId) {
    return { result: 'invalid', reason: 'validation_failed' };
  }
  const order = await Order.findOne({ transactionId: tranId });
  if (!order) return { result: 'invalid', reason: 'validation_failed' };
  if (order.paymentGateway !== 'stripe') return { result: 'invalid', reason: 'validation_failed' };

  // The amount Stripe must have charged: the amount recorded when the checkout was created, or, for an
  // order that has none, the order total converted at the current rate. The match is exact.
  const expectedCents = Number.isInteger(order.stripeAmountCents)
    ? order.stripeAmountCents
    : intl.toMinorUnits(order.totalAmount);
  const paidCents = Number(session.amount_total);
  const currencyOk = String(session.currency || '').toLowerCase() === String(order.gatewayCurrency || cardCurrency()).toLowerCase();
  const amountOk = paidCents === expectedCents;
  if (!currencyOk || !amountOk) {
    console.error(
      `[ACTION NEEDED] Stripe session ${session.id} for order ${tranId} paid ${paidCents} ${session.currency}, ` +
      `expected ${expectedCents} ${order.gatewayCurrency || cardCurrency()}. The order was NOT confirmed.`
    );
    return { result: 'invalid', reason: 'validation_failed' };
  }

  const outcome = await settlePaidOrder({ transactionId: tranId }, session.payment_intent, req);
  return outcome.result === 'missing' ? { result: 'invalid', reason: 'validation_failed' } : outcome;
}


function sendOutcome(res, outcome, tranId) {
  if (outcome.result === 'invalid') {
    return res.redirect(`${BASE_URL}/payment-fail.html?reason=${outcome.reason || 'validation_failed'}`);
  }
  if (outcome.result === 'late') {
    return res.redirect(`${BASE_URL}/payment-fail.html?reason=paid_late&tran_id=${encodeURIComponent(tranId)}`);
  }
  if (outcome.result === 'already') {
    return res.redirect(`${BASE_URL}/payment-success.html?tran_id=${encodeURIComponent(tranId)}&already=true`);
  }
  if (outcome.result === 'flagged') {
    // Paid but flagged for review: show the success page with a pending note.
    return res.redirect(`${BASE_URL}/payment-success.html?tran_id=${encodeURIComponent(tranId)}&review=1`);
  }
  return res.redirect(`${BASE_URL}/payment-success.html?tran_id=${encodeURIComponent(tranId)}&amount=${outcome.order.totalAmount}`);
}

// Confirms an order paid through PayPal, Flutterwave or Mollie. `verified` is the gateway's answer
// ({ paid, amountMinor, currency, ref }), and must match the order's gateway, amount and currency.
// Resolves like settlePaidOrder, or { result: 'invalid', reason }.
async function settleIntlPayment(gateway, tranId, verified, req) {
  if (!verified || verified.paid !== true || typeof tranId !== 'string' || !tranId) {
    return { result: 'invalid', reason: 'validation_failed' };
  }
  const order = await Order.findOne({ transactionId: tranId });
  if (!order || order.paymentGateway !== gateway) return { result: 'invalid', reason: 'validation_failed' };

  const amountOk = Number.isInteger(order.gatewayAmountMinor) && verified.amountMinor === order.gatewayAmountMinor;
  const currencyOk = String(verified.currency || '').toUpperCase() === String(order.gatewayCurrency || cardCurrency()).toUpperCase();
  if (!amountOk || !currencyOk) {
    console.error(
      `[ACTION NEEDED] ${intl.GATEWAY_NAMES[gateway]} payment ${verified.ref} for order ${tranId} was ${verified.amountMinor} ` +
      `${verified.currency}, expected ${order.gatewayAmountMinor} ${order.gatewayCurrency}. The order was NOT confirmed.`
    );
    return { result: 'invalid', reason: 'validation_failed' };
  }

  const outcome = await settlePaidOrder({ transactionId: tranId }, verified.ref, req);
  return outcome.result === 'missing' ? { result: 'invalid', reason: 'validation_failed' } : outcome;
}


// A cancel/fail callback comes from the browser and the customer may have paid, so the gateway is
// asked first.
async function checkGatewayPayment(order, req) {
  const gw = order.paymentGateway;
  if (gw === 'sslcommerz') {
    if (!sslcommerzConfigured()) return { state: 'unknown' };
    const sslcz = new SSLCommerzPayment(STORE_ID, STORE_PASSWORD, IS_LIVE);
    const found = await sslcz.transactionQueryByTransactionId({ tran_id: order.transactionId });
    if (!found || found.APIConnect !== 'DONE') return { state: 'unknown' };
    const rows = Array.isArray(found.element) ? found.element : [];
    const paidRow = rows.find((r) => r && (r.status === 'VALID' || r.status === 'VALIDATED') && r.val_id);
    if (paidRow) {
      const outcome = await confirmSslcommerzPayment(order.transactionId, String(paidRow.val_id), req);
      return outcome.result === 'invalid' ? { state: 'unknown' } : { state: 'paid' };
    }
    return { state: 'unpaid' };
  }
  if (gw === 'stripe') {
    if (!stripe || !order.gatewayRef) return { state: 'unknown' };
    const session = await stripe.checkout.sessions.retrieve(order.gatewayRef);
    if (session.payment_status === 'paid') {
      const outcome = await settleStripeSession(session, req);
      return outcome.result === 'invalid' ? { state: 'unknown' } : { state: 'paid' };
    }
    return { state: 'unpaid' };
  }
  if (gw === 'paypal') {
    if (!intl.isConfigured('paypal') || !order.gatewayRef) return { state: 'unknown' };
    const status = await intl.paypalStatus(order.gatewayRef);
    if (status.unknown) return { state: 'unknown' };
    if (status.paid) {
      const outcome = await settleIntlPayment('paypal', order.transactionId, status, req);
      return outcome.result === 'invalid' ? { state: 'unknown' } : { state: 'paid' };
    }
    return { state: 'unpaid' };
  }
  if (gw === 'mollie') {
    if (!intl.isConfigured('mollie') || !order.gatewayRef) return { state: 'unknown' };
    const payment = await intl.mollieGet(order.gatewayRef);
    if (payment.paid) {
      const outcome = await settleIntlPayment('mollie', order.transactionId, payment, req);
      return outcome.result === 'invalid' ? { state: 'unknown' } : { state: 'paid' };
    }
    return ['canceled', 'failed', 'expired'].includes(payment.status) ? { state: 'unpaid' } : { state: 'unknown' };
  }
  return { state: 'unknown' };
}

// Cancels a PENDING order (and gives its stock back) only when the gateway confirms nothing was
// paid.
async function cancelPendingIfUnpaid(filter, req) {
  const order = await Order.findOne({ ...filter, status: 'PENDING' });
  if (!order || order.paymentIssue === 'PAYMENT_UNCONFIRMED') return null;
  let verdict;
  try {
    verdict = await checkGatewayPayment(order, req);
  } catch (err) {
    console.error(`Could not ask the gateway about order ${order.transactionId}:`, err.message);
    verdict = { state: 'unknown' };
  }
  if (verdict.state !== 'unpaid') return null;
  const cancelled = await cancelPendingOrder({ _id: order._id });
  // A Stripe session must not stay payable once its stock reservation is released.
  if (cancelled && order.paymentGateway === 'stripe' && stripe && order.gatewayRef) {
    Promise.resolve(stripe.checkout.sessions.expire(order.gatewayRef)).catch(() => {});
  }
  return cancelled;
}

// Cart coupon box: prices the cart and checks the coupon. Nothing is used up until the order is
// placed.
router.post('/coupons/validate', sameOrigin, couponLimiter, async (req, res) => {
  try {
    const { code, items } = req.body || {};
    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ valid: false, message: 'Enter a coupon code.' });
    }
    if (code.length > MAX_COUPON_INPUT_LENGTH) {
      return res.status(400).json({ valid: false, message: 'This coupon code is not valid.' });
    }

    const cart = await priceCartItems(items);
    if (!cart.ok) return res.status(400).json({ valid: false, message: cart.message });

    // The per-customer limit needs the email, which the cart sends once typed.
    const rawEmail = (req.body || {}).email;
    const customerKey = typeof rawEmail === 'string' && rawEmail.length <= 254 && /^[^\s@,;:<>()\[\]"'\\]+@[^\s@,;:<>()\[\]"'\\]+\.[^\s@,;:<>()\[\]"'\\]+$/.test(rawEmail.trim())
      ? normalizeCustomerKey(rawEmail) : null;
    const result = await previewCoupon(code, cart.subtotal, new Date(), customerKey);
    if (!result.ok) return res.status(400).json({ valid: false, message: result.message });
    // Same arithmetic as checkout (shipping counts toward the total), so the preview never refuses a coupon checkout accepts.
    const rawCity = (req.body || {}).city;
    const previewCity = typeof rawCity === 'string' ? rawCity.trim().slice(0, 100) : '';
    const goodsMinor = toMinor(cart.subtotal) - toMinor(result.discount);
    const previewShipping = quoteShipping(fromMinor(goodsMinor), previewCity, shippingSettings());
    // With COUPON_SPLIT_PRO_RATA the discount is shared by the sellers, so no coupon can push the
    // marketplace below zero.
    if (marketplace.enabled() && !marketplace.couponSplitProRata() && marketplace.wouldLoseMoney(cart.lines, goodsMinor + toMinor(previewShipping.fee))) {
      return res.status(400).json({ valid: false, message: 'This coupon cannot be used with the items in your cart.' });
    }

    res.json({
      valid: true,
      code: result.code,
      subtotal: cart.subtotal,
      discount: result.discount,
      total: round2(cart.subtotal - result.discount)
    });
  } catch (err) {
    console.error('Coupon check error:', err.message);
    res.status(500).json({ valid: false, message: 'Could not check the coupon right now. Please try again.' });
  }
});

// Only methods that are really configured are reported as enabled.
router.get('/payment-options', (req, res) => {
  const { enabled, maxAmount } = codSettings();
  const manual = manualSettings();
  const options = {
    cod: { enabled, maxAmount },
    manual: { enabled: manual.enabled, hours: manual.hours, instructions: manual.instructions },
    sslcommerz: { enabled: sslcommerzConfigured() },
    stripe: { enabled: !!stripe },
    paypal: { enabled: intl.isConfigured('paypal') },
    flutterwave: { enabled: intl.isConfigured('flutterwave') },
    mollie: { enabled: intl.isConfigured('mollie') }
  };
  // When the card currency differs from the price currency, ?total= (the total on screen) is
  // answered with what each card gateway will charge, worked out the same way as at checkout.
  if (cardCurrency() && cardCurrency() !== currencyCode()) {
    options.card = { currency: cardCurrency() };
    const total = String(req.query.total || '');
    if (/^\d{1,12}(\.\d{1,3})?$/.test(total)) {
      options.card.amounts = {};
      ['stripe', 'paypal', 'flutterwave', 'mollie'].forEach((gateway) => {
        options.card.amounts[gateway] = intl.minorToDecimal(intl.toMinorUnits(total, process.env, gateway), cardCurrency(), gateway);
      });
    }
  }
  res.json(options);
});

// Lets the page show the fee before checkout ({ enabled: false } unless SHIPPING_ENABLED=true).
// The server charges its own figure.
router.get('/shipping-options', (req, res) => {
  res.json(publicShippingOptions(shippingSettings()));
});

// The sizes a product can be sold in.
router.get('/sizes', (req, res) => res.json({ sizes: SIZES }));

// The store's own contact details for the footer.
router.get('/site-info', (req, res) => {
  const clean = (v, max) => String(v || '').trim().slice(0, max);
  const email = clean(process.env.SUPPORT_EMAIL, 120);
  res.json({
    name: clean(process.env.SITE_NAME, 60),
    supportEmail: /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email) ? email : '',
    supportPhone: clean(process.env.SUPPORT_PHONE, 40),
    supportAddress: clean(process.env.SUPPORT_ADDRESS, 160),
    // Decimals of the shop's prices (0, 2 or 3). A number only: the interface never shows a currency.
    currencyDecimals: displayDecimals(),
    cardCurrency: cardCurrency()
  });
});

// For products that keep stock per size: " (sizes: S 3, M sold out)" for the chatbot to use when
// it answers size questions.
function sizeSummary(p) {
  if (!tracksSizes(p)) return '';
  const parts = SIZES.filter((s) => sizeKey(s) in p.sizeStock).map((s) => `${s} ${unitsOf(p, s) > 0 ? unitsOf(p, s) : 'sold out'}`);
  return parts.length ? ` (sizes: ${parts.join(', ')})` : '';
}

// Uploaded pictures are swapped for a cacheable address (see the image route below) to keep the list small.
router.get('/products', async (req, res) => {
  try {
    // ?limit= (default 200, max 500) and ?skip=; X-Has-More: true while more remain.
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const skip = Math.max(0, parseInt(req.query.skip, 10) || 0);
    const rows = await Product.aggregate([
      { $match: await marketplace.visibleFilter() },
      { $sort: { createdAt: -1, _id: -1 } },
      { $skip: skip },
      { $limit: limit + 1 },
      listImageStage()
    ]);
    const hasMore = rows.length > limit;
    res.set('X-Has-More', hasMore ? 'true' : 'false');
    const products = hasMore ? rows.slice(0, limit) : rows;
    // Tags each vendor product with its seller.
    const shown = await marketplace.visibleProducts(products);
    res.json(shown.map(({ product, vendor }) => (vendor ? { ...publicProduct(product), vendor } : publicProduct(product))));
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch products' });
  }
});

router.get('/products/:id', async (req, res) => {
  try {
    if (!OBJECT_ID_PATTERN.test(req.params.id)) return res.status(404).json({ message: 'Product not found' });
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    const seller = await marketplace.sellerOf(product);
    if (seller === false) return res.status(404).json({ message: 'Product not found' });
    res.json(seller ? { ...publicProduct(product), vendor: { name: seller.name, slug: seller.slug } } : publicProduct(product));
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch product' });
  }
});

router.get('/products/:id/image', async (req, res) => {
  try {
    if (!OBJECT_ID_PATTERN.test(req.params.id)) return res.status(404).end();
    const product = await Product.findById(req.params.id).select('imageUrl vendorId');
    if (!product || !product.imageUrl) return res.status(404).end();
    // A product that is hidden (its shop is suspended or not approved) hides its picture too.
    if ((await marketplace.sellerOf(product)) === false) return res.status(404).end();
    const parsed = parseDataUri(product.imageUrl);
    if (!parsed) {
      // A picture that is a file of this site (/img/...) redirects there. Other hosts are never followed
      // (open redirect).
      if (isLocalImagePath(product.imageUrl)) return res.redirect(product.imageUrl);
      return res.status(404).end();
    }
    res.set({
      'Content-Type': parsed.type,
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox"
    });
    res.send(parsed.buffer);
  } catch (err) {
    res.status(500).end();
  }
});

// The visible reviews of a product, newest first, with the average rating.
router.get('/products/:id/reviews', async (req, res) => {
  try {
    if (!OBJECT_ID_PATTERN.test(req.params.id)) return res.status(404).json({ message: 'Product not found.' });
    const product = await Product.findById(req.params.id).select('vendorId ratingAverage ratingCount');
    if (!product) return res.status(404).json({ message: 'Product not found.' });
    if ((await marketplace.sellerOf(product)) === false) return res.status(404).json({ message: 'Product not found.' });
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 10;
    const filter = { productId: product._id, hidden: false };
    const [list, total] = await Promise.all([
      Review.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).select('authorName rating text createdAt').lean(),
      Review.countDocuments(filter)
    ]);
    res.json({
      average: product.ratingAverage || 0,
      count: product.ratingCount || 0,
      reviews: list.map((r) => ({ authorName: r.authorName, rating: r.rating, text: r.text, createdAt: r.createdAt })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (err) {
    console.error('Error fetching reviews:', err.message);
    res.status(500).json({ message: 'Failed to fetch reviews.' });
  }
});

// Lets the storefront hide the chat bubble when the chatbot is switched off or has no usable key.
router.get('/chat-status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ enabled: chatEnabled() });
});

router.post('/chat', sameOrigin, chatLimiter, async (req, res) => {
  let budgetTaken = false;
  let addressBudgetTaken = false;
  try {
    const { message } = req.body || {};
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ message: 'Message is required.' });
    }
    if (message.length > 500) {
      return res.status(400).json({ message: 'Message is too long.' });
    }
    if (!chatEnabled()) {
      return res.status(503).json({ message: 'The assistant is not available.', chatEnabled: false });
    }

    // Each message is a paid provider call. A visitor first spends their own daily share
    // (CHAT_DAILY_LIMIT_PER_IP, default 100), so one abuser cannot empty the shop's limit for
    // everyone; then the shop-wide CHAT_DAILY_LIMIT (default 2000, 0 = no cap) is counted.
    if (!chatClients.takeAddressBudget(req.ip)) {
      return res.status(429).json({ message: 'You have reached the assistant\'s limit for today. Please check the FAQ or contact us.' });
    }
    addressBudgetTaken = true;
    if (!takeChatBudget()) {
      chatClients.refundAddressBudget(req.ip);
      addressBudgetTaken = false;
      return res.status(429).json({ message: 'The assistant has reached its limit for today. Please check the FAQ or contact us.' });
    }
    budgetTaken = true;

    // Earlier turns come from the server's own memory of this visitor's conversation (found by a
    // random cookie), never from the request and never from a session document.
    const chatId = chatClients.clientId(req, res);
    const turns = chatClients.getTurns(chatId);

    // Newest products first, only from open shops.
    const found = await Product.find().select('title price stock sizeStock category vendorId').sort({ createdAt: -1 }).limit(150);
    const products = (await marketplace.visibleProducts(found)).map(({ product }) => product).slice(0, 100);
    const productContext = products
      .map(p => `- ${p.title} (${p.category}): price ${p.price}, ${p.stock > 0 ? `${p.stock} in stock` : 'out of stock'}${sizeSummary(p)}`)
      .join('\n');

    const reply = await getChatReply({ userMessage: message, productContext, history: turns });
    chatClients.saveTurns(chatId, [...turns, { role: 'user', text: message.trim().slice(0, 500) }, { role: 'bot', text: reply.slice(0, 500) }]);
    res.json({ reply });
  } catch (err) {
    // Only the kind of failure is logged, never the provider's answer or the customer's text.
    if (budgetTaken) refundChatBudget();
    if (addressBudgetTaken) chatClients.refundAddressBudget(req.ip);
    console.error('Chat error:', err && err.name === 'ChatError' ? `${err.code} ${err.status || ''}`.trim() : (err && err.name) || 'error');
    if (err instanceof ChatError && err.code === 'BAD_INPUT') return res.status(400).json({ message: err.userMessage });
    // Provider busy or unreachable is a 503, not a server fault.
    res.status(503).json({ message: (err instanceof ChatError && err.userMessage) || 'Sorry, the assistant is unavailable right now. Please try again in a moment.' });
  }
});

const ORDER_PAYMENT_METHODS = ['sslcommerz', 'stripe', 'paypal', 'flutterwave', 'mollie', 'cod', 'manual'];

// A checkout reference made by the storefront (a UUID, or 32 random characters).
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,100}$/;
const sameEmail = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

router.post('/orders', sameOrigin, orderLimiter, async (req, res) => {
  const reserved = [];
  let order = null;
  let claimedCoupon = null;
  let claimedCouponCustomerKey = null;
  let reqId = null;

  async function releaseClaimedCoupon() {
    if (!claimedCoupon) return;
    const couponId = claimedCoupon._id;
    const key = claimedCouponCustomerKey;
    claimedCoupon = null;
    await releaseCoupon(couponId, key);
  }

  async function abandonOrder() {
    if (order) {
      const cancelled = await cancelPendingOrder({ _id: order._id });
      if (cancelled) {
        try { await Order.findByIdAndDelete(order._id); } catch (err) { /* stays CANCELLED */ }
      }
    } else {
      if (reserved.length) await restockItems(reserved.splice(0));
      await releaseClaimedCoupon();
    }
    // Stock was shown as reserved to other shoppers; show it as free again.
    emitEvent(req, 'productUpdate');
  }

  function replayOf(existing) {
    const online = !['cod', 'manual'].includes(existing.paymentGateway);
    const base = {
      idempotent: true,
      transactionId: existing.transactionId,
      orderId: existing._id,
      amount: existing.totalAmount
    };
    if (existing.paymentGateway === COD_GATEWAY) {
      return { status: 200, body: { ...base, cod: true, codPlaced: existing.status === 'PLACED' } };
    }
    if (existing.paymentGateway === 'manual') {
      return { status: 200, body: { ...base, manual: true, manualPlaced: existing.status === 'PLACED', ...manualDetails() } };
    }
    if (online && existing.status === 'PENDING' && existing.gatewayUrl) {
      return { status: 200, body: { ...base, paymentUrl: existing.gatewayUrl } };
    }
    if (online && existing.status === 'CONFIRMED') {
      return { status: 200, body: { ...base, paid: true } };
    }
    return {
      status: 409,
      body: { message: 'This checkout has expired. Please place the order again.', expired: true }
    };
  }

  try {
    const {
      customerName,
      customerEmail,
      customerPhone,
      deliveryAddress,
      paymentGateway,
      couponCode,
      expectedTotal,
      clientRequestId,
      items
    } = req.body || {};

    // Unknown methods are refused; omitting it means SSLCommerz.
    const methodGiven = paymentGateway !== undefined && paymentGateway !== null && paymentGateway !== '';
    if (methodGiven && !(typeof paymentGateway === 'string' && ORDER_PAYMENT_METHODS.includes(paymentGateway))) {
      return res.status(400).json({ message: 'Unknown payment method.' });
    }

    // Idempotency: a double click or Back must not create a second order. A repeated reference only
    // returns the first order when the e-mail matches.
    reqId = typeof clientRequestId === 'string' && CLIENT_REQUEST_ID_PATTERN.test(clientRequestId) ? clientRequestId : null;
    if (reqId) {
      const existing = await Order.findOne({ clientRequestId: reqId });
      if (existing) {
        if (!sameEmail(customerEmail, existing.customerEmail) || typeof customerEmail !== 'string') {
          return res.status(409).json({ message: 'This checkout reference is already in use.' });
        }
        const replay = replayOf(existing);
        return res.status(replay.status).json(replay.body);
      }
    }

    if (typeof customerName !== 'string' || typeof customerEmail !== 'string' ||
        !customerName.trim() || !customerEmail.trim() ||
        !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'Name, email, and items are required.' });
    }

    if (!/^[^\s@,;:<>()\[\]"'\\]+@[^\s@,;:<>()\[\]"'\\]+\.[^\s@,;:<>()\[\]"'\\]+$/.test(customerEmail) || customerEmail.length > 254) {
      return res.status(400).json({ message: 'Invalid email address.' });
    }

    if (customerName.trim().length < 2) {
      return res.status(400).json({ message: 'Name must be at least 2 characters.' });
    }

    if (customerName.length > 100) {
      return res.status(400).json({ message: 'Name is too long.' });
    }

    const phone = typeof customerPhone === 'string' ? customerPhone.trim() : '';
    if (phone.length > 30 || (customerPhone != null && typeof customerPhone !== 'string')) {
      return res.status(400).json({ message: 'Invalid phone number.' });
    }

    const addressInput = deliveryAddress && typeof deliveryAddress === 'object' && !Array.isArray(deliveryAddress)
      ? deliveryAddress
      : {};
    const cleanAddress = {};
    for (const [field, maxLength] of ADDRESS_FIELD_LIMITS) {
      const value = addressInput[field];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string' || value.length > maxLength) {
        return res.status(400).json({ message: 'Delivery address is invalid or too long.' });
      }
      cleanAddress[field] = value.trim();
    }

    if (items.length > MAX_ORDER_LINES) {
      return res.status(400).json({ message: `An order can have at most ${MAX_ORDER_LINES} items.` });
    }

    const hasCoupon = couponCode !== undefined && couponCode !== null && couponCode !== '';
    if (hasCoupon && (typeof couponCode !== 'string' || couponCode.length > MAX_COUPON_INPUT_LENGTH)) {
      return res.status(400).json({ message: 'This coupon code is not valid.', couponInvalid: true });
    }

    const isCod = paymentGateway === COD_GATEWAY;
    const isStripe = paymentGateway === 'stripe';
    const isManual = paymentGateway === 'manual';
    const isIntl = intl.isIntlGateway(paymentGateway);
    const gateway = isCod ? COD_GATEWAY : isStripe ? 'stripe' : isManual ? 'manual' : isIntl ? paymentGateway : 'sslcommerz';

    if (isCod && !codSettings().enabled) {
      return res.status(400).json({ message: 'Cash on Delivery is not available. Please choose another payment method.' });
    }
    if (isCod) {
      // Nothing is reserved or claimed yet, so stopping here leaves no stock or coupon to give back.
      // When the limiter answers 429 it never calls next, so the response ending also ends the wait.
      await new Promise((resolve) => {
        res.once('finish', resolve);
        codOrderLimiter(req, res, () => { res.removeListener('finish', resolve); resolve(); });
      });
      if (res.headersSent) return;
    }
    if (isManual && !manualSettings().enabled) {
      return res.status(400).json({ message: 'Manual payment is not available. Please choose another payment method.' });
    }
    if (isStripe && !stripe) {
      return res.status(400).json({ message: 'Stripe is not configured on this store yet. Please choose another payment method.' });
    }
    if (isIntl && !intl.isConfigured(gateway)) {
      return res.status(400).json({ message: `${intl.GATEWAY_NAMES[gateway]} is not configured on this store yet. Please choose another payment method.` });
    }
    if (gateway === 'sslcommerz' && !sslcommerzConfigured()) {
      return res.status(400).json({
        message: 'Online payment is not set up on this store yet. Please choose another payment method.'
      });
    }

    // Online methods need a way to reach the customer and a full delivery address.
    if (!isCod && !isManual) {
      const a = cleanAddress;
      if (!isUsablePhone(phone) || !a.address || !a.city || !a.postcode || !a.country) {
        return res.status(400).json({
          message: 'Online payment needs a valid phone number and a full delivery address (street address, city, postcode and country).'
        });
      }
    }

    const orderItems = [];
    let subtotalMinor = 0;

    for (const item of items) {
      if (!item || typeof item.productId !== 'string' || !OBJECT_ID_PATTERN.test(item.productId) ||
          !Number.isInteger(item.quantity) || item.quantity < 1) {
        return res.status(400).json({ message: 'Invalid item in order.' });
      }
      if (item.quantity > MAX_QUANTITY_PER_LINE) {
        return res.status(400).json({ message: `You can order at most ${MAX_QUANTITY_PER_LINE} of one item.` });
      }
      const product = await Product.findById(item.productId);
      const seller = product ? await marketplace.sellerOf(product) : null;
      // A seller may not buy from their own shop (it would pay them commission and earnings).
      if (seller && seller.ownerUserId && req.session && req.session.userId && String(seller.ownerUserId) === String(req.session.userId)) {
        return res.status(403).json({ message: 'You cannot buy a product from your own shop.' });
      }
      const problem = cartLineProblem(item, product, seller);
      if (problem) {
        const { status, ...body } = problem;
        return res.status(status).json(body);
      }
      const sizeTracked = tracksSizes(product);
      orderItems.push({
        productId: product._id,
        title:     product.title,
        price:     product.price,
        quantity:  item.quantity,
        size:      item.size,
        ...(sizeTracked ? { sizeTracked: true } : {}),
        // Who sold it and the commission that applies to this order (vendor products only).
        ...(seller ? { vendorId: seller._id, commissionPercent: seller.commissionPercent } : {})
      });
      subtotalMinor += toMinor(product.price) * item.quantity;
    }

    const subtotalAmount = fromMinor(subtotalMinor);
    let totalAmountMinor = subtotalMinor;
    let discountAmount = 0;

    claimedCouponCustomerKey = normalizeCustomerKey(customerEmail);
    if (hasCoupon) {
      const applied = await applyCoupon(couponCode, subtotalAmount, new Date(), claimedCouponCustomerKey);
      if (!applied.ok) return res.status(400).json({ message: applied.message, couponInvalid: true });
      claimedCoupon = applied.coupon;
      discountAmount = applied.discount;
      totalAmountMinor = Math.max(0, subtotalMinor - toMinor(discountAmount));
      // COUPON_SPLIT_PRO_RATA (off by default): the discount is split over the item lines pro rata
      // (whole minor units, the remainder to the last line) and kept on each line.
      if (marketplace.couponSplitProRata()) {
        const shares = marketplace.splitDiscount(orderItems.map((l) => toMinor(l.price) * l.quantity), subtotalMinor - totalAmountMinor);
        orderItems.forEach((l, i) => { if (shares[i] > 0) l.discountMinor = shares[i]; });
      }
    }

    // Shipping (only when SHIPPING_ENABLED=true), added after the coupon so the discount never touches the fee.
    const shipping = quoteShipping(fromMinor(totalAmountMinor), cleanAddress.city, shippingSettings());
    const shippingAmount = shipping.fee;
    totalAmountMinor += toMinor(shippingAmount);
    const totalAmount = fromMinor(totalAmountMinor);

    // Sellers always earn price minus commission, so a coupon comes out of the marketplace's share.
    if (claimedCoupon && !marketplace.couponSplitProRata() && marketplace.wouldLoseMoney(orderItems, totalAmountMinor)) {
      await releaseClaimedCoupon();
      return res.status(400).json({ message: 'This coupon cannot be used with the items in your cart.', couponInvalid: true });
    }

    // The total the customer saw must be what they are charged.
    if (expectedTotal !== undefined && expectedTotal !== null) {
      let expectedMinor = NaN;
      try { expectedMinor = toMinor(expectedTotal); } catch (e) { /* mismatch below */ }
      if (expectedMinor !== totalAmountMinor) {
        await releaseClaimedCoupon();
        return res.status(409).json({
          message: 'The price of something in your cart changed. Please review your cart and try again.',
          priceChanged: true,
          serverTotal: totalAmount,
          expectedTotal
        });
      }
    }

    if (totalAmountMinor < minOrderMinor()) {
      await releaseClaimedCoupon();
      return res.status(400).json({ message: `An order needs a total of at least ${fromMinor(minOrderMinor())}.`, code: 'ORDER_TOO_SMALL', params: { min: fromMinor(minOrderMinor()) } });
    }
    // Card gateways charge in CARD_CURRENCY (price currency unless .env says otherwise) times CARD_RATE.
    const stripeAmountCents = isStripe ? intl.toMinorUnits(totalAmount) : undefined;
    if (isStripe && stripeAmountCents < intl.minChargeMinor(cardCurrency())) {
      await releaseClaimedCoupon();
      return res.status(400).json({
        message: 'This order total is too small for international card payment. Please choose another payment method.'
      });
    }

    // PayPal, Flutterwave and Mollie are charged the same way (see services/intlGateways.js).
    const intlAmountMinor = isIntl ? intl.toMinorUnits(totalAmount, process.env, gateway) : undefined;
    if (isIntl && intlAmountMinor < intl.minChargeMinor(cardCurrency(), gateway)) {
      await releaseClaimedCoupon();
      return res.status(400).json({
        message: 'This order total is too small for international payment. Please choose another payment method.'
      });
    }

    if (isCod) {
      const settings = codSettings();
      const openCodCount = await Order.countDocuments({
        $or: [
          ...(phone ? [{ customerPhone: phone }] : []),
          { customerEmail: customerEmail.trim().toLowerCase() }
        ],
        paymentGateway: COD_GATEWAY,
        status: { $in: ['PLACED', 'CONFIRMED'] }
      });
      if (openCodCount >= settings.maxOpenOrders) {
        await releaseClaimedCoupon();
        return res.status(400).json({
          message: `You have ${openCodCount} open Cash on Delivery orders. Please complete or confirm existing orders before placing another.`
        });
      }
      const codCheck = checkCodOrder({ phone, address: cleanAddress, totalAmount, items: orderItems }, settings);
      if (!codCheck.ok) {
        await releaseClaimedCoupon();
        return res.status(400).json({ message: codCheck.message });
      }
    }

    const reservation = await reserveItems(orderItems, reserved);
    if (!reservation.ok) {
      await releaseClaimedCoupon();
      const short = reservation.line || orderItems.find(line => line.title === reservation.title);
      const current = short ? await Product.findById(short.productId) : null;
      // A product that keeps stock per size reports the units of the size asked for, not the total.
      const sizedShort = short && short.sizeTracked && short.size;
      const left = !current ? 0 : (sizedShort ? unitsOf(current, short.size) : current.stock);
      return res.status(409).json({
        message: sizedShort
          ? `Not enough stock for "${reservation.title}" in size ${short.size}. Only ${left} left.`
          : `Not enough stock for "${reservation.title}". Only ${left} left.`,
        unavailable: short ? [String(short.productId)] : []
      });
    }

    const initialStatus = (isCod || isManual) ? 'PLACED' : 'PENDING';
    const prefix = isCod ? CODE_PREFIX : isManual ? 'MAN-' : 'TXN-';
    // 80 random bits: unauthenticated payment callbacks find the order by this id, so it must not be guessable.
    const transactionId = prefix + Date.now().toString(36).toUpperCase().padStart(8, '0') + randomBase32(16);

    const appliedCouponCode = claimedCoupon ? claimedCoupon.code : null;
    order = await Order.create({
      customerName:    customerName.trim(),
      customerEmail:   customerEmail.trim().toLowerCase(),
      customerPhone:   phone,
      deliveryAddress: cleanAddress,
      paymentGateway:  gateway,
      items:           orderItems,
      // One entry per vendor so each can ship their own items (marketplace orders only).
      ...(orderItems.some((i) => i.vendorId)
        ? { fulfillment: [...new Set(orderItems.filter((i) => i.vendorId).map((i) => String(i.vendorId)))].map((id) => ({ vendorId: id })) }
        : {}),
      subtotalAmount,
      totalAmount,
      couponType:      claimedCoupon ? claimedCoupon.type : null,
      couponValue:     claimedCoupon ? claimedCoupon.value : null,
      // Only stored when there is one: a null here would clash with the unique index.
      ...(reqId ? { clientRequestId: reqId } : {}),
      ...(stripeAmountCents !== undefined ? { stripeAmountCents, gatewayCurrency: cardCurrency() } : {}),
      ...(isIntl ? { gatewayAmountMinor: intlAmountMinor, gatewayCurrency: cardCurrency() } : {}),
      ...(claimedCoupon ? { couponId: claimedCoupon._id, couponCode: appliedCouponCode, discountAmount } : {}),
      ...(shippingAmount > 0 ? { shippingAmount } : {}),
      status:          initialStatus,
      transactionId,
      userId:          (req.session && req.session.userId) || null
    });
    claimedCoupon = null;

    // COD limit, second check: simultaneous requests can all pass the first one.
    if (isCod) {
      const settings = codSettings();
      const earlier = await Order.countDocuments({
        $or: [
          ...(phone ? [{ customerPhone: phone }] : []),
          { customerEmail: customerEmail.trim().toLowerCase() }
        ],
        paymentGateway: COD_GATEWAY,
        status: { $in: ['PLACED', 'CONFIRMED'] },
        _id: { $lt: order._id }
      });
      if (earlier >= settings.maxOpenOrders) {
        await cancelOrderAndRestock(order._id);
        emitEvent(req, 'productUpdate');
        return res.status(400).json({
          message: `You have ${earlier} open Cash on Delivery orders. Please complete or confirm existing orders before placing another.`
        });
      }
    }

    // Stock is taken: notify open storefront and admin pages.
    emitEvent(req, 'productUpdate');

    if (isCod) {
      announceConfirmedOrder(order, req);
      return res.json({
        cod:           true,
        codPlaced:     true,
        transactionId: transactionId,
        orderId:       order._id,
        amount:        order.totalAmount
      });
    }

    if (isManual) {
      announceConfirmedOrder(order, req);
      return res.json({
        manual:        true,
        manualPlaced:  true,
        transactionId: transactionId,
        orderId:       order._id,
        amount:        order.totalAmount,
        ...manualDetails()
      });
    }

    // Address and phone were validated above and go to the gateway as given.
    const custAddress  = cleanAddress.address;
    const custCity     = cleanAddress.city;
    const custPostcode = cleanAddress.postcode;
    const custCountry  = cleanAddress.country;
    const custPhone    = phone;

    if (isIntl) {
      try {
        const returnPaths = {
          paypal:      `${BASE_URL}/api/payment/paypal-return`,
          flutterwave: `${BASE_URL}/api/payment/flutterwave-return`,
          mollie:      `${BASE_URL}/api/payment/mollie-return?tran_id=${transactionId}`
        };
        const payment = await intl.createPayment(gateway, {
          transactionId,
          amountMinor: intlAmountMinor,
          currency:    cardCurrency(),
          description: `Order ${transactionId}: ` + itemSummary(orderItems),
          brandName:   brandName(),
          returnUrl:   returnPaths[gateway],
          cancelUrl:   `${BASE_URL}/api/payment/cancel?tran_id=${transactionId}`,
          webhookUrl:  `${BASE_URL}/api/payment/mollie-webhook`,
          customerName:  customerName.trim(),
          customerEmail: customerEmail.trim(),
          customerPhone: phone
        });
        // The return page finds the order by this reference; if it cannot be saved the order is abandoned below.
        await Order.updateOne({ _id: order._id }, { $set: { gatewayUrl: payment.url, gatewayRef: payment.ref } });
        return res.json({
          paymentUrl:    payment.url,
          transactionId: transactionId,
          orderId:       order._id
        });
      } catch (intlErr) {
        console.error(`${intl.GATEWAY_NAMES[gateway]} payment creation failed:`, intlErr.message);
        await abandonOrder();
        return res.status(502).json({ message: 'The payment gateway did not respond. Your cart is unchanged; please try again.' });
      }
    }

    if (gateway === 'stripe') {
      try {
        const session = await stripe.checkout.sessions.create({
          mode: 'payment',
          payment_method_types: ['card'],
          // One line for the whole order so Stripe charges exactly stripeAmountCents (no rounding drift).
          line_items: [{
            price_data: {
              currency: cardCurrency().toLowerCase(),
              product_data: {
                name: `Order ${transactionId}`,
                description: itemSummary(orderItems).slice(0, 500)
              },
              unit_amount: stripeAmountCents
            },
            quantity: 1
          }],
          customer_email: customerEmail.trim(),
          client_reference_id: transactionId,
          // Expires with the order, because stock is released then.
          expires_at: Math.floor(Date.now() / 1000) + (PENDING_ORDER_TTL_MINUTES + 2) * 60,
          success_url: `${BASE_URL}/api/payment/stripe-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url:  `${BASE_URL}/api/payment/cancel?tran_id=${transactionId}`
        });

        await Order.updateOne({ _id: order._id }, { $set: { gatewayUrl: session.url, gatewayRef: session.id } }).catch(() => {});
        return res.json({
          paymentUrl:    session.url,
          transactionId: transactionId,
          orderId:       order._id
        });
      } catch (stripeErr) {
        console.error('Stripe session creation failed:', stripeErr.message);
        await abandonOrder();
        return res.status(502).json({ message: 'The payment gateway did not respond. Your cart is unchanged; please try again.' });
      }
    }

    const sslData = {
      total_amount:     totalAmount,
      currency:         currencyCode(),
      tran_id:          transactionId,
      success_url:      `${BASE_URL}/api/payment/success`,
      fail_url:         `${BASE_URL}/api/payment/fail`,
      cancel_url:       `${BASE_URL}/api/payment/cancel`,
      ipn_url:          `${BASE_URL}/api/payment/ipn`,
      shipping_method:  'Courier',
      product_name:     orderItems.map(i => i.title).join(', '),
      product_category: 'Clothing',
      product_profile:  'general',
      cus_name:         customerName.trim(),
      cus_email:        customerEmail.trim(),
      cus_add1:         custAddress,
      cus_city:         custCity,
      cus_postcode:     custPostcode,
      cus_country:      custCountry,
      cus_phone:        custPhone,
      ship_name:        customerName.trim(),
      ship_add1:        custAddress,
      ship_city:        custCity,
      ship_postcode:    custPostcode,
      ship_country:     custCountry
    };

    const sslcz       = new SSLCommerzPayment(STORE_ID, STORE_PASSWORD, IS_LIVE);
    const apiResponse = await sslcz.init(sslData);

    if (apiResponse?.GatewayPageURL) {
      await Order.updateOne({ _id: order._id }, { $set: { gatewayUrl: apiResponse.GatewayPageURL } }).catch(() => {});
      return res.json({
        paymentUrl:    apiResponse.GatewayPageURL,
        transactionId: transactionId,
        orderId:       order._id
      });
    }

    console.error('SSLCommerz init failed. Full response:', apiResponse);
    await abandonOrder();
    return res.status(502).json({ message: 'The payment gateway did not accept the order. Your cart is unchanged; please try again or choose another payment method.' });

  } catch (err) {
    // Race: the second identical request hit the unique clientRequestId index. Undo its reservation and return the first order.
    if (err && err.code === 11000 && reqId) {
      try {
        await abandonOrder();
        const existing = await Order.findOne({ clientRequestId: reqId });
        if (existing) {
          if (!sameEmail(req.body && req.body.customerEmail, existing.customerEmail)) {
            return res.status(409).json({ message: 'This checkout reference is already in use.' });
          }
          const replay = replayOf(existing);
          return res.status(replay.status).json(replay.body);
        }
      } catch (cleanupErr) {
        console.error('Order cleanup error:', cleanupErr.message);
      }
    }
    console.error('Order error:', err);
    try {
      await abandonOrder();
    } catch (cleanupErr) {
      console.error('Order cleanup error:', cleanupErr.message);
    }
    res.status(500).json({ message: 'Failed to place order. Please try again.' });
  }
});

// SSLCommerz sends the browser here after a successful payment.
router.post('/payment/success', async (req, res) => {
  try {
    const { tran_id, val_id } = req.body || {};
    const outcome = await confirmSslcommerzPayment(tran_id, val_id, req);

    return sendOutcome(res, outcome, tran_id);
  } catch (err) {
    console.error('Payment success error:', err);
    res.redirect(`${BASE_URL}/payment-fail.html?reason=server_error`);
  }
});

router.post('/payment/fail', async (req, res) => {
  try {
    const order = await cancelPendingIfUnpaid({ transactionId: String((req.body || {}).tran_id) }, req);
    if (order) {
      const io = req.app.get('io');
      if (io) io.emit('productUpdate');
    }
    res.redirect(`${BASE_URL}/payment-fail.html?reason=payment_failed`);
  } catch (err) {
    console.error('Payment fail error:', err);
    res.redirect(`${BASE_URL}/payment-fail.html?reason=server_error`);
  }
});

router.post('/payment/cancel', async (req, res) => {
  try {
    const order = await cancelPendingIfUnpaid({ transactionId: String((req.body || {}).tran_id) }, req);
    if (order) {
      const io = req.app.get('io');
      if (io) io.emit('productUpdate');
    }
    res.redirect(`${BASE_URL}/payment-fail.html?reason=cancelled`);
  } catch (err) {
    console.error('Payment cancel error:', err);
    res.redirect(`${BASE_URL}/payment-fail.html?reason=server_error`);
  }
});

// Stripe Checkout redirects the browser here (GET), unlike SSLCommerz's POST callback.
router.get('/payment/stripe-success', async (req, res) => {
  try {
    if (!stripe) return res.redirect(`${BASE_URL}/payment-fail.html?reason=server_error`);
    const { session_id } = req.query;
    if (typeof session_id !== 'string' || !session_id) {
      return res.redirect(`${BASE_URL}/payment-fail.html?reason=invalid_status`);
    }

    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') {
      return res.redirect(`${BASE_URL}/payment-fail.html?reason=validation_failed`);
    }

    const tran_id = session.client_reference_id;
    const outcome = await settleStripeSession(session, req);
    if (outcome.result === 'invalid') {
      return res.redirect(`${BASE_URL}/payment-fail.html?reason=${outcome.reason}`);
    }
    if (outcome.result === 'late') {
      return res.redirect(`${BASE_URL}/payment-fail.html?reason=paid_late&tran_id=${encodeURIComponent(tran_id)}`);
    }
    if (outcome.result === 'already') {
      return res.redirect(`${BASE_URL}/payment-success.html?tran_id=${encodeURIComponent(tran_id)}&already=true`);
    }
    res.redirect(`${BASE_URL}/payment-success.html?tran_id=${encodeURIComponent(tran_id)}&amount=${outcome.order.totalAmount}`);
  } catch (err) {
    console.error('Stripe success error:', err);
    res.redirect(`${BASE_URL}/payment-fail.html?reason=server_error`);
  }
});

// Stripe Checkout's cancel_url lands here (GET); SSLCommerz's cancel callback is the POST route
// above.
router.get('/payment/cancel', async (req, res) => {
  try {
    const order = await cancelPendingIfUnpaid({ transactionId: String(req.query.tran_id) }, req);
    if (order) {
      const io = req.app.get('io');
      if (io) io.emit('productUpdate');
    }
    res.redirect(`${BASE_URL}/payment-fail.html?reason=cancelled`);
  } catch (err) {
    console.error('Payment cancel error:', err);
    res.redirect(`${BASE_URL}/payment-fail.html?reason=server_error`);
  }
});

// SSLCommerz's server-to-server notification.
router.post('/payment/ipn', async (req, res) => {
  try {
    const outcome = await confirmSslcommerzPayment((req.body || {}).tran_id, (req.body || {}).val_id, req);
    res.status(200).send(outcome.result === 'invalid' ? 'IPN ignored' : 'IPN received');
  } catch (err) {
    console.error('IPN error:', err);
    res.status(200).send('IPN error');
  }
});

// Each gateway sends the customer's browser back here (GET).

// PayPal returns with ?token=<PayPal order id>. Money is captured only now, and only for an order still
// awaiting payment, so a cancelled or expired order is never charged.
router.get('/payment/paypal-return', async (req, res) => {
  try {
    const token = req.query.token;
    if (typeof token !== 'string' || !token) return res.redirect(`${BASE_URL}/payment-fail.html?reason=invalid_status`);
    if (!intl.isConfigured('paypal')) return res.redirect(`${BASE_URL}/payment-fail.html?reason=server_error`);

    const order = await Order.findOne({ gatewayRef: token, paymentGateway: 'paypal' });
    if (!order) return res.redirect(`${BASE_URL}/payment-fail.html?reason=validation_failed`);
    if (order.status === 'CANCELLED') return res.redirect(`${BASE_URL}/payment-fail.html?reason=cancelled`);
    if (order.status !== 'PENDING') return sendOutcome(res, { result: 'already', order }, order.transactionId);

    const captured = await intl.paypalCapture(token);
    const outcome = await settleIntlPayment('paypal', order.transactionId, captured, req);
    return sendOutcome(res, outcome, order.transactionId);
  } catch (err) {
    console.error('PayPal return error:', err.message);
    res.redirect(`${BASE_URL}/payment-fail.html?reason=server_error`);
  }
});

// PayPal calls this when a customer approves the payment but never comes back to the shop. Set
// PAYPAL_WEBHOOK_ID to the id of a webhook for CHECKOUT.ORDER.APPROVED and PAYMENT.CAPTURE.COMPLETED.
router.post('/payment/paypal-webhook', async (req, res) => {
  try {
    if (!String(process.env.PAYPAL_WEBHOOK_ID || '').trim() || !intl.isConfigured('paypal')) {
      return res.status(400).send('PayPal webhook not configured.');
    }
    const event = req.body || {};
    if (!(await intl.paypalVerifyWebhook((name) => req.get(name), event))) return res.status(400).send('Not allowed');

    const resource = event.resource || {};
    const related = resource.supplementary_data && resource.supplementary_data.related_ids;
    const ref = event.event_type === 'CHECKOUT.ORDER.APPROVED' ? resource.id
      : event.event_type === 'PAYMENT.CAPTURE.COMPLETED' ? (related && related.order_id) : null;
    if (typeof ref === 'string' && ref) {
      const order = await Order.findOne({ gatewayRef: ref, paymentGateway: 'paypal' });
      if (order && order.status === 'PENDING') {
        const captured = await intl.paypalCapture(ref);
        await settleIntlPayment('paypal', order.transactionId, captured, req);
      }
    }
    res.status(200).send('ok');
  } catch (err) {
    console.error('PayPal webhook error:', err.message);
    res.status(500).send('error');
  }
});

// Flutterwave returns ?status=...&tx_ref=...&transaction_id=...
router.get('/payment/flutterwave-return', async (req, res) => {
  try {
    const { status, tx_ref: txRef, transaction_id: flwId } = req.query;
    if (typeof txRef !== 'string' || !txRef) return res.redirect(`${BASE_URL}/payment-fail.html?reason=invalid_status`);
    if (!intl.isConfigured('flutterwave')) return res.redirect(`${BASE_URL}/payment-fail.html?reason=server_error`);

    if (status === 'cancelled' || status === 'failed') {
      // The status in the URL comes from the browser, so it is not trusted.
      if (typeof flwId === 'string' && /^\d+$/.test(flwId)) {
        let verified = null;
        try { verified = await intl.flutterwaveVerify(flwId); } catch (err) { verified = null; }
        if (verified && verified.paid && verified.txRef === txRef) {
          return sendOutcome(res, await settleIntlPayment('flutterwave', txRef, verified, req), txRef);
        }
      }
      const cancelled = await cancelPendingOrder({ transactionId: txRef, paymentGateway: 'flutterwave' });
      if (cancelled) emitEvent(req, 'productUpdate');
      return res.redirect(`${BASE_URL}/payment-fail.html?reason=${status === 'failed' ? 'payment_failed' : 'cancelled'}`);
    }

    const order = await Order.findOne({ transactionId: txRef, paymentGateway: 'flutterwave' });
    if (!order) return res.redirect(`${BASE_URL}/payment-fail.html?reason=validation_failed`);
    if (order.status !== 'PENDING' && order.status !== 'CANCELLED') return sendOutcome(res, { result: 'already', order }, txRef);

    const verified = await intl.flutterwaveVerify(typeof flwId === 'string' ? flwId : '');
    // The transaction must belong to this order.
    if (verified.paid && verified.txRef !== txRef) {
      return res.redirect(`${BASE_URL}/payment-fail.html?reason=validation_failed`);
    }
    const outcome = await settleIntlPayment('flutterwave', txRef, verified, req);
    if (outcome.result === 'invalid' && order.status === 'CANCELLED') {
      return res.redirect(`${BASE_URL}/payment-fail.html?reason=cancelled`);
    }
    return sendOutcome(res, outcome, txRef);
  } catch (err) {
    console.error('Flutterwave return error:', err.message);
    res.redirect(`${BASE_URL}/payment-fail.html?reason=server_error`);
  }
});

// Mollie returns to the same URL whether or not they paid, so the payment is looked up.
router.get('/payment/mollie-return', async (req, res) => {
  try {
    const tranId = req.query.tran_id;
    if (typeof tranId !== 'string' || !tranId) return res.redirect(`${BASE_URL}/payment-fail.html?reason=invalid_status`);
    if (!intl.isConfigured('mollie')) return res.redirect(`${BASE_URL}/payment-fail.html?reason=server_error`);

    const order = await Order.findOne({ transactionId: tranId, paymentGateway: 'mollie' });
    if (!order || !order.gatewayRef) return res.redirect(`${BASE_URL}/payment-fail.html?reason=validation_failed`);
    if (order.status !== 'PENDING' && order.status !== 'CANCELLED') return sendOutcome(res, { result: 'already', order }, tranId);

    const payment = await intl.mollieGet(order.gatewayRef);
    if (payment.paid) {
      return sendOutcome(res, await settleIntlPayment('mollie', tranId, payment, req), tranId);
    }
    if (['canceled', 'failed', 'expired'].includes(payment.status)) {
      const cancelled = await cancelPendingOrder({ transactionId: tranId, paymentGateway: 'mollie' });
      if (cancelled) emitEvent(req, 'productUpdate');
      return res.redirect(`${BASE_URL}/payment-fail.html?reason=${payment.status === 'failed' ? 'payment_failed' : 'cancelled'}`);
    }
    // Still open or pending: not paid (yet). The webhook confirms it if it is paid later.
    return res.redirect(`${BASE_URL}/payment-fail.html?reason=${order.status === 'CANCELLED' ? 'cancelled' : 'validation_failed'}`);
  } catch (err) {
    console.error('Mollie return error:', err.message);
    res.redirect(`${BASE_URL}/payment-fail.html?reason=server_error`);
  }
});

// Confirm the order even if the customer closes the browser; they act only on what the gateway reports.

// Mollie posts id=tr_xxxx. Mollie asks for a 200 answer; anything else is retried.
router.post('/payment/mollie-webhook', async (req, res) => {
  try {
    const id = (req.body || {}).id;
    if (typeof id === 'string' && intl.isConfigured('mollie')) {
      const order = await Order.findOne({ gatewayRef: id, paymentGateway: 'mollie' });
      if (order) {
        const payment = await intl.mollieGet(id);
        if (payment.paid) {
          await settleIntlPayment('mollie', order.transactionId, payment, req);
        } else if (['canceled', 'failed', 'expired'].includes(payment.status)) {
          const cancelled = await cancelPendingOrder({ transactionId: order.transactionId, paymentGateway: 'mollie' });
          if (cancelled) emitEvent(req, 'productUpdate');
        }
      }
    }
    res.status(200).send('ok');
  } catch (err) {
    console.error('Mollie webhook error:', err.message);
    res.status(500).send('error');
  }
});

// Flutterwave posts an event with a "verif-hash" header equal to FLUTTERWAVE_WEBHOOK_HASH (set in its dashboard).
router.post('/payment/flutterwave-webhook', async (req, res) => {
  try {
    if (!intl.flutterwaveWebhookAllowed(req.get('verif-hash'))) return res.status(401).send('Not allowed');
    const data = (req.body || {}).data;
    if (data && (typeof data.id === 'number' || typeof data.id === 'string') && intl.isConfigured('flutterwave')) {
      const verified = await intl.flutterwaveVerify(String(data.id));
      if (verified.paid && verified.txRef) {
        await settleIntlPayment('flutterwave', verified.txRef, verified, req);
      }
    }
    res.status(200).send('ok');
  } catch (err) {
    console.error('Flutterwave webhook error:', err.message);
    res.status(500).send('error');
  }
});

// Needs the raw body for the signature check, so server.js mounts it before the JSON parser.
async function stripeWebhookHandler(req, res) {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(400).send('Stripe webhook not configured.');
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const outcome = await settleStripeSession(event.data.object, req);
      if (outcome.result === 'confirmed') {
        console.log(`Stripe webhook confirmed order ${outcome.order.transactionId}`);
      }
    }
  } catch (err) {
    // A 500 makes Stripe retry the webhook later.
    console.error('Stripe webhook error:', err.message);
    return res.status(500).send('Webhook handling failed.');
  }
  res.json({ received: true });
}

// A manual-payment customer reports their transfer. The order's transaction ID must be sent too.
router.post('/orders/:id/payment-reference', sameOrigin, paymentReferenceLimiter, async (req, res) => {
  try {
    if (!OBJECT_ID_PATTERN.test(req.params.id)) {
      return res.status(404).json({ message: 'Order not found or cannot attach payment reference.' });
    }
    const { paymentReference, transactionId } = req.body || {};
    if (typeof paymentReference !== 'string' || !paymentReference.trim()) {
      return res.status(400).json({ message: 'Payment reference is required.' });
    }
    if (typeof transactionId !== 'string' || !transactionId) {
      return res.status(400).json({ message: 'Transaction ID is required.' });
    }
    const ref = paymentReference.trim().slice(0, 60);
    // A reference is never refused: someone could copy a stranger's real reference to block them.
    const before = await Order.findOneAndUpdate(
      { _id: req.params.id, transactionId, paymentGateway: 'manual', status: 'PLACED' },
      { paymentReference: ref }
    );
    if (!before) return res.status(404).json({ message: 'Order not found or cannot attach payment reference.' });
    await refreshReferenceFlag(Order, ref);
    if (before.paymentReference && before.paymentReference !== ref) await refreshReferenceFlag(Order, before.paymentReference);
    emitEvent(req, 'orderUpdate');
    res.json({ ok: true, paymentReference: ref });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update payment reference.' });
  }
});

// Feeds the payment-success page. The transaction id is a long random value only the customer has, and only non-personal facts are returned.
router.get('/payment/status', async (req, res) => {
  const tranId = req.query.tran_id;
  if (typeof tranId !== 'string' || !tranId || tranId.length > 80) {
    return res.status(404).json({ found: false });
  }
  try {
    const order = await Order.findOne({ transactionId: tranId })
      .select('status paymentGateway totalAmount paidAt paymentIssue')
      .lean();
    if (!order) return res.status(404).json({ found: false });
    res.json({
      found: true,
      status: order.status,
      gateway: order.paymentGateway,
      amount: order.totalAmount,
      paid: !!order.paidAt,
      underReview: order.paymentIssue === 'PAYMENT_UNCONFIRMED'
    });
  } catch (err) {
    res.status(500).json({ found: false });
  }
});

module.exports = router;
module.exports.stripeWebhookHandler = stripeWebhookHandler;
module.exports.paymentCallbackLimiter = paymentCallbackLimiter;
module.exports.settlePaidOrder = settlePaidOrder;
module.exports.recordLatePayment = recordLatePayment;
module.exports.settleStripeSession = settleStripeSession;
module.exports.settleIntlPayment = settleIntlPayment;
module.exports.SIZES = SIZES;
module.exports.ORDER_PAYMENT_METHODS = ORDER_PAYMENT_METHODS;
module.exports.CLIENT_REQUEST_ID_PATTERN = CLIENT_REQUEST_ID_PATTERN;
module.exports.takeChatBudget = takeChatBudget;
module.exports.refundChatBudget = refundChatBudget;
module.exports.paymentReferenceLimiter = paymentReferenceLimiter;

