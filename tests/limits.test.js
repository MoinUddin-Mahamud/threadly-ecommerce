// Tests for: size limits on orders, the order rate limit, escaping of customer
// text in emails, and reserveItems keeping track of what it took.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const nodemailer = require('nodemailer');
const SSLCommerzPayment = require('sslcommerz-lts');
const { app } = require('./helpers');
const Order = require('../models/Order');
const Product = require('../models/Product');
const { reserveItems } = require('../services/orderService');

const PRODUCT_ID = '64b7f0c2a1b2c3d4e5f60999';
const line = { productId: PRODUCT_ID, quantity: 1, size: 'M' };
const body = (extra = {}) => ({ customerName: 'Buyer', customerEmail: 'buyer@example.com', customerPhone: '01700000000', deliveryAddress: { address: '1 Main St', city: 'Dhaka', postcode: '1200', country: 'Bangladesh' }, items: [line], ...extra });

// Replaces methods for the duration of one test and puts them back afterwards.
async function withStubs(stubs, fn) {
  const saved = stubs.map(([target, name]) => [target, name, target[name]]);
  stubs.forEach(([target, name, impl]) => { target[name] = impl; });
  try { await fn(); } finally { saved.forEach(([target, name, original]) => { target[name] = original; }); }
}
const quiet = [console, 'error', () => {}];

// Stubs a store that accepts every order, and records what was saved.
function acceptingStore(saved = []) {
  return [
    quiet,
    [Product, 'findById', async () => ({ _id: PRODUCT_ID, title: 'Bomber', price: 100, stock: 50 })],
    [Product, 'findOneAndUpdate', async () => ({})],
    [Order, 'create', async (doc) => { saved.push(doc); return { _id: 'o' + saved.length, items: doc.items }; }],
    [SSLCommerzPayment.prototype, 'init', async () => ({ GatewayPageURL: 'https://pay.example/x' })]
  ];
}

async function rejects(payload, pattern) {
  const res = await request(app).post('/api/orders').send(payload);
  assert.equal(res.status, 400, JSON.stringify(payload).slice(0, 80));
  if (pattern) assert.match(res.body.message, pattern);
}

test('an order with more than 20 lines is rejected', async () => {
  await rejects(body({ items: Array.from({ length: 21 }, () => line) }), /at most 20/);
});

test('more than 10 of one item is rejected', async () => {
  await rejects(body({ items: [{ productId: PRODUCT_ID, quantity: 11, size: 'M' }] }), /at most 10/);
});

test('over-long name, email and phone are rejected', async () => {
  await rejects(body({ customerName: 'A'.repeat(101) }), /Name is too long/);
  await rejects(body({ customerEmail: 'a'.repeat(250) + '@b.com' }), /Invalid email/);
  await rejects(body({ customerPhone: '1'.repeat(31) }), /Invalid phone/);
  await rejects(body({ customerPhone: { $gt: '' } }), /Invalid phone/);
});

test('over-long or non-text address fields are rejected', async () => {
  await rejects(body({ deliveryAddress: { address: 'x'.repeat(201) } }), /Delivery address/);
  await rejects(body({ deliveryAddress: { postcode: '1'.repeat(21) } }), /Delivery address/);
  await rejects(body({ deliveryAddress: { city: { $ne: null } } }), /Delivery address/);
});

test('only the four address fields are stored, trimmed, and the phone is trimmed', async () => {
  const saved = [];
  await withStubs(acceptingStore(saved), async () => {
    const res = await request(app).post('/api/orders').send(body({
      customerPhone: '  01700000000  ',
      deliveryAddress: { address: ' 1 Main St ', city: 'Dhaka', postcode: '1200', country: 'Bangladesh', extra: 'ignored', $where: 'x' }
    }));
    assert.equal(res.status, 200);
  });
  assert.deepEqual(saved[0].deliveryAddress, { address: '1 Main St', city: 'Dhaka', postcode: '1200', country: 'Bangladesh' });
  assert.equal(saved[0].customerPhone, '01700000000');
});

test('reserveItems records every line it took, so a caller can release them if something else fails', async () => {
  const taken = [];
  let call = 0;
  await withStubs([[Product, 'findOneAndUpdate', async () => { if (++call === 2) throw new Error('db down'); return {}; }]], async () => {
    await assert.rejects(reserveItems([
      { productId: 'a', title: 'A', quantity: 1 },
      { productId: 'b', title: 'B', quantity: 1 }
    ], taken), /db down/);
  });
  assert.deepEqual(taken.map((l) => l.productId), ['a']);
});

process.env.EMAIL_HOST = 'smtp.test';
process.env.EMAIL_USER = 'shop@test.example';
process.env.EMAIL_PASS = 'secret';
const email = require('../services/emailService');
const EVIL = '<img src=x onerror=alert(1)>';

async function captureMail(send) {
  const sent = [];
  // emailService keeps its mail connection after first use, so load a fresh copy for every capture
  delete require.cache[require.resolve('../services/emailService')];
  await withStubs([[nodemailer, 'createTransport', () => ({ sendMail: async (m) => { sent.push(m); } })]], async () => { await send(require('../services/emailService')); });
  return sent[0];
}

const mailOrder = (status) => ({
  _id: 'o1', customerName: EVIL, customerEmail: 'a@b.com', status, totalAmount: 10, createdAt: new Date(),
  items: [{ title: '<b>Phish</b>', quantity: 1, price: 10 }]
});

test('the order confirmation email escapes the customer name and product titles', async () => {
  const mail = await captureMail((email) => email.sendOrderConfirmation(mailOrder('PLACED')));
  assert.ok(!mail.html.includes(EVIL) && !mail.html.includes('<b>Phish</b>'));
  assert.ok(mail.html.includes('&lt;img src=x onerror=alert(1)&gt;') && mail.html.includes('&lt;b&gt;Phish&lt;/b&gt;'));
});

test('the status update email escapes the customer name', async () => {
  const mail = await captureMail((email) => email.sendStatusUpdate(mailOrder('SHIPPED')));
  assert.ok(!mail.html.includes(EVIL));
  assert.ok(mail.html.includes('&lt;img'));
});

test('the verification email escapes the customer name and the link', async () => {
  const mail = await captureMail((email) => email.sendVerificationEmail({ name: EVIL, email: 'a@b.com' }, 'https://shop.test/v?token=1&x="y"'));
  assert.ok(!mail.html.includes(EVIL));
  assert.ok(mail.html.includes('&amp;x=&quot;y&quot;'));
});

// Keep this last: it uses up the order rate limit.

test('order creation is rate limited, and rejected requests do not count', async () => {
  // Rejected orders (400) do not use up the limit.
  for (let i = 0; i < 12; i++) await request(app).post('/api/orders').send({ customerName: '', items: [] });

  let accepted = 0;
  let limited = false;
  await withStubs(acceptingStore(), async () => {
    for (let i = 0; i < 30 && !limited; i++) {
      const res = await request(app).post('/api/orders').send(body());
      if (res.status === 429) limited = true; else accepted++;
    }
  });
  assert.ok(limited, 'expected a 429 after repeated accepted orders');
  assert.ok(accepted >= 5, `the limit should allow normal use first (accepted ${accepted})`);
});
