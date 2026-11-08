// The three marketplace money rules.
const { test } = require('node:test');
const assert = require('node:assert/strict');
// These tests are about earnings and payouts, not the hold (the 7-day default is tested in
// currency-decimals and chat-retry-safety), so they run without it.
process.env.PAYOUT_HOLD_DAYS = '0';
const fs = require('node:fs');
const path = require('node:path');
const Order = require('../models/Order');
const Payout = require('../models/Payout');
const Product = require('../models/Product');
const marketplace = require('../services/marketplace');
const orderService = require('../services/orderService');

async function withStubs(stubs, fn) {
  const saved = stubs.map(([target, name]) => [target, name, target[name]]);
  stubs.forEach(([target, name, impl]) => { target[name] = impl; });
  try { await fn(); } finally { saved.forEach(([target, name, original]) => { target[name] = original; }); }
}
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { await fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
// A query result that supports .select().sort().limit().lean() and can be awaited.
const chain = (rows) => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => rows, then: (res, rej) => Promise.resolve(rows).then(res, rej) });

const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';   // seller A
const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';   // seller B
const P_A = '111111111111111111111111';
const P_B = '222222222222222222222222';
const P_OWN = '333333333333333333333333';

test('every money rule is off by default and turns on only with the word "true"', () => {
  assert.equal(marketplace.keepsShippedOnCancel({}), false);
  assert.equal(marketplace.couponSplitProRata({}), false);
  assert.equal(marketplace.fundsCoupons({}), false);
  for (const v of ['', 'false', '1', 'yes', 'on']) {
    assert.equal(marketplace.keepsShippedOnCancel({ SELLER_KEEPS_SHIPPED_ON_CANCEL: v }), false, v);
    assert.equal(marketplace.couponSplitProRata({ COUPON_SPLIT_PRO_RATA: v }), false, v);
  }
  assert.equal(marketplace.keepsShippedOnCancel({ SELLER_KEEPS_SHIPPED_ON_CANCEL: ' TRUE ' }), true);
  assert.equal(marketplace.couponSplitProRata({ COUPON_SPLIT_PRO_RATA: 'true' }), true);
  assert.equal(marketplace.couponSplitProRata({ COUPON_SPLIT_PRO_RATA: 'true', MARKETPLACE_FUNDS_COUPONS: 'true' }), false, 'funding coupons wins over the split');
});

test('splitDiscount shares a coupon pro rata in whole minor units, the remainder to the last line', () => {
  assert.deepEqual(marketplace.splitDiscount([1000, 1000, 333], 500), [214, 214, 72]);
  assert.equal(marketplace.splitDiscount([1000, 1000, 333], 500).reduce((a, b) => a + b, 0), 500, 'the shares always add up');
  assert.deepEqual(marketplace.splitDiscount([100, 300], 0), [0, 0]);
  assert.deepEqual(marketplace.splitDiscount([], 50), []);
  assert.deepEqual(marketplace.splitDiscount([100, 300], 9999), [100, 300], 'never more than the lines are worth');
  const shares = marketplace.splitDiscount([5, 1], 5);
  assert.equal(shares[0] + shares[1], 5); assert.ok(shares[0] <= 5 && shares[1] <= 1);
});

const order = (extra = {}) => ({
  items: [
    { vendorId: A, price: 100, quantity: 1, commissionPercent: 10, ...(extra.discountA !== undefined ? { discountMinor: extra.discountA } : {}) },
    { vendorId: B, price: 100, quantity: 1, commissionPercent: 10, ...(extra.discountB !== undefined ? { discountMinor: extra.discountB } : {}) }
  ]
});

test('seller earnings: with no stored share (flag off, or an older order) the full price counts, exactly as before', () => {
  assert.deepEqual(marketplace.vendorShare(order(), A), { gross: 10000, commission: 1000, net: 9000 });
});

test('seller earnings: with a stored share, commission and earnings are worked out on the price after the coupon', () => {
  // A 60.00 coupon split 30.00 / 30.00: each seller's line is worth 70.00, commission 7.00, net
  // 63.00.
  assert.deepEqual(marketplace.vendorShare(order({ discountA: 3000, discountB: 3000 }), A), { gross: 7000, commission: 700, net: 6300 });
  // A coupon bigger than the commission is no problem: a line cannot go below zero.
  assert.deepEqual(marketplace.vendorShare(order({ discountA: 99999 }), A), { gross: 0, commission: 0, net: 0 });
  assert.equal(marketplace.vendorNetOfItems(order({ discountA: 3000, discountB: 3000 }).items), 12600);
});

test('the old refusal still works while the split is off: a coupon bigger than the commission is refused', () => {
  const items = order().items;
  // Customer pays 200 - 190 coupon = 10, but the sellers would still be owed 180: refused.
  assert.equal(marketplace.wouldLoseMoney(items, 1000), true);
  assert.equal(marketplace.wouldLoseMoney(items, 20000), false);
});

