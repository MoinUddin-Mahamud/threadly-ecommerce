const Order = require('../models/Order');
const Product = require('../models/Product');
const { releaseCoupon, reclaimCoupon, normalizeCustomerKey } = require('./couponService');
const marketplace = require('./marketplace');
const { sizeKey } = require('./sizes');
const { codSettings } = require('./cod');
const { manualSettings } = require('./paymentConfig');
const { sendCodExpiredNotification } = require('./emailService');

// How long an unpaid (PENDING) order keeps its stock reserved before it is
// cancelled and the stock is released. Stripe Checkout sessions cannot expire
// sooner than 30 minutes, so that is the minimum here.
const PENDING_ORDER_TTL_MINUTES = Math.min(
  1380,
  Math.max(30, parseInt(process.env.PENDING_ORDER_TTL_MINUTES, 10) || 60)
);

// Extra time after the TTL before an unpaid order is cancelled: a Stripe session stays payable for
// TTL + 2 minutes and the cleanup job runs every few minutes.
const PENDING_ORDER_GRACE_MINUTES = 10;

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const idStr = (v) => (v === undefined || v === null ? '' : String(v));

// Cancelling an order in one of these statuses returns its stock: the goods have not left the shop.
// SHIPPED and DELIVERED orders keep their stock deducted.
const RESTOCK_ON_CANCEL = ['PENDING', 'PLACED', 'CONFIRMED'];

// The key a customer's coupon uses are counted under (their normalized email).
function customerKeyOf(order) {
  return order && order.customerEmail ? normalizeCustomerKey(order.customerEmail) : null;
}

async function restockItems(items) {
  for (const item of items) {
    // A line bought from a product that kept stock per size goes back to that size (and to the total).
    // If the product no longer keeps stock per size, the units go back to the one stock number.
    if (item.sizeTracked && item.size) {
      const key = sizeKey(item.size);
      const back = await Product.updateOne(
        { _id: item.productId, sizeStock: { $exists: true } },
        { $inc: { [`sizeStock.${key}`]: item.quantity, stock: item.quantity } }
      );
      if (back && (back.matchedCount > 0 || back.modifiedCount > 0)) continue;
    }
    await Product.updateOne({ _id: item.productId }, { $inc: { stock: item.quantity } });
  }
}

// Gives back the coupon use an order was holding. Called together with every
// restock, so a coupon use is returned exactly when the stock is. It never
// throws: the order is already cancelled and its stock is already back.
async function releaseOrderCoupon(order) {
  if (!order || !order.couponId) return;
  try {
    // The per-customer count is keyed by the customer's email (see applyCoupon).
    await releaseCoupon(order.couponId, customerKeyOf(order));
  } catch (err) {
    console.error(`Could not release coupon use for order ${order._id}:`, err.message);
  }
}

// Takes stock per line with one conditional update each, so the last unit cannot be sold twice. If
// a line falls short, what was taken is put back.
async function reserveItems(items, taken = []) {
  for (const line of items) {
    // Per-size products take the units from the chosen size and from the total in one conditional
    // update.
    const sized = line.sizeTracked && line.size;
    const updated = sized
      ? await Product.findOneAndUpdate(
        { _id: line.productId, [`sizeStock.${sizeKey(line.size)}`]: { $gte: line.quantity } },
        { $inc: { [`sizeStock.${sizeKey(line.size)}`]: -line.quantity, stock: -line.quantity } }
      )
      : await Product.findOneAndUpdate(
        { _id: line.productId, stock: { $gte: line.quantity } },
        { $inc: { stock: -line.quantity } }
      );
    if (!updated) {
      await restockItems(taken.splice(0));
      return { ok: false, title: line.title, line };
    }
    taken.push(line);
  }
  return { ok: true };
}

// Moves a PENDING order to CANCELLED and returns its stock. One conditional update, so concurrent
// callbacks cannot restock twice.
async function cancelPendingOrder(filter) {
  const order = await Order.findOneAndUpdate(
    { ...filter, status: 'PENDING', paymentIssue: { $ne: 'PAYMENT_UNCONFIRMED' } },
    { status: 'CANCELLED', stockReleased: true },
    { returnDocument: 'after' }
  );
  if (order) {
    await restockItems(order.items);
    await releaseOrderCoupon(order);
  }
  return order;
}

