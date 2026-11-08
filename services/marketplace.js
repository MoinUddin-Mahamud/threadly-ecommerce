'use strict';

// Marketplace (multi-vendor) rules. Switched on with MULTIVENDOR_ENABLED=true.

const Vendor = require('../models/Vendor');
const Order = require('../models/Order');
const Payout = require('../models/Payout');
const crypto = require('crypto');
const { toMinor, fromMinor } = require('./money');

const enabled = (env = process.env) => String(env.MULTIVENDOR_ENABLED || '').trim().toLowerCase() === 'true';

function defaultCommission(env = process.env) {
  const n = Number(String(env.MARKETPLACE_COMMISSION_PERCENT === undefined ? '10' : env.MARKETPLACE_COMMISSION_PERCENT).trim());
  return Number.isFinite(n) && n >= 0 && n <= 90 ? n : 10;
}

// "Urban Loom!" becomes "urban-loom". A name with no Latin letters gets "shop-" and 6 random hex
// characters, so shops named in Bengali, Arabic or Hindi do not all compete for one address.
function slugify(name) {
  return String(name || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || `shop-${crypto.randomBytes(3).toString('hex')}`;
}

const idOf = (v) => (v === undefined || v === null ? '' : String(v));

const flag = (value) => String(value || '').trim().toLowerCase() === 'true';
// A seller who already shipped keeps their earnings when the whole order is cancelled. OFF by
// default.
const keepsShippedOnCancel = (env = process.env) => flag(env.SELLER_KEEPS_SHIPPED_ON_CANCEL);
// MARKETPLACE_FUNDS_COUPONS=true: the marketplace pays for coupons (the standard rule, set explicitly). Wins over
// the split.
const fundsCoupons = (env = process.env) => flag(env.MARKETPLACE_FUNDS_COUPONS);
// A coupon is split over the item lines and sellers earn on the price after their share. OFF by
// default.
const couponSplitProRata = (env = process.env) => flag(env.COUPON_SPLIT_PRO_RATA) && !fundsCoupons(env);

// Splits a coupon discount over order lines pro rata, in whole minor units.
function splitDiscount(lines, discountMinor) {
  const total = lines.reduce((a, b) => a + b, 0);
  const D = Math.max(0, Math.min(Math.round(discountMinor) || 0, total));
  if (!lines.length || total <= 0 || D === 0) return lines.map(() => 0);
  const shares = lines.map((l) => Math.floor(D * l / total));
  let rest = D - shares.reduce((a, b) => a + b, 0);
  for (let i = lines.length - 1; i >= 0 && rest > 0; i--) {
    const room = lines[i] - shares[i];
    const add = Math.min(room, rest);
    shares[i] += add; rest -= add;
  }
  return shares;
}

// The price of one order line after its stored share of a coupon (absent on older orders and on
// orders placed while the marketplace funds coupons: the full price).
const lineMinor = (item) => Math.max(0, toMinor(item.price) * item.quantity - (Number.isInteger(item.discountMinor) ? item.discountMinor : 0));

// The filter for the products a visitor may see: the store's own, plus those of approved vendors
// when the marketplace is on. Used before paging, so a page is full and "has more" is right.
async function visibleFilter() {
  if (!enabled()) return { vendorId: null };
  const approved = await Vendor.find({ status: 'approved' }).select('_id').lean();
  return { vendorId: { $in: [null, ...approved.map((v) => v._id)] } };
}

// Keeps the products a visitor may see and adds `vendor` ({ name, slug }) to the ones sold by a
// vendor.
async function visibleProducts(products) {
  const ids = [...new Set(products.map((p) => idOf(p.vendorId)).filter(Boolean))];
  let byId = new Map();
  if (ids.length && enabled()) {
    const vendors = await Vendor.find({ _id: { $in: ids }, status: 'approved' }).select('name slug').lean();
    byId = new Map(vendors.map((v) => [String(v._id), v]));
  }
  const out = [];
  for (const product of products) {
    const vid = idOf(product.vendorId);
    if (!vid) { out.push({ product, vendor: null }); continue; }
    const vendor = byId.get(vid);
    if (vendor) out.push({ product, vendor: { name: vendor.name, slug: vendor.slug } });
  }
  return out;
}

// The approved vendor of one product, null for the store's own, or false when
// the product may not be shown / bought.
async function sellerOf(product) {
  if (!product || !product.vendorId) return product ? null : false;
  if (!enabled()) return false;
  const vendor = await Vendor.findOne({ _id: product.vendorId, status: 'approved' }).select('name slug commissionPercent ownerUserId').lean();
  return vendor || false;
}

// What one vendor earns from one order, in minor. Works item by item so each
// item uses the commission that applied when it was ordered.
function vendorShare(order, vendorId) {
  const vid = idOf(vendorId);
  let gross = 0;
  let commission = 0;
  for (const item of order.items || []) {
    if (idOf(item.vendorId) !== vid) continue;
    const line = lineMinor(item);
    gross += line;
    commission += Math.round(line * (Number(item.commissionPercent) || 0) / 100);
  }
  return { gross, commission, net: gross - commission };
}

// Paid orders, cancelled or not. Cancelled ones only matter when the vendor was
// already paid for them (a clawback, see below).
const PAID_FILTER = { paidAt: { $ne: null } };
// An order counts as revenue once it has been paid and has not been cancelled. The dashboard,
// the revenue endpoint and the orders table share it so they agree.
const REVENUE_FILTER = { paidAt: { $ne: null }, status: { $ne: 'CANCELLED' } };
const MAX_PAYOUT_ORDERS = 2000;  // orders in one payout record (keeps it far below the 16 MB limit)
const SCAN_BATCH = 500;          // orders read per round trip: memory stays flat however many orders
const DISPLAY_LINES = 200;       // newest order lines sent to the screen
const DISPLAY_PAYOUTS = 50;

// Sellers whose part of an order had already been SHIPPED or DELIVERED.
function shippedVendorIds(order) {
  return (order.fulfillment || [])
    .filter((f) => f && (f.status === 'SHIPPED' || f.status === 'DELIVERED'))
    .map((f) => idOf(f.vendorId));
}
const isKeptFor = (order, vendorId) => (order.keptVendorIds || []).some((k) => idOf(k) === idOf(vendorId));

function isDeliveredFor(order, vendorId) {
  if (!order.fulfillment || order.fulfillment.length === 0) return order.status === 'DELIVERED';
  const f = order.fulfillment.find((x) => idOf(x.vendorId) === idOf(vendorId));
  return !!f && f.status === 'DELIVERED';
}

// A seller marks their own part delivered, so earnings are not payable the same minute:
// PAYOUT_HOLD_DAYS (0 to 90, default 7) sets how many days to wait.
const DEFAULT_PAYOUT_HOLD_DAYS = 7;
function payoutHoldDays(env = process.env) {
  const n = parseInt(env.PAYOUT_HOLD_DAYS, 10);
  return Number.isFinite(n) ? Math.min(90, Math.max(0, n)) : DEFAULT_PAYOUT_HOLD_DAYS;
}

// When this seller's part was recorded as delivered (null if not delivered).
function deliveredAt(order, vendorId) {
  if (!isDeliveredFor(order, vendorId)) return null;
  const f = (order.fulfillment || []).find((x) => idOf(x.vendorId) === idOf(vendorId));
  const when = f && f.updatedAt ? f.updatedAt : order.updatedAt;
  return when ? new Date(when) : null;
}

function isPayableNow(order, vendorId, now = Date.now(), env = process.env) {
  if (!isDeliveredFor(order, vendorId)) return false;
  const hold = payoutHoldDays(env);
  if (hold === 0) return true;          // no hold: delivered means payable, even if no timestamp was recorded
  const since = deliveredAt(order, vendorId);
  if (!since) return false;             // a hold needs a delivery time to count from
  return now - since.getTime() >= hold * 24 * 60 * 60 * 1000;
}

// Walks through EVERY paid order that contains this vendor's items, newest first, one batch at a
// time, and calls onLine(line) for each.
async function scanOrders(vendorId, onLine) {
  let before = null;
  for (;;) {
    const query = { 'items.vendorId': vendorId, ...PAID_FILTER, ...(before ? { _id: { $lt: before } } : {}) };
    const orders = await Order.find(query).select('items status fulfillment keptVendorIds createdAt updatedAt paidAt').sort({ _id: -1 }).limit(SCAN_BATCH).lean();
    if (!orders.length) return;

    const ids = orders.map((o) => o._id);
    const [paidRows, settledRows] = await Promise.all([
      Payout.find({ vendorId, orderIds: { $in: ids } }).select('orderIds').lean(),
      Payout.find({ vendorId, clawbackOrderIds: { $in: ids } }).select('clawbackOrderIds').lean()
    ]);
    const paidOutCount = {};
    for (const row of paidRows) {
      for (const id of row.orderIds || []) {
        paidOutCount[id] = (paidOutCount[id] || 0) + 1;
      }
    }
    const settledCount = {};
    for (const row of settledRows) {
      for (const id of row.clawbackOrderIds || []) {
        settledCount[id] = (settledCount[id] || 0) + 1;
      }
    }

    for (const order of orders) {
      const id = String(order._id);
      const share = vendorShare(order, vendorId);
      const netPaidCount = (paidOutCount[id] || 0) - (settledCount[id] || 0);
      // A seller who kept their earnings on a cancelled order (keptVendorIds is only ever written
      // while SELLER_KEEPS_SHIPPED_ON_CANCEL is on) is treated like any other seller with a paid,
      // delivered part.
      const kept = order.status === 'CANCELLED' && isKeptFor(order, vendorId);
      let state;
      if (order.status === 'CANCELLED' && !kept) {
        if (netPaidCount <= 0) continue;
        state = 'clawback';
      } else {
        state = netPaidCount > 0 ? 'paid' : (kept || isPayableNow(order, vendorId)) ? 'payable' : 'pending';
      }
      await onLine({ orderId: id, createdAt: order.createdAt, ...share, state, paidOutCount: paidOutCount[id] || 0, settledCount: settledCount[id] || 0 });
    }
    if (orders.length < SCAN_BATCH) return;
    before = orders[orders.length - 1]._id;
  }
}

// Everything a vendor has earned: sales, commission, what is already paid out, what can be paid
// out now (delivered) and what is still on its way.
async function earningsFor(vendorId, { maxLines = DISPLAY_LINES } = {}) {
  const t = { gross: 0, commission: 0, net: 0, paidOut: 0, payable: 0, pending: 0, clawback: 0 };
  const lines = [];
  let lineCount = 0;
  await scanOrders(vendorId, (l) => {
    lineCount++;
    if (l.state === 'clawback') t.clawback += l.net;
    else {
      t.gross += l.gross; t.commission += l.commission; t.net += l.net;
      if (l.state === 'paid') t.paidOut += l.net; else if (l.state === 'payable') t.payable += l.net; else t.pending += l.net;
    }
    if (lines.length < maxLines) lines.push({ orderId: l.orderId, createdAt: l.createdAt, gross: fromMinor(l.gross), commission: fromMinor(l.commission), net: fromMinor(l.state === 'clawback' ? -l.net : l.net), state: l.state });
  });
  t.payableNow = Math.max(0, t.payable - t.clawback);

  const payouts = await Payout.find({ vendorId }).select('orderIds amount createdAt note').sort({ createdAt: -1 }).limit(DISPLAY_PAYOUTS).lean();
  return {
    totals: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, fromMinor(v)])),
    lines, linesShown: lines.length, linesTotal: lineCount,
    payouts: payouts.map((p) => ({ id: String(p._id), amount: p.amount, orders: (p.orderIds || []).length, note: p.note, createdAt: p.createdAt }))
  };
}

