'use strict';

// Product reviews: who may write one, how the text is cleaned, and the rating summary kept on the
// product. Reviews are plain text.

const Review = require('../models/Review');
const Product = require('../models/Product');
const Order = require('../models/Order');
const { plainName } = require('./plainText');

const MAX_TEXT = 1000;

// Reads what a customer sent. Resolves to { ok: true, rating, text } or { ok: false, message }.
function cleanReview(body) {
  const b = body && typeof body === 'object' ? body : {};
  // Only a number or a numeric string counts (true, [5] and {} must not turn into a rating).
  const raw = typeof b.rating === 'string' ? b.rating.trim() : b.rating;
  const rating = (typeof raw === 'number' || (typeof raw === 'string' && /^\d{1,2}$/.test(raw))) ? Number(raw) : NaN;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { ok: false, message: 'Choose a rating from 1 to 5 stars.' };
  }
  if (b.text !== undefined && b.text !== null && typeof b.text !== 'string') return { ok: false, message: 'The review must be text.' };
  const text = plainName(b.text || '');   // no "<", ">" or control characters, single spaces
  if (text.length > MAX_TEXT) return { ok: false, message: `The review can have at most ${MAX_TEXT} characters.` };
  return { ok: true, rating, text };
}

// "Anna Karenina" is shown as "Anna K." (the e-mail address is never shown).
function displayName(user) {
  const parts = plainName(String((user && user.name) || '')).split(' ').filter(Boolean);
  if (!parts.length) return 'Customer';
  const first = parts[0].slice(0, 30);
  return parts.length > 1 ? `${first} ${Array.from(parts[parts.length - 1])[0].toUpperCase()}.` : first;
}

// Orders of this customer: placed while logged in, or as a guest with an e-mail address they have
// verified (the same rule as "My orders").
function ownOrdersFilter(user) {
  const conditions = [{ userId: user._id }];
  if (user.emailVerified) conditions.push({ customerEmail: user.email });
  return { $or: conditions };
}

// True when this customer has a DELIVERED order that contains the product. Lines sold by the
// customer's own shop (ownVendorId) do not count.
async function hasReceived(user, productId, ownVendorId = null) {
  const line = ownVendorId ? { items: { $elemMatch: { productId, vendorId: { $ne: ownVendorId } } } } : { 'items.productId': productId };
  const found = await Order.exists({ ...ownOrdersFilter(user), status: 'DELIVERED', ...line });
  return !!found;
}

// True when the product belongs to the customer's own shop (sellers may not review themselves).
// The shop is known by the account (user.vendorId) and by the shop (vendor.ownerUserId).
function isOwnProduct(user, product, vendor = null) {
  const shop = product && product.vendorId;
  if (!user || !shop) return false;
  if (user.vendorId && String(user.vendorId) === String(shop)) return true;
  return !!(vendor && vendor.ownerUserId && user._id && String(vendor.ownerUserId) === String(user._id));
}

// Recalculates the average and the count shown on the product (hidden reviews do not count).
async function refreshRating(productId) {
  const [row] = await Review.aggregate([
    { $match: { productId, hidden: false } },
    { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } }
  ]);
  if (!row || !row.count) {
    await Product.updateOne({ _id: productId }, { $unset: { ratingAverage: 1, ratingCount: 1 } });
    return { average: 0, count: 0 };
  }
  const average = Math.round(row.average * 10) / 10;
  await Product.updateOne({ _id: productId }, { $set: { ratingAverage: average, ratingCount: row.count } });
  return { average, count: row.count };
}

module.exports = { MAX_TEXT, cleanReview, displayName, hasReceived, isOwnProduct, ownOrdersFilter, refreshRating };