// Admin cancellation: cancels an unshipped order and returns its stock once.
async function cancelOrderAndRestock(orderId) {
  const order = await Order.findOneAndUpdate(
    { _id: orderId, status: { $in: RESTOCK_ON_CANCEL }, stockReleased: { $ne: true } },
    { status: 'CANCELLED', stockReleased: true },
    { returnDocument: 'after' }
  );
  if (order) {
    // Read from the order as it was when cancelled (sellers cannot change cancelled orders).
    const shipped = marketplace.shippedVendorIds(order);
    const kept = marketplace.keepsShippedOnCancel() ? shipped : [];
    const marks = {};
    if (kept.length) marks.keptVendorIds = kept;
    if (shipped.length) marks.noRestockVendorIds = shipped;
    if (Object.keys(marks).length) {
      await Order.updateOne({ _id: order._id }, { $set: marks });
      Object.assign(order, marks);
    }
    const items = order.items.filter((i) => !shipped.includes(idStr(i.vendorId)));
    await restockItems(items);
    await releaseOrderCoupon(order);
  }
  return order;
}

// Moves a CANCELLED order back to an active status, taking its stock again first (fails when
// short).
async function reopenCancelledOrder(orderId, newStatus) {
  const current = await Order.findById(orderId);
  if (!current) return { result: 'not_found' };
  if (current.status !== 'CANCELLED') return { result: 'not_cancelled' };

  // Sellers that kept their earnings when the order was cancelled never had their items restocked,
  // so there is nothing to take again for them.
  const keptIds = (current.keptVendorIds || []).map(idStr);
  const skipIds = [...keptIds, ...(current.noRestockVendorIds || []).map(idStr)];   // shipped goods were never restocked
  const reopenItems = current.items.filter((i) => !skipIds.includes(idStr(i.vendorId)));

  const needsStock = current.stockReleased === true;
  if (needsStock) {
    const reserved = await reserveItems(reopenItems);
    if (!reserved.ok) return { result: 'no_stock', title: reserved.title };
  }
  // The coupon use was given back together with the stock, so it is taken again
  // together with it.
  const needsCoupon = needsStock && !!current.couponId;
  if (needsCoupon) {
    let reclaimed;
    try {
      reclaimed = await reclaimCoupon(current.couponId, customerKeyOf(current));
    } catch (err) {
      await restockItems(reopenItems);   // put the stock back; the order stays cancelled
      throw err;
    }
    // The coupon has run out of uses since this order was cancelled.
    if (!reclaimed) {
      await restockItems(reopenItems);
      return { result: 'coupon_unavailable' };
    }
  }

  // A manual-payment order that is reopened straight to CONFIRMED is confirmed by staff,
  // exactly like PLACED to CONFIRMED, so it must count as paid (revenue and seller earnings
  // both depend on paidAt). Orders that were already paid keep their original date.
  const markPaid = newStatus === 'CONFIRMED' && current.paymentGateway === 'manual' && !current.paidAt;
  const order = await Order.findOneAndUpdate(
    { _id: orderId, status: 'CANCELLED', stockReleased: needsStock ? true : { $ne: true } },
    {
      status: newStatus,
      stockReleased: false,
      // Restarts the unconfirmed-order timer: expiry counts from the reopen, not from creation.
      reopenedAt: new Date(),
      ...(markPaid ? { paidAt: new Date() } : {}),
      $unset: skipIds.length ? { paymentIssue: 1, keptVendorIds: 1, noRestockVendorIds: 1 } : { paymentIssue: 1 }
    },
    { returnDocument: 'after', runValidators: true }
  );
  if (!order) {
    if (needsStock) await restockItems(reopenItems);
    if (needsCoupon) await releaseOrderCoupon(current);
    return { result: 'changed' };
  }
  return { result: 'reopened', order };
}

