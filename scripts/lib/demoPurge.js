const Order = require('../../models/Order');
const Coupon = require('../../models/Coupon');
const CouponRedemption = require('../../models/CouponRedemption');
const Review = require('../../models/Review');
const Payout = require('../../models/Payout');
const User = require('../../models/User');

const targets = [['orders', Order], ['coupons', Coupon], ['coupon redemptions', CouponRedemption],
  ['reviews', Review], ['payouts', Payout], ['customer accounts', User]];

// How many documents purgeDemoData would remove, per collection.
async function countDemoData() {
  const counts = {};
  for (const [name, model] of targets) counts[name] = await model.countDocuments({});
  return counts;
}

// Removes what visitors create while using a demo. Returns the number removed per collection.
async function purgeDemoData() {
  const counts = {};
  for (const [name, model] of targets) counts[name] = (await model.deleteMany({})).deletedCount || 0;
  return counts;
}

module.exports = { purgeDemoData, countDemoData };
