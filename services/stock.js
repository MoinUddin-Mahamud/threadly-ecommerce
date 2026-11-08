const Product = require('../models/Product');
const { MAX_STOCK, sizeKey } = require('./sizes');

// The stock a form was loaded with: a whole number from 0 to MAX_STOCK, or null when it was not
// sent.
function parsePreviousStock(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n <= MAX_STOCK ? n : null;
}

// Adds `delta` (may be negative) to a product's stock in one atomic step. The
// result never goes below 0 or above MAX_STOCK. Resolves to the updated product.
async function adjustStock(productId, delta) {
  if (!delta) return Product.findById(productId);
  return Product.findOneAndUpdate(
    { _id: productId },
    [{ $set: { stock: { $min: [MAX_STOCK, { $max: [0, { $add: [{ $ifNull: ['$stock', 0] }, delta] }] }] } } }],
    { returnDocument: 'after' }
  );
}

// Per-size stock (see services/sizes.js).
async function applySizeStockChange(productId, previous, next) {
  const set = {};
  for (const [key, units] of Object.entries(next)) {
    const delta = units - (Number(previous && previous[key]) || 0);
    if (delta) {
      set[`sizeStock.${key}`] = { $min: [MAX_STOCK, { $max: [0, { $add: [{ $ifNull: [`$sizeStock.${key}`, 0] }, delta] }] }] };
    } else {
      set[`sizeStock.${key}`] = { $ifNull: [`$sizeStock.${key}`, 0] };   // a new size with 0 units, or unchanged
    }
  }
  const removed = Object.keys(previous || {}).filter((k) => !(k in next));
  const pipeline = [{ $set: set }];
  if (removed.length) pipeline.push({ $unset: removed.map((k) => `sizeStock.${k}`) });
  pipeline.push({ $set: { stock: { $sum: { $map: { input: { $objectToArray: '$sizeStock' }, as: 'e', in: '$$e.v' } } } } });
  return Product.findOneAndUpdate({ _id: productId }, pipeline, { returnDocument: 'after' });
}

// Stops tracking stock per size: `stock` keeps its current value and becomes the one number again.
async function clearSizeStock(productId) {
  return Product.findOneAndUpdate({ _id: productId }, { $unset: { sizeStock: 1 } }, { returnDocument: 'after' });
}

module.exports = { MAX_STOCK, sizeKey, parsePreviousStock, adjustStock, applySizeStockChange, clearSizeStock };
