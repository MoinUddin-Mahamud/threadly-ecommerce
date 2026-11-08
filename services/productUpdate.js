'use strict';

// The parts of a product edit that the admin and the seller routes share.

const { cleanSizeStock, tracksSizes } = require('./sizes');
const { adjustStock, applySizeStockChange, clearSizeStock } = require('./stock');
const { applyPictures, picturesOf } = require('./uploads');

// Works out what an edit does to stock before anything is written. `stockDelta` is the change to
// the single stock number (0 when the edit has none). Resolves to { sizeChange, stockDelta } or
// { error: { status, message } }. `reload` completes "Reload the product before saving ...".
async function planStockChange({ findCurrent, body, sizes, stockDelta, reload }) {
  if (!sizes.provided && !stockDelta) return { sizeChange: null, stockDelta: 0 };
  const current = await findCurrent();
  if (!current) return { error: { status: 404, message: 'Product not found.' } };

  if (!sizes.provided) {
    if (tracksSizes(current)) {
      return { error: { status: 409, message: 'This product keeps its stock per size. Change the stock of each size instead.' } };
    }
    return { sizeChange: null, stockDelta };
  }
  if (sizes.value === null) return { sizeChange: tracksSizes(current) ? { clear: true } : null, stockDelta: 0 };

  const before = cleanSizeStock(body.previousSizeStock);
  if (!before.ok) return { error: { status: 400, message: before.message } };
  if (tracksSizes(current) && !before.provided) {
    return { error: { status: 400, message: `Reload the product before saving ${reload} (previousSizeStock is required).` } };
  }
  // A product that did not keep stock per size starts from nothing, whatever the form says.
  return { sizeChange: { previous: tracksSizes(current) ? (before.value || {}) : {}, next: sizes.value }, stockDelta: 0 };
}

// Applies a plan to the saved product and resolves to the product as it is afterwards.
async function applyStockChange(product, plan) {
  if (plan.sizeChange) {
    return (plan.sizeChange.clear
      ? await clearSizeStock(product._id)
      : await applySizeStockChange(product._id, plan.sizeChange.previous, plan.sizeChange.next)) || product;
  }
  if (plan.stockDelta) return (await adjustStock(product._id, plan.stockDelta)) || product;
  return product;
}

// Stores the new pictures of an edit into `data` and resolves to the picture addresses the product
// had before, so files nothing refers to afterwards can be removed.
async function savePictures(data, gallery, findPictures) {
  if (data.imageUrl === undefined && !gallery.provided) return [];
  let before = [];
  try { before = picturesOf(await findPictures()); } catch (e) { /* best effort */ }
  await applyPictures(data, gallery);
  return before;
}

module.exports = { planStockChange, applyStockChange, savePictures };
