// The cart's coupon check: the payload the storefront script really builds must pass the server.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const request = require('supertest');
const { app } = require('./helpers');

const Product = require('../models/Product');
const Coupon = require('../models/Coupon');

const PRODUCT_ID = '64b7f0c2a1b2c3d4e5f60001';
const COUPON_ID = '64b7f0c2a1b2c3d4e5f60abc';

// Takes cartLinesForServer() out of public/js/app.js and runs it on a stored cart.
function clientLines(storedCart) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const m = src.match(/function cartLinesForServer\(\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'cartLinesForServer is in app.js');
  const sandbox = { getCart: () => storedCart, out: null };
  vm.createContext(sandbox);
  vm.runInContext(`${m[0]}\nout = cartLinesForServer();`, sandbox);
  return JSON.parse(JSON.stringify(sandbox.out));
}

async function withStubs(stubs, fn) {
  const saved = stubs.map(([target, name]) => [target, name, target[name]]);
  stubs.forEach(([target, name, impl]) => { target[name] = impl; });
  try { await fn(); } finally { saved.forEach(([target, name, original]) => { target[name] = original; }); }
}

// Shaped like the items addToCart() saves in the browser.
const storedCart = [{ cartKey: `${PRODUCT_ID}_M`, productId: PRODUCT_ID, title: 'Bomber', price: 100, quantity: 2, size: 'M' }];

test('the cart sends productId, quantity and size for every line', () => {
  assert.deepEqual(clientLines(storedCart), [{ productId: PRODUCT_ID, quantity: 2, size: 'M' }]);
});

test('the payload the storefront builds is accepted by POST /api/coupons/validate', async () => {
  const live = { _id: COUPON_ID, code: 'SAVE10', type: 'percent', value: 10, active: true, usedCount: 0 };
  await withStubs([
    [Product, 'find', () => ({ select: () => ({ lean: async () => [{ _id: PRODUCT_ID, title: 'Bomber', price: 100, stock: 5 }] }) })],
    [Coupon, 'findOne', async () => live]
  ], async () => {
    const res = await request(app).post('/api/coupons/validate').send({ code: 'SAVE10', items: clientLines(storedCart) });
    assert.equal(res.status, 200);
    assert.equal(res.body.discount, 20);
  });
});
