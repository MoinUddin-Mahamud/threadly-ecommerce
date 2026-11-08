// Money in currencies with 0, 2 and 3 decimals: rounding, totals, coupons, commission, payouts,
// refunds and gateway amounts. The shop currency comes from CURRENCY_CODE; models are in-memory fakes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, OWNER } = require('./helpers');

const money = require('../services/money');
const rules = require('../services/productRules');
const coupons = require('../services/coupons');
const market = require('../services/marketplace');
const intl = require('../services/intlGateways');
const Order = require('../models/Order');

const JPY = { CURRENCY_CODE: 'JPY' };   // 0 decimals
const USD = { CURRENCY_CODE: 'USD' };   // 2 decimals
const KWD = { CURRENCY_CODE: 'KWD' };   // 3 decimals

async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
const inCurrency = (env, fn) => withEnv({ ...env, CARD_CURRENCY: undefined, CARD_RATE: undefined, MIN_ORDER_TOTAL: undefined }, fn);

test('the minor unit follows the currency: 1, 100 or 1000, and 100 when no currency is set', () => {
  assert.equal(money.minorUnit(JPY), 1);
  assert.equal(money.minorUnit(USD), 100);
  assert.equal(money.minorUnit(KWD), 1000);
  assert.equal(money.minorUnit({}), 100);
});

test('amounts round half up to the smallest unit of each currency', () => {
  assert.equal(money.toMinor(99.5, JPY), 100);
  assert.equal(money.toMinor(99.4, JPY), 99);
  assert.equal(money.toMinor(1.005, USD), 101);
  assert.equal(money.toMinor(1.2345, KWD), 1235);
  assert.equal(money.toMinor('2.500', KWD), 2500);
  assert.equal(money.toMinor(-1.5, JPY), -2);
  assert.equal(money.fromMinor(1250, JPY), 1250);
  assert.equal(money.fromMinor(1250, USD), 12.5);
  assert.equal(money.fromMinor(1250, KWD), 1.25);
});

test('totals, quantities and percentages add up exactly in every currency', async () => {
  await inCurrency(JPY, () => {
    assert.equal(money.addAmounts(100, 250, 50), 400);
    assert.equal(money.multiplyAmount(333, 3), 999);
    assert.equal(money.percentOf(999, 10), 100);      // 99.9 yen is 100 yen
    assert.equal(money.fixedAmount(money.percentOf(999, 10)), '100');
  });
  await inCurrency(USD, () => {
    assert.equal(money.addAmounts(0.1, 0.2), 0.3);
    assert.equal(money.percentOf(9.99, 10), 1);
  });
  await inCurrency(KWD, () => {
    assert.equal(money.addAmounts(0.1, 0.2), 0.3);
    assert.equal(money.multiplyAmount(1.255, 3), 3.765);
    assert.equal(money.percentOf(1.255, 10), 0.126);
    assert.equal(money.fixedAmount(money.percentOf(1.255, 10)), '0.126');
  });
});

test('a product price has the decimals of the currency, and a whole number when it has none', async () => {
  await inCurrency(JPY, () => {
    assert.equal(rules.parsePrice(1500).ok, true);
    assert.equal(rules.parsePrice('1500.00').ok, true);
    assert.equal(rules.parsePrice(99.5).ok, false);
    assert.match(rules.parsePrice('99.5').message, /no decimals/);
  });
  await inCurrency(USD, () => {
    assert.equal(rules.parsePrice('99.95').ok, true);
    assert.equal(rules.parsePrice('99.955').ok, false);
    assert.match(rules.parsePrice('99.955').message, /at most 2 decimals/);
  });
  await inCurrency(KWD, () => {
    assert.equal(rules.parsePrice('1.255').ok, true);
    assert.equal(rules.parsePrice('1.2555').ok, false);
    assert.match(rules.parsePrice('1.2555').message, /at most 3 decimals/);
  });
});

