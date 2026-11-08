const { toMinor, fromMinor, percentOf, compareMoney, minOrderMinor, decimalsOf, isPlainAmount, decimalsRule } = require('./money');

const LIMITS = {
  codeMin: 3,
  codeMax: 32,
  amountMax: 10_000_000,     // same ceiling as a product price
  usageLimitMax: 1_000_000
};

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]*$/;
const MESSAGE_NOT_VALID = 'This coupon code is not valid.';

const round2 = (n) => fromMinor(toMinor(n));

// Turns what a person typed into the stored form (trimmed, upper case), or
// returns '' when it can not be a coupon code at all.
function normalizeCode(raw) {
  if (typeof raw !== 'string') return '';
  const code = raw.trim().toUpperCase();
  if (code.length < LIMITS.codeMin || code.length > LIMITS.codeMax) return '';
  return CODE_PATTERN.test(code) ? code : '';
}

// What the coupon takes off a cart worth `subtotal`: percent (value%, capped by maxDiscount) or
// fixed (value).
function computeDiscount(coupon, subtotal) {
  const subtotalMinor = toMinor(subtotal);
  if (!coupon || subtotalMinor <= 0) return 0;
  
  let discountMinor = 0;
  if (coupon.type === 'percent') {
    const pctDiscount = percentOf(subtotal, coupon.value);
    discountMinor = toMinor(pctDiscount);
    if (coupon.maxDiscount != null && Number(coupon.maxDiscount) > 0) {
      const maxMinor = toMinor(coupon.maxDiscount);
      discountMinor = Math.min(discountMinor, maxMinor);
    }
  } else if (coupon.type === 'fixed') {
    discountMinor = toMinor(coupon.value);
  }

  // A discount never takes the payable total below MIN_ORDER_TOTAL (default 0, and never below one
  // minor unit: a free order is refused).
  const maxAllowedDiscountMinor = Math.max(0, subtotalMinor - minOrderMinor());
  discountMinor = Math.min(discountMinor, maxAllowedDiscountMinor);
  return fromMinor(Math.max(0, discountMinor));
}

const time = (d) => (d == null ? null : new Date(d).getTime());

// 'active' | 'disabled' | 'scheduled' | 'expired' | 'used_up'
function couponStatus(coupon, now = new Date()) {
  if (!coupon || coupon.active === false) return 'disabled';
  const at = time(now);
  if (coupon.startsAt != null && at < time(coupon.startsAt)) return 'scheduled';
  if (coupon.endsAt != null && at > time(coupon.endsAt)) return 'expired';
  if (coupon.usageLimit != null && Number(coupon.usedCount || 0) >= Number(coupon.usageLimit)) return 'used_up';
  return 'active';
}

// Read-only coupon check (null when not found).
function checkCoupon(coupon, subtotal, now = new Date()) {
  const status = couponStatus(coupon, now);
  if (status !== 'active') return { ok: false, message: MESSAGE_NOT_VALID };
  if (coupon.minOrderAmount != null && compareMoney(subtotal, coupon.minOrderAmount) < 0) {
    return { ok: false, message: MESSAGE_NOT_VALID };
  }
  const discount = computeDiscount(coupon, subtotal);
  if (discount <= 0) return { ok: false, message: MESSAGE_NOT_VALID };
  return { ok: true, discount };
}

// The database filter that claims one use of a coupon.
function buildClaimFilter(code, subtotal, now = new Date()) {
  return {
    code,
    active: true,
    $and: [
      { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
      { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] },
      { $or: [{ usageLimit: null }, { $expr: { $lt: ['$usedCount', '$usageLimit'] } }] },
      { $or: [{ minOrderAmount: null }, { minOrderAmount: { $lte: subtotal } }] }
    ]
  };
}

// A coupon figure as a number, or NaN. A percentage has up to 2 decimals whatever the currency; a
// money amount has the decimals of the shop currency.
function toAmount(value, kind = 'money') {
  const decimals = kind === 'percent' ? 2 : decimalsOf();
  if (typeof value === 'number') {
    const scaled = value * 10 ** decimals;
    return Number.isFinite(value) && Math.abs(scaled - Math.round(scaled)) < 1e-6 ? Math.round(scaled) / 10 ** decimals : NaN;
  }
  if (typeof value === 'string' && /^\d{1,9}(\.\d+)?$/.test(value.trim())) {
    const ok = kind === 'percent' ? /^\d+(\.\d{1,2})?$/.test(value.trim()) : isPlainAmount(value);
    if (ok) return parseFloat(value);
  }
  return NaN;
}
const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

function toDate(value) {
  if (isBlank(value)) return { ok: true, value: null };
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? { ok: false } : { ok: true, value };
  if (typeof value !== 'string' || value.length > 40) return { ok: false };
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? { ok: false } : { ok: true, value: d };
}