// What a payout would pay right now: every delivered, unpaid order, minus the clawbacks owed
// (those are settled by this payout).
async function payoutPlan(vendorId) {
  const payable = [];
  const clawbacks = [];
  await scanOrders(vendorId, (l) => {
    if (l.state === 'payable') payable.push(l);
    else if (l.state === 'clawback') clawbacks.push(l);
  });
  const payableMinor = payable.reduce((a, l) => a + l.net, 0);
  const clawbackMinor = clawbacks.reduce((a, l) => a + l.net, 0);
  return { payable, clawbacks, payableMinor, clawbackMinor, amountMinor: payableMinor - clawbackMinor };
}

// The whole-order status the sellers' own progress implies: SHIPPED when every seller has shipped,
// DELIVERED when every seller has delivered, otherwise null.
function derivedStatus(order) {
  const f = order.fulfillment || [];
  if (!f.length) return null;
  if ((order.items || []).some((i) => !i.vendorId)) return null;
  if (f.every((x) => x.status === 'DELIVERED')) return 'DELIVERED';
  if (f.every((x) => x.status !== 'PENDING')) return 'SHIPPED';
  return null;
}

// What the sellers earn from a list of order items, in minor (same per-line rounding as
// vendorShare / payouts).
function vendorNetOfItems(items) {
  let net = 0;
  for (const item of items || []) {
    if (!item.vendorId) continue;
    const line = lineMinor(item);
    net += line - Math.round(line * (Number(item.commissionPercent) || 0) / 100);
  }
  return net;
}

