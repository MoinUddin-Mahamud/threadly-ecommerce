'use strict';

const mongoose = require('mongoose');

const couponRedemptionSchema = new mongoose.Schema({
  couponId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Coupon',
    required: true
  },
  customerKey: {
    type: String,
    required: true
  },
  count: {
    type: Number,
    default: 0,
    min: 0
  }
}, { timestamps: true });

couponRedemptionSchema.index({ couponId: 1, customerKey: 1 }, { unique: true });

module.exports = mongoose.model('CouponRedemption', couponRedemptionSchema);