const EDITABLE = ['type', 'value', 'minOrderAmount', 'maxDiscount', 'usageLimit', 'perCustomerLimit', 'startsAt', 'endsAt', 'active'];

// Checks what an admin sent for a new coupon, or for a change to `existing`.
function validateCouponInput(body, existing = null) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};

  let code;
  if (existing) {
    code = existing.code;
    if (input.code !== undefined && normalizeCode(input.code) !== existing.code) {
      return { ok: false, message: 'The coupon code cannot be changed. Create a new coupon instead.' };
    }
  } else {
    if (typeof input.code !== 'string') return { ok: false, message: 'Coupon code is required.' };
    code = normalizeCode(input.code);
    if (!code) {
      return { ok: false, message: `Coupon code must be ${LIMITS.codeMin}-${LIMITS.codeMax} characters: letters, numbers, - and _.` };
    }
  }

  const merged = {};
  for (const key of EDITABLE) {
    merged[key] = input[key] !== undefined ? input[key] : (existing ? existing[key] : undefined);
  }

  if (merged.type !== 'percent' && merged.type !== 'fixed') {
    return { ok: false, message: 'Type must be "percent" or "fixed".' };
  }

  const value = toAmount(merged.value, merged.type === 'percent' ? 'percent' : 'money');
  if (!(value > 0)) return { ok: false, message: `Value must be a number greater than 0 (${merged.type === 'percent' ? 'at most 2 decimals' : decimalsRule()}).` };
  if (merged.type === 'percent' && value > 100) return { ok: false, message: 'A percentage can not be more than 100.' };
  if (merged.type === 'fixed' && value > LIMITS.amountMax) {
    return { ok: false, message: `Value can not be more than ${LIMITS.amountMax}.` };
  }

  let minOrderAmount = null;
  if (!isBlank(merged.minOrderAmount)) {
    minOrderAmount = toAmount(merged.minOrderAmount);
    if (!(minOrderAmount >= 0) || minOrderAmount > LIMITS.amountMax) {
      return { ok: false, message: `Minimum order must be between 0 and ${LIMITS.amountMax}.` };
    }
    if (minOrderAmount === 0) minOrderAmount = null;
  }

  let maxDiscount = null;
  if (merged.type === 'percent' && !isBlank(merged.maxDiscount)) {
    maxDiscount = toAmount(merged.maxDiscount);
    if (!(maxDiscount > 0) || maxDiscount > LIMITS.amountMax) {
      return { ok: false, message: `Maximum discount must be between 0 and ${LIMITS.amountMax}.` };
    }
  }

  let usageLimit = null;
  if (!isBlank(merged.usageLimit)) {
    const n = typeof merged.usageLimit === 'string' && /^\d{1,7}$/.test(merged.usageLimit.trim())
      ? parseInt(merged.usageLimit, 10) : merged.usageLimit;
    if (!Number.isInteger(n) || n < 1 || n > LIMITS.usageLimitMax) {
      return { ok: false, message: `Usage limit must be a whole number from 1 to ${LIMITS.usageLimitMax}.` };
    }
    if (existing && n < Number(existing.usedCount || 0)) {
      return { ok: false, message: `Usage limit can not be lower than the ${existing.usedCount} times this coupon was already used.` };
    }
    usageLimit = n;
  }

  let perCustomerLimit = null;
  if (!isBlank(merged.perCustomerLimit)) {
    const n = typeof merged.perCustomerLimit === 'string' && /^\d{1,7}$/.test(merged.perCustomerLimit.trim())
      ? parseInt(merged.perCustomerLimit, 10) : merged.perCustomerLimit;
    if (!Number.isInteger(n) || n < 1 || n > LIMITS.usageLimitMax) {
      return { ok: false, message: `Per-customer limit must be a whole number from 1 to ${LIMITS.usageLimitMax}.` };
    }
    perCustomerLimit = n;
  }

  const starts = toDate(merged.startsAt);
  if (!starts.ok) return { ok: false, message: 'Start date is not a valid date.' };
  const ends = toDate(merged.endsAt);
  if (!ends.ok) return { ok: false, message: 'End date is not a valid date.' };
  if (starts.value && ends.value && ends.value <= starts.value) {
    return { ok: false, message: 'The end date must be after the start date.' };
  }

  if (merged.active !== undefined && typeof merged.active !== 'boolean') {
    return { ok: false, message: 'Active must be true or false.' };
  }

  return {
    ok: true,
    value: {
      code,
      type: merged.type,
      value,
      minOrderAmount,
      maxDiscount,
      usageLimit,
      perCustomerLimit,
      startsAt: starts.value,
      endsAt: ends.value,
      active: merged.active === undefined ? true : merged.active
    }
  };
}

module.exports = {
  LIMITS, MESSAGE_NOT_VALID,
  round2, normalizeCode, computeDiscount, couponStatus, checkCoupon,
  buildClaimFilter, validateCouponInput
};