// A coupon must never make the marketplace pay sellers more than the customer paid: sellers always
// earn price minus commission.
function wouldLoseMoney(items, totalMinor) {
  return vendorNetOfItems(items) > totalMinor;
}

// The marketplace's money split over every paid, not cancelled order.
async function revenueBreakdown() {
  let gross = 0, commission = 0, vendorNet = 0, shipping = 0, discounts = 0;
  let before = null;
  for (;;) {
    const query = { ...REVENUE_FILTER, ...(before ? { _id: { $lt: before } } : {}) };
    const orders = await Order.find(query).select('items totalAmount shippingAmount discountAmount').sort({ _id: -1 }).limit(SCAN_BATCH).lean();
    if (!orders.length) break;
    for (const o of orders) {
      gross += toMinor(o.totalAmount || 0);
      shipping += toMinor(o.shippingAmount || 0);
      discounts += toMinor(o.discountAmount || 0);
      for (const item of o.items || []) {
        if (!item.vendorId) continue;
        const line = lineMinor(item);
        const c = Math.round(line * (Number(item.commissionPercent) || 0) / 100);
        commission += c; vendorNet += line - c;
      }
    }
    if (orders.length < SCAN_BATCH) break;
    before = orders[orders.length - 1]._id;
  }
  // Sellers who keep their earnings on a cancelled order are paid by the store while the customer
  // is refunded: that is a cost, so it is taken off the store revenue.
  let keptCost = 0;
  let keptBefore = null;
  for (;;) {
    const keptQuery = { paidAt: { $ne: null }, status: 'CANCELLED', 'keptVendorIds.0': { $exists: true }, ...(keptBefore ? { _id: { $lt: keptBefore } } : {}) };
    const kept = await Order.find(keptQuery).select('items keptVendorIds').sort({ _id: -1 }).limit(SCAN_BATCH).lean();
    if (!kept.length) break;
    for (const o of kept) {
      for (const item of o.items || []) {
        if (!item.vendorId || !isKeptFor(o, item.vendorId)) continue;
        const line = lineMinor(item);
        keptCost += line - Math.round(line * (Number(item.commissionPercent) || 0) / 100);
      }
    }
    if (kept.length < SCAN_BATCH) break;
    keptBefore = kept[kept.length - 1]._id;
  }
  return {
    commissionEarned: fromMinor(commission),
    vendorShare: fromMinor(vendorNet),
    keptEarningsCost: fromMinor(keptCost),
    storeRevenue: fromMinor(gross - vendorNet - keptCost),
    shippingCollected: fromMinor(shipping),
    couponDiscounts: fromMinor(discounts)
  };
}

module.exports = { keepsShippedOnCancel, couponSplitProRata, fundsCoupons, splitDiscount, shippedVendorIds, isKeptFor, derivedStatus, vendorNetOfItems, wouldLoseMoney, revenueBreakdown, enabled, defaultCommission, slugify, visibleFilter, visibleProducts, sellerOf, vendorShare, earningsFor, payoutPlan, scanOrders, isDeliveredFor, isPayableNow, payoutHoldDays, REVENUE_FILTER, SCAN_BATCH, MAX_PAYOUT_ORDERS };
