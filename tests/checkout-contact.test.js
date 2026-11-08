// Online payment needs a phone and a full address; nothing made up is sent to the gateway.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const SSLCommerzPayment = require('sslcommerz-lts');
const { app } = require('./helpers');
const Order = require('../models/Order');
const Product = require('../models/Product');
const api = require('../routes/api');
const { chain } = require('./fakeDb');

const PRODUCT_ID = '64b7f0c2a1b2c3d4e5f60999';
const line = { productId: PRODUCT_ID, quantity: 1, size: 'M' };
const full = { address: '1 Main St', city: 'Dhaka', postcode: '1200', country: 'Bangladesh' };
const body = (extra = {}) => ({ customerName: 'Buyer', customerEmail: 'buyer@example.com', customerPhone: '01700000000', deliveryAddress: full, items: [line], ...extra });

async function withStubs(stubs, fn) {
  const saved = stubs.map(([target, name]) => [target, name, target[name]]);
  stubs.forEach(([target, name, impl]) => { target[name] = impl; });
  try { await fn(); } finally { saved.forEach(([target, name, original]) => { target[name] = original; }); }
}
const quiet = [console, 'error', () => {}];
function store(created, initData, product = {}) {
  return [
    quiet,
    [Product, 'findById', async () => ({ _id: PRODUCT_ID, title: 'Bomber', price: 100, stock: 50, ...product })],
    [Product, 'findOneAndUpdate', async () => ({})],
    [Order, 'create', async (doc) => { created.push(doc); return { _id: 'o' + created.length, items: doc.items }; }],
    [SSLCommerzPayment.prototype, 'init', async (data) => { initData.push(data); return { GatewayPageURL: 'https://pay.example/x' }; }]
  ];
}

test('online payment is refused without a usable phone or without a full address, and nothing is saved', async () => {
  const bad = [
    body({ customerPhone: '' }), body({ customerPhone: 'call me' }),
    body({ deliveryAddress: { ...full, address: '' } }), body({ deliveryAddress: { ...full, city: '' } }),
    body({ deliveryAddress: { ...full, postcode: '' } }), body({ deliveryAddress: { ...full, country: '' } }),
    body({ deliveryAddress: undefined })
  ];
  const created = []; const initData = [];
  await withStubs(store(created, initData), async () => {
    for (const payload of bad) {
      const res = await request(app).post('/api/orders').send(payload);
      assert.equal(res.status, 400, JSON.stringify(payload).slice(0, 120));
      assert.match(res.body.message, /phone number and a full delivery address|Invalid phone|Delivery address/);
    }
  });
  assert.equal(created.length, 0);
  assert.equal(initData.length, 0);
});

test('SSLCommerz receives the customer\'s own phone and address, never a placeholder', async () => {
  const created = []; const initData = [];
  await withStubs(store(created, initData), async () => {
    const res = await request(app).post('/api/orders').send(body());
    assert.equal(res.status, 200);
  });
  assert.equal(initData.length, 1);
  const d = initData[0];
  assert.equal(d.cus_phone, '01700000000');
  assert.equal(d.cus_add1, '1 Main St');
  assert.equal(d.cus_city, 'Dhaka');
  assert.equal(d.cus_postcode, '1200');
  assert.equal(d.cus_country, 'Bangladesh');
  assert.ok(!/null|undefined/.test(d.product_name));
});

test('the manual-payment reference route has its own rate limiter', () => {
  assert.equal(typeof api.paymentReferenceLimiter, 'function');
  const layers = api.stack.filter((l) => l.route && l.route.path === '/orders/:id/payment-reference');
  assert.equal(layers.length, 1);
  assert.ok(layers[0].route.stack.some((s) => s.handle === api.paymentReferenceLimiter));
});

test('chat-status reports the chatbot as off without a key, and /api/chat answers 503', async () => {
  const keys = ['CHAT_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CHAT_PROVIDER', 'CHAT_ENABLED'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  keys.forEach((k) => delete process.env[k]);
  try {
    const status = await request(app).get('/api/chat-status');
    assert.equal(status.status, 200);
    assert.equal(status.body.enabled, false);
    const chat = await request(app).post('/api/chat').send({ message: 'Hello' });
    assert.equal(chat.status, 503);
    assert.equal(chat.body.chatEnabled, false);
  } finally {
    keys.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  }
});

test('chat-status says on when a key is set and CHAT_ENABLED=false turns it off', async () => {
  const names = ['CHAT_API_KEY', 'CHAT_PROVIDER', 'CHAT_ENABLED', 'CHAT_MODEL'];
  const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  try {
    // OpenAI has no built-in default model (names change too often), so CHAT_MODEL is required with it.
    process.env.CHAT_PROVIDER = 'openai'; process.env.CHAT_API_KEY = 'sk-test-key-not-real'; delete process.env.CHAT_ENABLED; delete process.env.CHAT_MODEL;
    assert.equal((await request(app).get('/api/chat-status')).body.enabled, false, 'a key without a model is off, with a clear reason from chatConfig');
    assert.match(require('../services/llm/config').chatConfig().reason, /CHAT_MODEL is required for openai/);
    process.env.CHAT_MODEL = 'example-model-1';
    assert.equal((await request(app).get('/api/chat-status')).body.enabled, true);
    process.env.CHAT_ENABLED = 'false';
    assert.equal((await request(app).get('/api/chat-status')).body.enabled, false);
  } finally {
    for (const k of names) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test('a visitor without a session gets a small chat cookie, not a session, to keep chat history', async () => {
  const names = ['CHAT_API_KEY', 'CHAT_PROVIDER', 'CHAT_ENABLED', 'CHAT_MODEL'];
  const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  const realFetch = global.fetch;
  const realFind = Product.find;
  try {
    Product.find = () => chain([]);
    process.env.CHAT_PROVIDER = 'openai'; process.env.CHAT_API_KEY = 'sk-test-key-not-real'; process.env.CHAT_MODEL = 'example-model-1'; delete process.env.CHAT_ENABLED;
    global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '', json: async () => ({ choices: [{ message: { content: 'Hello there' } }] }) });
    const res = await request(app).post('/api/chat').send({ message: 'Hi' });
    assert.equal(res.status, 200);
    assert.equal(res.body.reply, 'Hello there');
    const cookies = [].concat(res.headers['set-cookie'] || []);
    assert.ok(!cookies.some((c) => /^connect\.sid=/.test(c)), 'no session is started');
    assert.ok(cookies.some((c) => /^tl_chat=[a-f0-9]{32};.*HttpOnly/i.test(c)), 'the chat cookie is random and HttpOnly');
    assert.ok(cookies.every((c) => /Path=\/api\/chat/.test(c)), 'and only sent to the chat route');
  } finally {
    global.fetch = realFetch;
    Product.find = realFind;
    for (const k of names) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});
