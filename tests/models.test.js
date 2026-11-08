const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Admin = require('../models/Admin');

const oid = () => new mongoose.Types.ObjectId();

// Resolves to the ValidationError, or undefined when the document is valid.
async function validationError(doc) {
  try { await doc.validate(); return undefined; } catch (err) { return err; }
}

test('Product requires a title and a non-negative price', async () => {
  const bad = await validationError(new Product({ price: -5 }));
  assert.ok(bad.errors.title);
  assert.ok(bad.errors.price);
  assert.equal(await validationError(new Product({ title: 'Bomber', price: 4999 })), undefined);
});

test('Product defaults: zero stock, General category', async () => {
  const p = new Product({ title: 'Parka', price: 100 });
  assert.equal(p.currency, undefined);   // no currency is stored on products
  assert.equal(p.stock, 0);
  assert.equal(p.category, 'General');
});

test('Order needs customer details and a total, and defaults to PENDING / sslcommerz', async () => {
  const bad = await validationError(new Order({}));
  assert.ok(bad.errors.customerName);
  assert.ok(bad.errors.customerEmail);
  assert.ok(bad.errors.totalAmount);

  const o = new Order({ customerName: 'A', customerEmail: 'A@Example.com', totalAmount: 10,
    items: [{ productId: oid(), title: 'Shirt', price: 10, quantity: 1 }] });
  assert.equal(await validationError(o), undefined);
  assert.equal(o.status, 'PENDING');
  assert.equal(o.paymentGateway, 'sslcommerz');
  assert.equal(o.customerEmail, 'a@example.com');
});

test('Order rejects unknown statuses and zero quantities', async () => {
  const errs = await validationError(new Order({ customerName: 'A', customerEmail: 'a@b.com', totalAmount: 1, status: 'LOST',
    items: [{ productId: oid(), title: 'J', price: 1, quantity: 0 }] }));
  assert.ok(errs.errors.status);
  assert.ok(errs.errors['items.0.quantity']);
});

test('Admin defaults to the staff role, lowercases usernames, and rejects unknown roles', async () => {
  const a = new Admin({ username: 'HeLpEr', passwordHash: 'x' });
  assert.equal(a.role, 'staff');
  assert.equal(a.username, 'helper');
  assert.ok((await validationError(new Admin({ username: 'x', passwordHash: 'x', role: 'god' }))).errors.role);
});