test('coupons: a percentage keeps its decimals in every currency, an amount follows the currency', async () => {
  await inCurrency(JPY, () => {
    const percent = coupons.validateCouponInput({ code: 'HALF', type: 'percent', value: 12.5 });
    assert.equal(percent.ok, true);
    assert.equal(percent.value.value, 12.5);
    assert.equal(coupons.validateCouponInput({ code: 'TEN', type: 'fixed', value: 10 }).ok, true);
    assert.equal(coupons.validateCouponInput({ code: 'TEN', type: 'fixed', value: 10.5 }).ok, false);
    // 10% of 999 yen is a whole number of yen.
    assert.equal(coupons.computeDiscount({ type: 'percent', value: 10 }, 999), 100);
  });
  await inCurrency(KWD, () => {
    assert.equal(coupons.validateCouponInput({ code: 'KUWAIT', type: 'fixed', value: '1.250' }).ok, true);
    assert.equal(coupons.validateCouponInput({ code: 'KUWAIT', type: 'fixed', value: '1.2501' }).ok, false);
    assert.equal(coupons.computeDiscount({ type: 'fixed', value: 0.5 }, 1.255), 0.5);
    assert.equal(coupons.computeDiscount({ type: 'percent', value: 10 }, 1.255), 0.126);
  });
  await inCurrency(USD, () => {
    assert.equal(coupons.computeDiscount({ type: 'percent', value: 12.5 }, 99.99), 12.5);
  });
});

test('a coupon never takes the whole order: the smallest payable total is one minor unit', async () => {
  await inCurrency(JPY, () => assert.equal(coupons.computeDiscount({ type: 'percent', value: 100 }, 500), 499));
  await inCurrency(USD, () => assert.equal(coupons.computeDiscount({ type: 'percent', value: 100 }, 500), 499.99));
  await inCurrency(KWD, () => assert.equal(coupons.computeDiscount({ type: 'percent', value: 100 }, 5), 4.999));
});

test('seller commission is rounded in the smallest unit and net plus commission equals gross', async () => {
  const lineOf = (price, quantity, commissionPercent) => ({ vendorId: 'v1', price, quantity, commissionPercent });
  await inCurrency(JPY, () => {
    const s = market.vendorShare({ items: [lineOf(999, 1, 12.5)] }, 'v1');
    assert.deepEqual(s, { gross: 999, commission: 125, net: 874 });     // 124.875 yen is 125 yen
  });
  await inCurrency(USD, () => {
    const s = market.vendorShare({ items: [lineOf(9.99, 3, 10)] }, 'v1');
    assert.deepEqual(s, { gross: 2997, commission: 300, net: 2697 });
  });
  await inCurrency(KWD, () => {
    const s = market.vendorShare({ items: [lineOf(1.255, 1, 10)] }, 'v1');
    assert.deepEqual(s, { gross: 1255, commission: 126, net: 1129 });   // 125.5 thousandths rounds up
    assert.equal(money.fromMinor(s.net), 1.129);
  });
});

test('a coupon share is split over the lines in whole minor units without losing a unit', () => {
  for (const [lines, discount] of [[[999, 501], 100], [[1255, 1255, 1], 777], [[1, 1, 1], 2]]) {
    const parts = market.splitDiscount(lines, discount);
    assert.equal(parts.reduce((a, b) => a + b, 0), discount);
    parts.forEach((p, i) => assert.ok(Number.isInteger(p) && p >= 0 && p <= lines[i]));
  }
});

test('a payout is the payable earnings minus the refunds clawed back, shown in the currency units', async () => {
  const payable = [{ net: 874 }, { net: 1129 }];
  const clawbacks = [{ net: 500 }];
  const amountMinor = payable.reduce((a, l) => a + l.net, 0) - clawbacks.reduce((a, l) => a + l.net, 0);
  assert.equal(amountMinor, 1503);
  await inCurrency(JPY, () => assert.equal(money.fixedAmount(money.fromMinor(amountMinor)), '1503'));
  await inCurrency(USD, () => assert.equal(money.fixedAmount(money.fromMinor(amountMinor)), '15.03'));
  await inCurrency(KWD, () => assert.equal(money.fixedAmount(money.fromMinor(amountMinor)), '1.503'));
});

test('the admin refund amount is checked in the smallest unit of the currency', async () => {
  const agent = request.agent(app);
  const login = await agent.post('/admin/login').send(OWNER);
  assert.equal(login.status, 200);
  const refund = (total, body) => new Promise((resolve) => {
    const saved = [Order.findOne, Order.findOneAndUpdate];
    let stored = null;
    Order.findOne = async () => ({ _id: '64b7f0c2a1b2c3d4e5f60001', totalAmount: total });
    Order.findOneAndUpdate = async (f, u) => { stored = u.$set.refundedAmount; return { _id: f._id }; };
    agent.put('/admin/orders/64b7f0c2a1b2c3d4e5f60001/mark-refunded').set('X-CSRF-Token', login.body.csrfToken).send(body)
      .then((res) => { [Order.findOne, Order.findOneAndUpdate] = saved; resolve({ status: res.status, stored }); });
  });
  await inCurrency(JPY, async () => {
    assert.deepEqual(await refund(1000, { amount: '500.4' }), { status: 200, stored: 500 });
    assert.equal((await refund(1000, { amount: '1000.5' })).status, 400);       // 1001 yen is more than was paid
    assert.deepEqual(await refund(1000, {}), { status: 200, stored: 1000 });    // blank: the full total
  });
  await inCurrency(KWD, async () => {
    assert.deepEqual(await refund(1.255, { amount: '0.5' }), { status: 200, stored: 0.5 });
    assert.deepEqual(await refund(1.255, { amount: '1.255' }), { status: 200, stored: 1.255 });
    assert.equal((await refund(1.255, { amount: '1.256' })).status, 400);
  });
});