test('the checkout route splits the coupon only when COUPON_SPLIT_PRO_RATA is on (source check)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'api.js'), 'utf8');
  assert.match(src, /if \(marketplace\.couponSplitProRata\(\)\) \{[\s\S]*splitDiscount[\s\S]*discountMinor/);
  assert.match(src, /claimedCoupon && !marketplace\.couponSplitProRata\(\) && marketplace\.wouldLoseMoney/);
  assert.match(src, /!marketplace\.couponSplitProRata\(\) && marketplace\.wouldLoseMoney\(cart\.lines/);
});

function cancelWorld(env) {
  const log = { restocked: [], updates: [], orderUpdates: [] };
  const cancelled = {
    _id: 'o1', status: 'CANCELLED', stockReleased: true, couponId: null,
    items: [
      { productId: P_A, vendorId: A, quantity: 2 },     // seller A already shipped
      { productId: P_B, vendorId: B, quantity: 3 },     // seller B has not
      { productId: P_OWN, quantity: 1 }                 // the store's own item
    ],
    fulfillment: [{ vendorId: A, status: 'SHIPPED' }, { vendorId: B, status: 'PENDING' }]
  };
  return {
    log, cancelled,
    stubs: [
      [Order, 'findOneAndUpdate', async () => cancelled],
      [Order, 'updateOne', async (f, u) => { log.orderUpdates.push(u); return {}; }],
      [Product, 'updateOne', async (f) => { log.restocked.push(String(f._id)); return {}; }]
    ]
  };
}

test('flag OFF: shipped goods are not restocked, everything else is, and no seller is recorded as kept', async () => {
  const w = cancelWorld();
  await withEnv({ SELLER_KEEPS_SHIPPED_ON_CANCEL: undefined }, () => withStubs(w.stubs, async () => {
    await orderService.cancelOrderAndRestock('o1');
  }));
  assert.deepEqual(w.log.restocked.sort(), [P_B, P_OWN].sort(), "seller A's goods have left: no restock, even when A does not keep earnings");
  assert.deepEqual(w.log.orderUpdates, [{ $set: { noRestockVendorIds: [A] } }], 'remembered for a later reopen, but not "kept"');
});

test('flag ON: the seller who shipped is not restocked and is recorded; everyone else is restocked', async () => {
  const w = cancelWorld();
  await withEnv({ SELLER_KEEPS_SHIPPED_ON_CANCEL: 'true' }, () => withStubs(w.stubs, async () => {
    await orderService.cancelOrderAndRestock('o1');
  }));
  assert.deepEqual(w.log.restocked.sort(), [P_B, P_OWN].sort(), 'seller A\'s goods have left: no restock');
  assert.deepEqual(w.log.orderUpdates, [{ $set: { keptVendorIds: [A], noRestockVendorIds: [A] } }]);
});

test('flag ON but nobody had shipped: nothing is kept and everything is restocked', async () => {
  const w = cancelWorld();
  w.cancelled.fulfillment = [{ vendorId: A, status: 'PENDING' }, { vendorId: B, status: 'PENDING' }];
  await withEnv({ SELLER_KEEPS_SHIPPED_ON_CANCEL: 'true' }, () => withStubs(w.stubs, async () => {
    await orderService.cancelOrderAndRestock('o1');
  }));
  assert.equal(w.log.restocked.length, 3);
  assert.equal(w.log.orderUpdates.length, 0);
});

test('reopening an order that kept a seller takes stock only for the others and clears keptVendorIds, flag on or off', async () => {
  const reserved = []; let update;
  const current = {
    _id: 'o1', status: 'CANCELLED', stockReleased: true, paymentGateway: 'cod', paidAt: new Date(), couponId: null, keptVendorIds: [A],
    items: [{ productId: P_A, vendorId: A, quantity: 2 }, { productId: P_B, vendorId: B, quantity: 3 }]
  };
  await withEnv({ SELLER_KEEPS_SHIPPED_ON_CANCEL: undefined }, () => withStubs([
    [Order, 'findById', async () => current],
    [Product, 'findOneAndUpdate', async (f) => { reserved.push(String(f._id)); return {}; }],
    [Order, 'findOneAndUpdate', async (f, u) => { update = u; return { _id: 'o1', status: 'CONFIRMED' }; }]
  ], async () => {
    assert.equal((await orderService.reopenCancelledOrder('o1', 'CONFIRMED')).result, 'reopened');
  }));
  assert.deepEqual(reserved, [P_B], 'seller A\'s goods were never put back, so nothing is taken for them');
  assert.deepEqual(update.$unset, { paymentIssue: 1, keptVendorIds: 1, noRestockVendorIds: 1 });
});

test('reopening an order whose shipped seller was NOT kept (flag off) takes no stock for that seller either', async () => {
  const reserved = []; let update;
  const current = {
    _id: 'o1', status: 'CANCELLED', stockReleased: true, paymentGateway: 'cod', paidAt: new Date(), couponId: null, noRestockVendorIds: [A],
    items: [{ productId: P_A, vendorId: A, quantity: 2 }, { productId: P_B, vendorId: B, quantity: 3 }]
  };
  await withEnv({ SELLER_KEEPS_SHIPPED_ON_CANCEL: undefined }, () => withStubs([
    [Order, 'findById', async () => current],
    [Product, 'findOneAndUpdate', async (f) => { reserved.push(String(f._id)); return {}; }],
    [Order, 'findOneAndUpdate', async (f, u) => { update = u; return { _id: 'o1', status: 'CONFIRMED' }; }]
  ], async () => {
    assert.equal((await orderService.reopenCancelledOrder('o1', 'CONFIRMED')).result, 'reopened');
  }));
  assert.deepEqual(reserved, [P_B]);
  assert.ok('noRestockVendorIds' in update.$unset);
});

test('an order cancelled by the older rule (everything restocked, no noRestockVendorIds) still takes stock for every item on reopen', async () => {
  const reserved = [];
  const current = {
    _id: 'o1', status: 'CANCELLED', stockReleased: true, paymentGateway: 'cod', paidAt: new Date(), couponId: null,
    items: [{ productId: P_A, vendorId: A, quantity: 2 }, { productId: P_B, vendorId: B, quantity: 3 }]
  };
  await withStubs([
    [Order, 'findById', async () => current],
    [Product, 'findOneAndUpdate', async (f) => { reserved.push(String(f._id)); return {}; }],
    [Order, 'findOneAndUpdate', async () => ({ _id: 'o1', status: 'CONFIRMED' })]
  ], async () => {
    assert.equal((await orderService.reopenCancelledOrder('o1', 'CONFIRMED')).result, 'reopened');
  });
  assert.deepEqual(reserved.sort(), [P_A, P_B].sort());
});

async function lines(vendorId, orders, { paid = [], settled = [] } = {}) {
  const out = [];
  await withStubs([
    [Order, 'find', () => chain(orders)],
    [Payout, 'find', (q) => chain(q.orderIds ? paid.map((id) => ({ orderIds: [id] })) : settled.map((id) => ({ clawbackOrderIds: [id] })))]
  ], async () => { await marketplace.scanOrders(vendorId, (l) => { out.push(l); }); });
  return out;
}
const cancelledOrder = (extra = {}) => ({
  _id: 'o9', status: 'CANCELLED', paidAt: new Date(), createdAt: new Date(),
  items: [{ vendorId: A, price: 100, quantity: 1, commissionPercent: 10 }],
  fulfillment: [{ vendorId: A, status: 'SHIPPED' }], ...extra
});

test('a cancelled order the seller was never paid for earns nothing (as before)', async () => {
  assert.deepEqual(await lines(A, [cancelledOrder()]), []);
});

test('a cancelled order the seller KEPT is payable (state "payable") even though only shipped', async () => {
  const out = await lines(A, [cancelledOrder({ keptVendorIds: [A] })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].state, 'payable'); assert.equal(out[0].net, 9000);
});

test('a kept order that was already paid shows as paid, never as a clawback', async () => {
  const out = await lines(A, [cancelledOrder({ keptVendorIds: [A] })], { paid: ['o9'] });
  assert.equal(out[0].state, 'paid');
});

test('a cancelled order the seller was paid for (and did not keep) is a clawback', async () => {
  const out = await lines(A, [cancelledOrder()], { paid: ['o9'] });
  assert.equal(out[0].state, 'clawback');
});

test('a clawback that was settled and then REOPENED is payable again, with a generation number so the double-payment guard holds', async () => {
  const reopened = cancelledOrder({ status: 'CONFIRMED', fulfillment: [{ vendorId: A, status: 'DELIVERED' }] });
  const out = await lines(A, [reopened], { paid: ['o9'], settled: ['o9'] });
  assert.equal(out[0].state, 'payable', 'paid once, clawed back once: the seller holds nothing, so it can be paid again');
  assert.equal(out[0].paidOutCount, 1); assert.equal(out[0].settledCount, 1);
  const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'adminExtras.js'), 'utf8');
  assert.match(routes, /l\.paidOutCount \? `\$\{vendor\._id\}:\$\{l\.orderId\}:\$\{l\.paidOutCount\}`/, 'the second payment of an order gets its own unique key');
  assert.match(routes, /:clawback:\$\{l\.settledCount\}/, 'and so does the second clawback');
});

test('a payout covers at most 2000 orders', () => {
  assert.equal(marketplace.MAX_PAYOUT_ORDERS, 2000);
});
