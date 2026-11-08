const mongoose = require('mongoose');

// A customer's review of a product. One per customer per product, and only after the customer
// received it (see services/reviews.js).
const reviewSchema = new mongoose.Schema(
  {
    productId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // "Anna K.": first name and the initial of the last name, never the e-mail address.
    authorName: { type: String, trim: true, maxlength: 60, default: 'Customer' },
    rating:     { type: Number, required: true, min: 1, max: 5 },
    text:       { type: String, trim: true, maxlength: 1000, default: '' },
    hidden:     { type: Boolean, default: false }
  },
  { timestamps: true }
);

reviewSchema.index({ productId: 1, userId: 1 }, { unique: true });
reviewSchema.index({ productId: 1, hidden: 1, createdAt: -1 });
reviewSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Review', reviewSchema);