async function expirePendingOrders() {
  const cutoff = new Date(Date.now() - (PENDING_ORDER_TTL_MINUTES + PENDING_ORDER_GRACE_MINUTES) * 60 * 1000);
  // An order whose payment the gateway flagged as risky (PAYMENT_UNCONFIRMED) is waiting for
  // staff, not abandoned.
  const stale = await Order.find({ status: 'PENDING', paymentIssue: { $ne: 'PAYMENT_UNCONFIRMED' }, createdAt: { $lt: cutoff } })
    .select('_id')
    .limit(100)
    .lean();

  let cancelled = 0;
  for (const { _id } of stale) {
    if (await cancelPendingOrder({ _id })) cancelled++;
  }
  return cancelled;
}

// Cancels COD and manual-payment orders nobody confirmed in time, returning stock and coupon use.
async function expireUnconfirmedOrders(gateway, hours, reviewHours = 0) {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
  const reviewCutoff = new Date(Date.now() - (hours + reviewHours) * 60 * 60 * 1000);
  // An order staff reopened (reopenedAt) is timed from that moment, not from when it was first
  // placed.
  const query = {
    paymentGateway: gateway,
    status: 'PLACED',
    createdAt: { $lt: cutoff },
    reopenedAt: { $not: { $gt: cutoff } }
  };
  if (gateway === 'manual') {
    // Oldest first, and orders already flagged and still inside their review window are skipped,
    // so a pile of flagged orders cannot crowd the expired ones out of the batch of 100.
    query.$or = [{ paymentIssue: { $ne: 'PAYMENT_UNCONFIRMED' } }, { createdAt: { $lt: reviewCutoff } }];
  }
  const stale = await Order.find(query).sort({ createdAt: 1 }).limit(100);

  let cancelled = 0;
  for (const order of stale) {
    const hasReference = gateway === 'manual' && !!order.paymentReference;
    const startedAt = order.reopenedAt || order.createdAt;
    const pastReview = !!startedAt && new Date(startedAt) < reviewCutoff;
    if (hasReference && !pastReview) {
      if (order.paymentIssue !== 'PAYMENT_UNCONFIRMED') {
        await Order.updateOne({ _id: order._id }, { $set: { paymentIssue: 'PAYMENT_UNCONFIRMED' } });
      }
      continue;
    }

    const updated = await Order.findOneAndUpdate(
      { _id: order._id, status: 'PLACED' },
      { status: 'CANCELLED', stockReleased: true, ...(hasReference ? { paymentIssue: 'REFUND_DUE' } : {}) },
      { returnDocument: 'after' }
    );
    if (updated) {
      await restockItems(updated.items);
      await releaseOrderCoupon(updated);
      await sendCodExpiredNotification(updated, { hadReference: hasReference }).catch(() => {});
      cancelled++;
    }
  }
  return cancelled;
}

async function expireUnconfirmedCodOrders() {
  return expireUnconfirmedOrders('cod', codSettings().confirmHours);
}

async function expireUnconfirmedManualOrders() {
  const m = manualSettings();
  return expireUnconfirmedOrders('manual', m.hours, m.reviewHours);
}

function startPendingOrderCleanup(io) {
  const run = async () => {
    try {
      const cancelledPending = await expirePendingOrders();
      const cancelledCod = await expireUnconfirmedCodOrders();
      const cancelledManual = await expireUnconfirmedManualOrders();
      if ((cancelledPending > 0 || cancelledCod > 0 || cancelledManual > 0) && io) {
        io.emit('productUpdate');
        io.emit('orderUpdate');
      }
    } catch (err) {
      console.error('Order cleanup failed:', err.message);
    }
  };
  const timer = setInterval(run, CLEANUP_INTERVAL_MS);
  timer.unref();
  run();
  return timer;
}

module.exports = {
  PENDING_ORDER_TTL_MINUTES,
  PENDING_ORDER_GRACE_MINUTES,
  restockItems,
  reserveItems,
  releaseOrderCoupon,
  cancelPendingOrder,
  cancelOrderAndRestock,
  reopenCancelledOrder,
  expirePendingOrders,
  expireUnconfirmedCodOrders,
  expireUnconfirmedManualOrders,
  startPendingOrderCleanup
};