test('card gateway amounts follow the shop and card currencies', async () => {
  // Same currency: JPY has no minor unit, USD counts cents, KWD is charged in a multiple of 10 thousandths.
  await withEnv({ CURRENCY_CODE: 'JPY', CARD_CURRENCY: undefined, CARD_RATE: undefined }, () => assert.equal(intl.toMinorUnits(1500), 1500));
  await withEnv({ CURRENCY_CODE: 'USD', CARD_CURRENCY: undefined, CARD_RATE: undefined }, () => assert.equal(intl.toMinorUnits(12.34), 1234));
  await withEnv({ CURRENCY_CODE: 'KWD', CARD_CURRENCY: undefined, CARD_RATE: undefined }, () => assert.equal(intl.toMinorUnits(1.255), 1260));
  // Another card currency: 1000 yen at 0.0067 is 6.70 in cents; 10.00 in cents at 150 is 1500 whole yen.
  await withEnv({ CURRENCY_CODE: 'JPY', CARD_CURRENCY: 'USD', CARD_RATE: '0.0067' }, () => assert.equal(intl.toMinorUnits(1000), 670));
  await withEnv({ CURRENCY_CODE: 'USD', CARD_CURRENCY: 'JPY', CARD_RATE: '150' }, () => assert.equal(intl.toMinorUnits(10), 1500));
  await withEnv({ CURRENCY_CODE: 'KWD', CARD_CURRENCY: 'USD', CARD_RATE: '3.25' }, () => assert.equal(intl.toMinorUnits(2), 650));
});

test('the smallest card charge is per currency, in the minor units the gateway counts', () => {
  assert.equal(intl.minChargeMinor('USD'), 50);
  assert.equal(intl.minChargeMinor('GBP'), 30);
  assert.equal(intl.minChargeMinor('DKK'), 250);
  assert.equal(intl.minChargeMinor('CZK'), 1500);
  assert.equal(intl.minChargeMinor('THB'), 1000);
  assert.equal(intl.minChargeMinor('JPY'), 50);
  assert.equal(intl.minChargeMinor('KRW'), 50);
  assert.equal(intl.minChargeMinor('HUF'), 17500);          // two decimals
  assert.equal(intl.minChargeMinor('HUF', 'stripe'), 17500);
  // Stripe's table is for Stripe only: the other gateways use the default minimum
  for (const gateway of ['paypal', 'flutterwave', 'mollie']) {
    assert.equal(intl.minChargeMinor('CZK', gateway), 50, gateway);
    assert.equal(intl.minChargeMinor('GBP', gateway), 50, gateway);
  }
  assert.equal(intl.minChargeMinor('HUF', 'paypal'), 50);   // PayPal counts HUF in whole units
  assert.equal(intl.minChargeMinor('KWD'), 500);            // not in the table: the default, times 10
  assert.equal(intl.minChargeMinor('xyz'), 50);
  assert.equal(intl.MIN_INTL_MINOR, 50);
});

test('the minimum order total is one minor unit of the currency at least', async () => {
  await inCurrency(JPY, () => assert.equal(money.minOrderMinor({ CURRENCY_CODE: 'JPY' }), 1));
  await inCurrency(KWD, () => assert.equal(money.fromMinor(money.minOrderMinor({ CURRENCY_CODE: 'KWD' })), 0.001));
  await withEnv({ CURRENCY_CODE: 'JPY', MIN_ORDER_TOTAL: '500' }, () => assert.equal(money.minOrderMinor(), 500));
  await withEnv({ CURRENCY_CODE: 'KWD', MIN_ORDER_TOTAL: '2.5' }, () => assert.equal(money.minOrderMinor(), 2500));
});
