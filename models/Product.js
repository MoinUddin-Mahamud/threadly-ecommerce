const mongoose = require('mongoose');
const { minorUnit, decimalsRule } = require('../services/money');

const productSchema = new mongoose.Schema(
  {
    title:       { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    price:       { type: Number, required: true, min: [0.01, 'Price must be above 0.'], max: [10000000, 'Price is too high.'],
                   validate: { validator: (v) => { const f = minorUnit(); return Math.abs(v * f - Math.round(v * f)) < 1e-6; }, message: () => `Price can have ${decimalsRule()}.` } },
    imageUrl:    { type: String, default: '' },
    stock:       { type: Number, default: 0, min: 0 },
    ratingAverage: { type: Number, default: undefined, min: 0, max: 5 },
    ratingCount:   { type: Number, default: undefined, min: 0 },
    // Extra pictures (up to 5) besides imageUrl, which stays the main picture.
    images:      { type: [String], default: undefined },
    // Optional stock per size, e.g. { S: 4, M: 0, L: 7 } (see services/sizes.js). When set,
    // `stock` is their sum.
    sizeStock:   { type: mongoose.Schema.Types.Mixed, default: undefined },
    // 'General' is only the legacy value of products created before the category list existed; every form
    // and the CSV import now require Men, Women, Kids or Accessories (services/categories.js).
    category:    { type: String, default: 'General', index: true }, // indexed for category filtering
    // The vendor that sells this product. null = sold by the store itself.
    vendorId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: null, index: true }
  },
  {
    timestamps: true
  }
);

productSchema.index({ category: 1, createdAt: -1 });

productSchema.index({ title: 'text', description: 'text' });

module.exports = mongoose.model('Product', productSchema);