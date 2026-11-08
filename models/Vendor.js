const mongoose = require('mongoose');

// A seller on the marketplace (see services/marketplace.js). A customer applies,
// an admin approves. Only approved vendors' products are visible and buyable.
const vendorSchema = new mongoose.Schema(
  {
    name:           { type: String, required: true, trim: true, minlength: 2, maxlength: 60 },
    slug:           { type: String, required: true, unique: true, lowercase: true, trim: true },
    description:    { type: String, default: '', maxlength: 500 },
    phone:          { type: String, default: '', trim: true, maxlength: 30 },
    status:         { type: String, enum: ['pending', 'approved', 'suspended'], default: 'pending', index: true },
    // Percent the marketplace keeps from each sale (0-90). Copied onto every order
    // item when the order is placed, so changing it never rewrites past orders.
    commissionPercent: { type: Number, default: 10, min: 0, max: 90 },
    ownerUserId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    approvedAt:     { type: Date, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Vendor', vendorSchema);
