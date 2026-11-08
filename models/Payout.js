const mongoose = require('mongoose');

// A payment from the marketplace to a vendor, made outside the app (bank transfer,
// mobile banking, ...) and recorded here by an admin. It covers whole orders, so an
// order's earnings cannot be paid out twice.
const payoutSchema = new mongoose.Schema(
  {
    vendorId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
    amount:    { type: Number, required: true, min: 0 },          // what the vendor was paid
    orderIds:  { type: [mongoose.Schema.Types.ObjectId], default: [] },
    // Orders cancelled after an earlier payout: their amount was taken off this payout (a clawback).
    clawbackOrderIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    // "<vendorId>:<orderId>" per paid order, "<vendorId>:<orderId>:clawback" per clawback, with a
    // cycle number ("...:<n>") when an order is paid again.
    lineKeys:  { type: [String], default: [] },
    note:      { type: String, default: '', maxlength: 300 },
    paidBy:    { type: String, default: '' }
  },
  { timestamps: true }
);
payoutSchema.index({ lineKeys: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Payout', payoutSchema);
