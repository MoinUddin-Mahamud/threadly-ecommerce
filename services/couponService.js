const Coupon = require('../models/Coupon');
const CouponRedemption = require('../models/CouponRedemption');
const {
  MESSAGE_NOT_VALID, normalizeCode, computeDiscount, checkCoupon, buildClaimFilter
} = require('./coupons');

// Per-customer coupon key: the email, normalised so case, "+tag" suffixes and Gmail dots count as
// one customer.
function normalizeCustomerKey(email) {
  const text = String(email || '').trim().toLowerCase();
  const at = text.lastIndexOf('@');
  if (at < 1) return text || null;
  let local = text.slice(0, at);
  let domain = text.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

// Takes one use of the coupon if, and only if, it can be used on a cart worth
// `subtotal` right now. Resolves to the updated coupon, or null.
async function claimCoupon(code, subtotal, now = new Date()) {
  return Coupon.findOneAndUpdate(
    buildClaimFilter(code, subtotal, now),
    { $inc: { usedCount: 1 } },
    { returnDocument: 'after' }
  );
}

// Gives one use back. Never goes below zero.
async function releaseCoupon(couponId, customerKey = null) {
  if (customerKey) {
    // Not swallowed silently: a failure here leaves the per-customer count too high.
    await CouponRedemption.updateOne(
      { couponId, customerKey, count: { $gt: 0 } },
      { $inc: { count: -1 } }
    ).catch((err) => console.error(`Could not release per-customer coupon count (${couponId}):`, err.message));
  }
  return Coupon.updateOne({ _id: couponId, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } });
}

// Takes a use again for an order that is being reopened. The total usage limit
// is still respected (the expiry date is not: the order was placed in time).
// Resolves to the updated coupon, or null when the coupon has no uses left.
async function reclaimCoupon(couponId, customerKey = null) {
  const coupon = await Coupon.findOneAndUpdate(
    {
      _id: couponId,
      $or: [{ usageLimit: null }, { usageLimit: { $exists: false } }, { $expr: { $lt: ['$usedCount', '$usageLimit'] } }]
    },
    { $inc: { usedCount: 1 } },
    { returnDocument: 'after' }
  );
  if (!coupon) return null;
  if (customerKey) {
    await CouponRedemption.updateOne(
      { couponId, customerKey },
      { $inc: { count: 1 } },
      { upsert: true }
    ).catch((err) => console.error(`Could not record per-customer coupon count (${couponId}):`, err.message));
  }
  return coupon;
}

// For order creation: validates the typed code against a cart worth `subtotal`
// and takes one use.
async function applyCoupon(rawCode, subtotal, now = new Date(), customerKey = null) {
  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, message: MESSAGE_NOT_VALID };

  // The per-customer limit is checked before the global use is claimed.
  if (customerKey) {
    const preCheckCoupon = await Coupon.findOne({ code });
    if (preCheckCoupon && preCheckCoupon.perCustomerLimit != null) {
      const redemption = await CouponRedemption.findOne({ couponId: preCheckCoupon._id, customerKey });
      if (redemption && redemption.count >= preCheckCoupon.perCustomerLimit) {
        return { ok: false, message: MESSAGE_NOT_VALID };
      }
    }
  }

  const coupon = await claimCoupon(code, subtotal, now);
  if (!coupon) {
    return { ok: false, message: MESSAGE_NOT_VALID };
  }

  // Enforce per-customer limit atomically after global claim
  if (customerKey && coupon.perCustomerLimit != null) {
    const redemption = await CouponRedemption.findOneAndUpdate(
      { couponId: coupon._id, customerKey, count: { $lt: coupon.perCustomerLimit } },
      { $inc: { count: 1 } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    ).catch(() => null);

    if (!redemption || redemption.count > coupon.perCustomerLimit) {
      await releaseCoupon(coupon._id);
      return { ok: false, message: MESSAGE_NOT_VALID };
    }
  }

  const discount = computeDiscount(coupon, subtotal);
  if (discount <= 0) {
    await releaseCoupon(coupon._id, customerKey);
    return { ok: false, message: MESSAGE_NOT_VALID };
  }
  return { ok: true, coupon, discount };
}

// For the cart box: the same checks without using the coupon up.
async function previewCoupon(rawCode, subtotal, now = new Date(), customerKey = null) {
  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, message: MESSAGE_NOT_VALID };
  const coupon = await Coupon.findOne({ code });
  if (!coupon) return { ok: false, message: MESSAGE_NOT_VALID };

  if (customerKey && coupon.perCustomerLimit != null) {
    const redemption = await CouponRedemption.findOne({ couponId: coupon._id, customerKey });
    if (redemption && redemption.count >= coupon.perCustomerLimit) {
      return { ok: false, message: MESSAGE_NOT_VALID };
    }
  }

  const check = checkCoupon(coupon, subtotal, now);
  return check.ok ? { ok: true, code, discount: check.discount } : { ok: false, message: MESSAGE_NOT_VALID };
}

module.exports = { claimCoupon, releaseCoupon, reclaimCoupon, applyCoupon, previewCoupon, normalizeCustomerKey };

