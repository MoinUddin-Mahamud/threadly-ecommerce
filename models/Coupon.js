const mongoose = require('mongoose');

// A discount code. Rules are checked on the server; usedCount only changes through
// conditional updates (services/couponService.js), so usageLimit is never exceeded.
const couponSchema = new mongoose.Schema(
  {
    code:           { type: String, required: true, uppercase: true, trim: true, maxlength: 32 },
    type:           { type: String, enum: ['percent', 'fixed'], required: true },
    // percent: 0-100 (a percentage of the cart total); fixed: an amount
    value:          { type: Number, required: true, min: 0 },
    // null = no minimum order / no cap / unlimited / no start or end date
    minOrderAmount: { type: Number, default: null, min: 0 },
    maxDiscount:    { type: Number, default: null, min: 0 },
    usageLimit:     { type: Number, default: null, min: 1 },
    perCustomerLimit: { type: Number, default: null, min: 1 },
    usedCount:      { type: Number, default: 0, min: 0 },
    startsAt:       { type: Date, default: null },
    endsAt:         { type: Date, default: null },
    active:         { type: Boolean, default: true }
  },
  { timestamps: true }
);

// The unique index lives here only: `unique: true` on the field as well would build it twice.
couponSchema.index({ code: 1 }, { unique: true });
couponSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Coupon', couponSchema);
