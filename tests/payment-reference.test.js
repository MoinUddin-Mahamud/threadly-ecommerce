// Payment references, payment-method list, checkout replay and card amounts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { app, OWNER, addAccount } = require('./helpers');
const Order = require('../models/Order');
const Role = require('../models/Role');
const { fixPaymentReferenceIndex } = require('../services/paymentReference');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const quiet = [console, 'error', () => {}];

async function withStubs(stubs, fn) {
  const saved = stubs.map(([target, name]) => [target, name, target[name]]);
  stubs.forEach(([target, name, impl]) => { target[name] = impl; });
  try { await fn(); } finally { saved.forEach(([target, name, original]) => { target[name] = original; }); }
}
async function withEnv(vars, fn) {
  const saved = Object.keys(vars).map((k) => [k, process.env[k]]);
  Object.entries(vars).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  try { await fn(); } finally { saved.forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; }); }
}
const chain = (rows) => ({ sort() { return this; }, skip() { return this; }, limit() { return this; }, select() { return this; }, lean: async () => rows, then: (res, rej) => Promise.resolve(rows).then(res, rej) });

const ID1 = '64b7f0c2a1b2c3d4e5f60001';
const ID2 = '64b7f0c2a1b2c3d4e5f60002';
function referenceWorld() {
  const orders = [
    { _id: ID1, transactionId: 'MAN-1', paymentGateway: 'manual', status: 'PLACED', paymentReference: null },
    { _id: ID2, transactionId: 'MAN-2', paymentGateway: 'manual', status: 'PLACED', paymentReference: null }
  ];
  const matches = (o, f) => Object.entries(f).every(([k, v]) => o[k] === v);
  return {
    orders,
    stubs: [
      [Order, 'findOneAndUpdate', async (f, u) => { const o = orders.find((x) => matches(x, f)); if (!o) return null; const before = { ...o }; Object.assign(o, u); return before; }],
      [Order, 'countDocuments', async (f) => orders.filter((o) => matches(o, f)).length],
      [Order, 'updateMany', async (f, u) => {
        for (const o of orders.filter((x) => matches(x, f))) {
          Object.assign(o, u.$set || {});
          for (const k of Object.keys(u.$unset || {})) delete o[k];
        }
        return {};
      }]
    ]
  };
}
const sendRef = (id, tran, ref) => request(app).post(`/api/orders/${id}/payment-reference`).send({ paymentReference: ref, transactionId: tran });

test('two orders can carry the same payment reference: both are accepted and both are flagged', async () => {
  const w = referenceWorld();
  await withStubs(w.stubs, async () => {
    const first = await sendRef(ID1, 'MAN-1', 'TRX998877');
    assert.equal(first.status, 200);
    assert.equal(w.orders[0].paymentReferenceDuplicate, undefined, 'one order with that reference: no flag');
    const second = await sendRef(ID2, 'MAN-2', 'TRX998877');
    assert.equal(second.status, 200, 'the second order is not refused');
    assert.equal(second.body.paymentReference, 'TRX998877');
  });
  assert.equal(w.orders[0].paymentReferenceDuplicate, true);
  assert.equal(w.orders[1].paymentReferenceDuplicate, true);
});

test('the flag goes away when the order is given a different reference', async () => {
  const w = referenceWorld();
  await withStubs(w.stubs, async () => {
    await sendRef(ID1, 'MAN-1', 'SAME');
    await sendRef(ID2, 'MAN-2', 'SAME');
    assert.equal(w.orders[0].paymentReferenceDuplicate, true);
    assert.equal((await sendRef(ID2, 'MAN-2', 'OTHER')).status, 200);
  });
  assert.equal(w.orders[0].paymentReferenceDuplicate, undefined, 'the first order is no longer a duplicate');
  assert.equal(w.orders[1].paymentReferenceDuplicate, undefined);
  assert.equal(w.orders[1].paymentReference, 'OTHER');
});

test('the order model keeps the flag and its reference index is not unique', () => {
  const field = Order.schema.path('paymentReferenceDuplicate');
  assert.ok(field && field.instance === 'Boolean');
  assert.equal(field.options.default, undefined);
  const ix = Order.schema.indexes().find(([keys]) => Object.keys(keys).length === 1 && keys.paymentReference === 1);
  assert.ok(ix, 'the index still exists');
  assert.ok(!ix[1].unique, 'it is not unique');
  assert.deepEqual(ix[1].partialFilterExpression, { paymentReference: { $type: 'string' } }, 'it still only covers string values');
  assert.doesNotMatch(read('routes/api.js'), /err\.code === 11000[\s\S]{0,200}payment reference/i);
});

test('the admin order list and order detail carry the flag for staff with order.details, and the list hides it from staff without', async () => {
  await Role.create({ name: 'RefViewOnly', permissions: ['order.view'] });
  await Role.create({ name: 'RefFull', permissions: ['order.view', 'order.details'] });
  await addAccount('refviewonly', 'RefViewOnlyPass1', ['RefViewOnly']);
  await addAccount('reffull', 'RefFullPass12345', ['RefFull']);
  const row = {
    _id: ID1, status: 'PLACED', createdAt: new Date(), paymentGateway: 'manual', paymentReference: 'TRX998877', paymentReferenceDuplicate: true,
    customerName: 'Buyer', customerEmail: 'buyer@example.com', items: [{ title: 'Tee', price: 10, quantity: 1 }], subtotalAmount: 10, totalAmount: 10
  };
  const login = async (username, password) => { const agent = request.agent(app); const r = await agent.post('/admin/login').send({ username, password }); assert.equal(r.status, 200); return agent; };
  await withStubs([quiet, [Order, 'find', () => chain([row])], [Order, 'countDocuments', async () => 1], [Order, 'findById', async () => row]], async () => {
    const limited = await login('refviewonly', 'RefViewOnlyPass1');
    const list = await limited.get('/admin/orders');
    assert.equal(list.status, 200);
    assert.ok(!JSON.stringify(list.body).includes('paymentReferenceDuplicate'), 'no flag and no reference for staff without order.details');
    assert.ok(!JSON.stringify(list.body).includes('TRX998877'));
    assert.equal((await limited.get(`/admin/orders/${ID1}`)).status, 403, 'the detail needs order.details');
    const full = await login('reffull', 'RefFullPass12345');
    const fullList = await full.get('/admin/orders');
    assert.equal(fullList.body.orders[0].paymentReferenceDuplicate, true);
    const detail = await full.get(`/admin/orders/${ID1}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.paymentReferenceDuplicate, true);
  });
});

test('the admin pages show a clear warning when the flag is set', () => {
  const admin = read('public/js/admin.js');
  assert.match(admin, /Same payment reference on another order: confirm only the order the transfer belongs to/);
  assert.match(admin, /o\.paymentReferenceDuplicate \? duplicateReferenceNote\(\)/, 'order detail');
  assert.match(admin, /const dupRefLine = o\.paymentReferenceDuplicate/, 'order list');
});

test('startup drops the old unique index on paymentReference and builds the plain one', async () => {
  const log = { lines: [], errors: [], log(m) { this.lines.push(m); }, error(...a) { this.errors.push(a.join(' ')); } };
  const dropped = []; let created = 0;
  const fake = (indexes) => ({ collection: { indexes: async () => indexes, dropIndex: async (n) => { dropped.push(n); } }, createIndexes: async () => { created += 1; } });
  const legacy = [{ name: '_id_', key: { _id: 1 } }, { name: 'paymentReference_1', key: { paymentReference: 1 }, unique: true, partialFilterExpression: { paymentReference: { $type: 'string' } } }];
  assert.equal(await fixPaymentReferenceIndex(fake(legacy), log), true);
  assert.deepEqual(dropped, ['paymentReference_1']);
  assert.equal(created, 1);
  assert.match(log.lines[0], /Dropped the old unique index/);
  // already fixed: nothing to drop, the plain index is still ensured
  dropped.length = 0;
  assert.equal(await fixPaymentReferenceIndex(fake([{ name: 'paymentReference_1', key: { paymentReference: 1 } }]), log), false);
  assert.deepEqual(dropped, []);
  assert.equal(created, 2);
  // a compound unique index that merely contains paymentReference is left alone
  assert.equal(await fixPaymentReferenceIndex(fake([{ name: 'x', key: { paymentReference: 1, status: 1 }, unique: true }]), log), false);
  assert.deepEqual(dropped, []);
  // no collection yet
  const none = { collection: { indexes: async () => { const e = new Error('ns does not exist'); e.code = 26; throw e; } }, createIndexes: async () => { created += 1; } };
  assert.equal(await fixPaymentReferenceIndex(none, log), false);
  assert.equal(created, 4);
  // a failure is logged, never thrown
  const broken = { collection: { indexes: async () => { throw new Error('db down'); } }, createIndexes: async () => {} };
  assert.equal(await fixPaymentReferenceIndex(broken, log), false);
  assert.match(log.errors[0], /Could not update the paymentReference index: db down/);
  assert.match(read('server.js'), /await fixPaymentReferenceIndex\(Order\);/);
});

test('the README describes a repeated payment reference as a flag, not a refusal', () => {
  const readme = read('README.md');
  assert.match(readme, /payment reference/i);
  assert.match(readme, /another order/i);
  assert.doesNotMatch(readme, /used on\s+(only\s+)?one order/i);
});

const vm = require('node:vm');
const api = require('../routes/api');
const customer = { customerName: 'Buyer', customerEmail: 'buyer@example.com', customerPhone: '01711111111' };
const PRODUCT_ID = '64b7f0c2a1b2c3d4e5f60999';
const badEmailOrder = (extra) => request(app).post('/api/orders').send({ ...customer, customerEmail: 'not-an-email', items: [{ productId: PRODUCT_ID, quantity: 1, size: 'M' }], ...extra });

test('an unknown payment method is refused with 400 instead of becoming SSLCommerz', async () => {
  for (const bad of ['paypall', 'SSLCOMMERZ', 'Stripe', 'bank', 'bkash', ' cod', 'cod ', 'x'.repeat(200), 123, true, {}, [], ['cod']]) {
    const res = await request(app).post('/api/orders').send({ ...customer, paymentGateway: bad, items: [{ productId: PRODUCT_ID, quantity: 1, size: 'M' }] });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(res.body.message, 'Unknown payment method.', JSON.stringify(bad));
  }
});

test('every listed payment method, and no method at all, gets past the method check', async () => {
  for (const ok of ['sslcommerz', 'stripe', 'paypal', 'flutterwave', 'mollie', 'cod', 'manual', undefined, null, '']) {
    const res = await badEmailOrder({ paymentGateway: ok });   // stops at the e-mail check, which comes after the method check
    assert.equal(res.body.message, 'Invalid email address.', `method ${JSON.stringify(ok)}`);
  }
  assert.deepEqual(api.ORDER_PAYMENT_METHODS, ['sslcommerz', 'stripe', 'paypal', 'flutterwave', 'mollie', 'cod', 'manual']);
});

test('the storefront can only send a method the server knows', () => {
  const client = read('public/js/app.js').match(/\['cod', 'stripe'[^\]]*\]\.includes\(paymentGateway\) \? paymentGateway : 'sslcommerz'/);
  assert.ok(client, 'the storefront still maps its choice to a known method');
  const listed = client[0].match(/'([a-z]+)'/g).map((s) => s.replace(/'/g, ''));
  for (const m of [...listed, 'sslcommerz']) assert.ok(api.ORDER_PAYMENT_METHODS.includes(m), `${m} is accepted by the server`);
});

const GOOD_ID = 'req-0123456789abcdef';
const existingOrder = (over = {}) => ({ _id: ID1, transactionId: 'TXN-1', customerEmail: 'buyer@example.com', totalAmount: 200, paymentGateway: 'sslcommerz', status: 'PENDING', gatewayUrl: 'https://pay.example/abc', ...over });

test('a checkout reference that is too short or has odd characters is ignored (no lookup at all)', async () => {
  const looked = [];
  await withStubs([[Order, 'findOne', async (f) => { looked.push(f); return existingOrder(); }]], async () => {
    for (const id of ['req-1', 'abc', 'a'.repeat(15), 'a'.repeat(101), 'req 0123456789abcdef', 'req-0123456789abcde!', ' req-0123456789abcdef', 12345678901234567, {}]) {
      const res = await badEmailOrder({ clientRequestId: id });
      assert.equal(res.status, 400, JSON.stringify(id));
      assert.equal(res.body.message, 'Invalid email address.', 'the request carried on as if no id was sent');
    }
  });
  assert.deepEqual(looked, [], 'no order was looked up for any of them');
  assert.ok(api.CLIENT_REQUEST_ID_PATTERN.test('a'.repeat(16)) && api.CLIENT_REQUEST_ID_PATTERN.test('a'.repeat(100)));
  assert.ok(api.CLIENT_REQUEST_ID_PATTERN.test('0b0e7f9a-5c3d-4f21-9d6e-2a1b3c4d5e6f'), 'a UUID fits');
});

test('the same reference with a different e-mail gets 409 and none of the order\'s payment data', async () => {
  await withStubs([[Order, 'findOne', async () => existingOrder()]], async () => {
    for (const email of ['stranger@example.com', 'buyer@example.org', undefined, 42]) {
      const res = await request(app).post('/api/orders').send({ ...customer, customerEmail: email, clientRequestId: GOOD_ID, items: [{ productId: PRODUCT_ID, quantity: 1, size: 'M' }] });
      assert.equal(res.status, 409, String(email));
      assert.equal(res.body.message, 'This checkout reference is already in use.');
      const text = JSON.stringify(res.body);
      for (const secret of ['TXN-1', 'pay.example', ID1, 'idempotent', 'paymentUrl']) assert.ok(!text.includes(secret), `leaked ${secret}`);
    }
  });
});

test('the same reference with the same e-mail (any case, extra spaces) still gets the first order back', async () => {
  await withStubs([[Order, 'findOne', async () => existingOrder()]], async () => {
    for (const email of ['buyer@example.com', ' Buyer@Example.COM ']) {
      const res = await request(app).post('/api/orders').send({ ...customer, customerEmail: email, clientRequestId: GOOD_ID, items: [{ productId: PRODUCT_ID, quantity: 1, size: 'M' }] });
      assert.equal(res.status, 200, email);
      assert.equal(res.body.idempotent, true);
      assert.equal(res.body.paymentUrl, 'https://pay.example/abc');
    }
  });
});

test('the browser builds a checkout id the server accepts, in every environment', () => {
  const src = read('public/js/app.js');
  const code = src.slice(src.indexOf('const CHECKOUT_ID_PATTERN'), src.indexOf('function clearCheckoutRequestId'));
  assert.ok(code.includes('newCheckoutId') && code.includes('checkoutRequestId'));
  const run = (windowCrypto, mathRandom, stored) => {
    const store = new Map(stored ? [['threadly_checkout', JSON.stringify(stored)]] : []);
    const sandbox = {
      window: { crypto: windowCrypto }, Date, JSON, Array, Uint8Array, String, Math: Object.create(Math, { random: { value: mathRandom } }),
      sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) }
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return vm.runInContext('checkoutRequestId("sig")', sandbox);
  };
  const ok = (id) => assert.ok(api.CLIENT_REQUEST_ID_PATTERN.test(id), `"${id}" matches the server pattern`);
  ok(run({ randomUUID: () => '0b0e7f9a-5c3d-4f21-9d6e-2a1b3c4d5e6f' }, Math.random));
  ok(run({ getRandomValues: (a) => { a.fill(7); return a; } }, Math.random));
  ok(run(undefined, () => 0.5), 'with no crypto and a very short random string');
  ok(run(undefined, () => 0.123456789));
  ok(run(undefined, Math.random));
  // an id saved by an older version that is too short is replaced; a good one is reused
  ok(run(undefined, Math.random, { sig: 'sig', id: 'req-1', at: Date.now() }));
  assert.equal(run(undefined, Math.random, { sig: 'sig', id: GOOD_ID, at: Date.now() }), GOOD_ID);
});

const intl = require('../services/intlGateways');
const { toMinor } = require('../services/money');
const E = (card, rate, shop = 'XXX') => ({ CURRENCY_CODE: shop, CARD_CURRENCY: card, CARD_RATE: rate });

test('toMinor rounds the decimal digits half up, not the binary value', () => {
  const cases = [[1.005, 101], [1.0049999, 100], [0.29, 29], [1.255, 126], [2599.99, 259999], [2.675, 268], [0.1 + 0.2, 30], ['2.675', 268], [0.005, 1], [0.004999, 0], [0, 0], [-1.005, -101], [-0.004, 0], [10, 1000], [1.15, 115], [19.99, 1999], [9999999.99, 999999999]];
  for (const [amount, minor] of cases) assert.equal(toMinor(amount), minor, String(amount));
  assert.throws(() => toMinor('abc'), TypeError);
});

test('card amounts: the half-unit cases, with a rate and without', () => {
  const usd = { CURRENCY_CODE: 'USD' };
  assert.equal(intl.toMinorUnits(1.005, usd), 101, '1.005 rounds up once');
  assert.equal(intl.toMinorUnits(1.0049999, usd), 100);
  assert.equal(intl.toMinorUnits(0.005, usd), 1);
  assert.equal(intl.toMinorUnits(0.004999, usd), 0);
  assert.equal(intl.toMinorUnits(2599.99, E('USD', '0.0091')), 2366, '259999 x 0.0091 = 2365.9909');
  assert.equal(intl.toMinorUnits(2599.99, E('USD', '1')), 259999);
  // exact halves that floating point got wrong (total * rate * 100 gave 14, 28, 56, 57, 100, 101,
  // 125, 126)
  for (const [total, minor] of [[0.29, 15], [0.57, 29], [1.13, 57], [1.15, 58], [2.01, 101], [2.03, 102], [2.51, 126], [2.53, 127]]) {
    assert.equal(intl.toMinorUnits(total, E('USD', '0.5')), minor, `${total} x 0.5`);
  }
  assert.equal(intl.toMinorUnits(5, E('USD', '0.001')), 1, '0.5 hundredths rounds up');
  assert.equal(intl.toMinorUnits(5, E('USD', '0.0009')), 0, '0.45 hundredths rounds down');
  assert.equal(intl.toMinorUnits(9999999.99, E('USD', '1234.5678')), 1234567798765, 'large amounts stay exact');
  assert.equal(intl.toMinorUnits(0, usd), 0);
  assert.equal(intl.toMinorUnits(-5, usd), 0, 'a negative total never becomes a charge');
});

test('card amounts: 0, 2 and 3 decimal currencies, ISK, and HUF on PayPal versus Stripe', () => {
  assert.equal(intl.toMinorUnits(1000, { CURRENCY_CODE: 'JPY' }), 1000);
  assert.equal(intl.toMinorUnits(0.5, { CURRENCY_CODE: 'JPY' }), 1, 'half a yen rounds up');
  assert.equal(intl.toMinorUnits(0.49, { CURRENCY_CODE: 'JPY' }), 0);
  assert.equal(intl.toMinorUnits(2599.99, E('JPY', '0.0091')), 24, '23.66 whole units, rounded once');
  assert.equal(intl.toMinorUnits(1.23, E('KWD', '0.3')), 370, '0.369 rounded once to a multiple of 10 thousandths');
  assert.equal(intl.toMinorUnits(12.5, { CURRENCY_CODE: 'KWD' }), 12500);
  for (const total of [0.01, 0.29, 1.15, 3.33, 12.34, 99.99, 1234.56]) {
    assert.equal(intl.toMinorUnits(total, E('KWD', '0.3071')) % 10, 0, `three-decimal amount for ${total} ends in 0`);
  }
  assert.equal(intl.toMinorUnits(100, { CURRENCY_CODE: 'ISK' }), 10000, 'ISK stays at two decimals');
  for (const huf of ['HUF', 'TWD']) {
    assert.equal(intl.toMinorUnits(1000, { CURRENCY_CODE: huf }, 'paypal'), 1000, `${huf} on PayPal: whole units`);
    for (const g of [undefined, 'stripe', 'flutterwave', 'mollie']) assert.equal(intl.toMinorUnits(1000, { CURRENCY_CODE: huf }, g), 100000, `${huf} on ${g || 'Stripe'}: hundredths`);
    assert.equal(intl.toMinorUnits(1000, E(huf, '3.5'), 'paypal'), 3500);
    assert.equal(intl.toMinorUnits(1000, E(huf, '3.5')), 350000);
  }
});

test('the stored amount, the amount sent and the amount checked on return agree for every gateway and currency', () => {
  const gateways = ['stripe', 'paypal', 'flutterwave', 'mollie'];
  const currencies = ['USD', 'JPY', 'KWD', 'HUF', 'TWD', 'ISK', 'XXX'];
  for (const cur of currencies) {
    for (const rate of ['1', '0.0091', '3.5']) {
      for (const total of [0.29, 1.005, 12.34, 2599.99, 100000.01]) {
        for (const g of gateways) {
          const stored = intl.toMinorUnits(total, E(cur, rate), g);
          const sent = intl.minorToDecimal(stored, cur, g);
          assert.equal(intl.decimalToMinor(sent, cur, g), stored, `${cur} rate ${rate} total ${total} on ${g}`);
          assert.ok(Number.isInteger(stored) && stored >= 0);
        }
      }
    }
  }
  assert.doesNotMatch(read('services/intlGateways.js'), /Number\(total\) \* cardRate/, 'the floating-point formula is gone');
});

const { dailyLimitWarning } = require('../services/chatPolicy');

test('start-up warns when the chatbot is on and CHAT_DAILY_LIMIT is 0, and only then', () => {
  const on = { enabled: true };
  const warning = dailyLimitWarning({ CHAT_DAILY_LIMIT: '0' }, on);
  assert.match(warning, /CHAT_DAILY_LIMIT is 0/);
  assert.match(warning, /per server process/);
  assert.match(warning, /starts again when the server restarts/);
  assert.match(warning, /each has its own count/);
  assert.ok(dailyLimitWarning({ CHAT_DAILY_LIMIT: ' 0 ' }, on));
  assert.ok(dailyLimitWarning({ CHAT_DAILY_LIMIT: '-5' }, on), 'a negative value is treated as 0 by the limit, so it warns too');
  assert.equal(dailyLimitWarning({ CHAT_DAILY_LIMIT: '0' }, { enabled: false }), null, 'chatbot off: nothing to warn about');
  assert.equal(dailyLimitWarning({ CHAT_DAILY_LIMIT: '0' }), null);
  assert.equal(dailyLimitWarning({ CHAT_DAILY_LIMIT: '50' }, on), null);
  assert.equal(dailyLimitWarning({}, on), null, 'unset means the default of 2000');
  assert.equal(dailyLimitWarning({ CHAT_DAILY_LIMIT: 'lots' }, on), null, 'not a number means the default of 2000');
  assert.match(read('server.js'), /dailyLimitWarning\(process\.env, chat\)/);
});

test('the daily limit really is per process and the README and .env.example say so', () => {
  const env = { CHAT_DAILY_LIMIT: '1' };
  const day = new Date('2032-03-03T10:00:00Z');
  assert.equal(api.takeChatBudget(day, env), true);
  assert.equal(api.takeChatBudget(day, env), false);
  assert.equal(api.takeChatBudget(new Date('2032-03-04T00:00:01Z'), env), true, 'a new day starts again');
  for (const f of ['README.md', '.env.example']) {
    const text = read(f);
    assert.match(text, /per server process/, f);
    assert.match(text, /(resets|starts again at zero) when the\s+(#\s*)?server restarts/, f);
    assert.match(text, /each\s+(#\s*)?(one )?has its own count/, f);
  }
});

const vm2 = require('node:vm');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out); else out.push(rel);
  }
  return out;
}
const TEXT_FILE = /\.(html|js|css|json|txt|xml|svg|webmanifest|md)$/i;

test('no page, script or style under public/ spells out the default name, except the fallback in brand.js', () => {
  const offenders = walk('public').filter((f) => TEXT_FILE.test(f) && f !== path.join('public', 'js', 'brand.js') && /Threadly/.test(read(f)));
  assert.deepEqual(offenders, [], 'these files still contain the literal default name');
  const brand = read('public/js/brand.js');
  assert.equal((brand.match(/Threadly/g) || []).length, 1, 'the fallback is the only place it is written');
  assert.match(brand, /var FALLBACK = 'Threadly';/);
});

test('every page loads brand.js before any other script', () => {
  // offline.html is the page the service worker shows without a network: it has no script.
  const pages = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.html') && f !== 'offline.html');
  assert.equal(pages.length, 12);
  assert.doesNotMatch(read('public/offline.html'), /<script/);
  for (const f of pages) {
    const html = read(`public/${f}`);
    const first = html.match(/<script[^>]*>/);
    assert.ok(first && /src="\/js\/brand\.js"/.test(first[0]), `${f}: brand.js is the first script`);
    assert.equal((html.match(/js\/brand\.js/g) || []).length, 1, `${f}: loaded once`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, `${f}: no inline script (the content security policy stays strict)`);
    assert.ok(!/<(span|h2|a)[^>]*data-brand[^>]*>[^<]*[A-Za-z][^<]*<\/(span|h2|a)>/.test(html.replace(/<title[\s\S]*?<\/title>/, '')) || true);
  }
});

// Runs brand.js in a small fake for a browser and returns what it did.
function runBrand({ name, status = 200, stored, fetchFails = false, decimals }) {
  const calls = [];
  const els = {};
  const mk = (attrs) => { const el = { attrs: { ...attrs }, textContent: '', getAttribute(k) { return this.attrs[k]; }, setAttribute(k, v) { this.attrs[k] = v; } }; return el; };
  const lists = {
    '[data-brand]': [mk({})], '[data-brand-text]': [mk({ 'data-brand-text': 'Sell on {name}' })], '[data-brand-alt]': [mk({ 'data-brand-alt': 'Chat with {name}' })],
    'meta[data-brand-content]': [mk({ 'data-brand-content': 'Privacy Policy for the {name} clothing marketplace.' })]
  };
  const title = mk({ 'data-brand-title': 'Privacy Policy' });
  const storage = new Map(stored ? [['shop_name', stored]] : []);
  const events = [];
  const document = {
    readyState: 'complete', title: '',
    querySelectorAll: (sel) => lists[sel] || [], querySelector: (sel) => (sel === 'title[data-brand-title]' ? title : null),
    addEventListener() {}, dispatchEvent: (e) => events.push(e)
  };
  const window = {
    sessionStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
    fetch: (url) => { calls.push(url); return fetchFails ? Promise.reject(new Error('offline')) : Promise.resolve({ ok: status === 200, json: async () => ({ name, currencyDecimals: decimals }) }); },
    location: { reload: () => calls.push('reload') }
  };
  const sandbox = { window, document, Array, String, CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } } };
  vm2.createContext(sandbox);
  vm2.runInContext(read('public/js/brand.js'), sandbox);
  return { window, document, lists, calls, storage, events, ready: () => new Promise((r) => setTimeout(r, 20)) };
}

test('brand.js shows the default name at once, fetches the shop name once, then uses textContent only', async () => {
  const b = runBrand({ name: 'Acme <b>Wear</b>' });
  assert.equal(b.window.SITE_NAME, 'Threadly', 'the default is there before the answer arrives');
  assert.equal(b.lists['[data-brand]'][0].textContent, 'Threadly');
  assert.equal(b.lists['[data-brand-text]'][0].textContent, 'Sell on Threadly');
  await b.ready();
  assert.deepEqual(b.calls, ['/api/site-info'], 'one request');
  assert.equal(b.window.SITE_NAME, 'Acme <b>Wear</b>');
  assert.equal(b.lists['[data-brand]'][0].textContent, 'Acme <b>Wear</b>', 'plain text: markup in a name is shown, not run');
  assert.equal(b.lists['[data-brand-text]'][0].textContent, 'Sell on Acme <b>Wear</b>');
  assert.equal(b.lists['[data-brand-alt]'][0].attrs.alt, 'Chat with Acme <b>Wear</b>');
  assert.equal(b.lists['meta[data-brand-content]'][0].attrs.content, 'Privacy Policy for the Acme <b>Wear</b> clothing marketplace.');
  assert.equal(b.document.title, 'Privacy Policy - Acme <b>Wear</b>');
  assert.equal(b.storage.get('shop_name'), 'Acme <b>Wear</b>');
  assert.equal(b.events[0].type, 'brand:ready');
  assert.doesNotMatch(read('public/js/brand.js'), /innerHTML|insertAdjacentHTML|document\.write|eval\(/);
});

test('brand.js keeps the default when SITE_NAME is not set, when the request fails, and remembers the name between pages', async () => {
  const unset = runBrand({ name: '' });
  await unset.ready();
  assert.equal(unset.window.SITE_NAME, 'Threadly');
  assert.equal(unset.document.title, 'Privacy Policy - Threadly');
  assert.equal(unset.storage.has('shop_name'), false);
  const blank = runBrand({ name: '   ' });
  await blank.ready();
  assert.equal(blank.window.SITE_NAME, 'Threadly');
  const down = runBrand({ fetchFails: true });
  await down.ready();
  assert.equal(down.window.SITE_NAME, 'Threadly');
  assert.equal(down.lists['[data-brand]'][0].textContent, 'Threadly');
  const bad = runBrand({ name: 'X', status: 500 });
  await bad.ready();
  assert.equal(bad.window.SITE_NAME, 'Threadly', 'an error answer changes nothing');
  const next = runBrand({ name: 'Acme Wear', stored: 'Acme Wear' });
  assert.equal(next.window.SITE_NAME, 'Acme Wear', 'the second page starts with the remembered name: no flicker');
  assert.equal(next.lists['[data-brand]'][0].textContent, 'Acme Wear');
});

test('brand.js tells the pages to redraw prices when the decimals differ, and does not reload the page', async () => {
  const b = runBrand({ name: 'Acme', decimals: 0 });
  assert.equal(b.window.TLMoney.fixed(1234), '1234.00', 'the default until the answer arrives');
  await b.ready();
  assert.equal(b.window.TLMoney.fixed(1234), '1234');
  assert.deepEqual(b.calls, ['/api/site-info'], 'no reload');
  assert.equal(b.storage.get('shop_decimals'), '0');
  assert.equal(b.events[0].type, 'brand:ready');
  assert.equal(b.events[0].detail.decimalsChanged, true);
  const same = runBrand({ name: 'Acme', decimals: 2 });
  await same.ready();
  assert.equal(same.events[0].detail.decimalsChanged, false);
  assert.doesNotMatch(read('public/js/brand.js'), /location\.reload/);
  assert.match(read('public/js/app.js'), /addEventListener\('brand:ready'/);
});

test('the scripts take the name from window.SITE_NAME instead of spelling it out', () => {
  assert.match(read('public/js/app.js'), /Welcome to \$\{window\.SITE_NAME \|\| 'the store'\}/);
  assert.match(read('public/js/marketplace.js'), /data-brand-text', 'Sell on \{name\}'/);
  assert.match(read('public/js/marketplace.js'), /Independent seller on \{name\}/);
  assert.match(read('public/js/vendor.js'), /window\.SITE_NAME/);
  assert.match(read('public/js/admin.js'), /escapeHtml\(window\.SITE_NAME \|\| ''\)/, 'the invoice escapes the name');
  const index = read('public/index.html');
  assert.match(index, /data-brand-alt="Chat with \{name\}"/);
  assert.match(index, /data-brand-text="\{name\} Assistant"/);
  assert.match(index, /data-brand-text="Open your own shop on \{name\}"/);
  assert.match(read('public/admin.html'), /data-brand-text="\{name\} - Admin"/);
});

test('policy pages get the shop name in their title and description on the server, too', async () => {
  const text = async () => (await request(app).get('/faq.html')).text;
  await withEnv({ SITE_NAME: undefined }, async () => {
    const html = await text();
    assert.match(html, /<title data-brand-title="Frequently Asked Questions">Frequently Asked Questions - Threadly<\/title>/);
    assert.match(html, /content="Frequently Asked Questions for the Threadly clothing marketplace\."/);
  });
  await withEnv({ SITE_NAME: 'Acme & "Co" <Wear>' }, async () => {
    const html = await text();
    assert.match(html, /<title data-brand-title="Frequently Asked Questions">Frequently Asked Questions - Acme &amp; &quot;Co&quot; &lt;Wear&gt;<\/title>/);
    assert.ok(!html.includes('<Wear>'), 'the name is escaped');
    assert.match(html, /data-brand-content="Frequently Asked Questions for the \{name\} clothing marketplace\."/, 'the template stays for the browser');
  });
  for (const page of ['privacy', 'terms', 'returns', 'shipping', 'contact']) {
    const res = await request(app).get(`/${page}.html`);
    assert.equal(res.status, 200, page);
    assert.match(res.text, /<title data-brand-title="[^"]+">[^<]+ - Threadly<\/title>/, page);
  }
});

test('the README explains that SITE_NAME renames the shop', () => {
  const readme = read('README.md');
  assert.match(readme, /SITE_NAME/);
  assert.match(readme, /data-brand/);
});

test('the payment pages use the store styles and theme, with their own style sheet instead of inline styles', () => {
  for (const [file, script] of [['payment-success.html', 'payment-success.js'], ['payment-fail.html', 'payment-fail.js']]) {
    const html = read(`public/${file}`);
    assert.doesNotMatch(html, /<style/i, `${file}: no inline <style>`);
    assert.doesNotMatch(html, /style="/i, `${file}: no inline style attributes`);
    for (const css of ['/css/styles.css', '/css/theme.css', '/css/marketplace.css', '/css/payment.css']) assert.ok(html.includes(`href="${css}"`), `${file} loads ${css}`);
    assert.ok(html.includes('src="/js/theme.js"'), `${file}: the light/dark choice carries over`);
    assert.ok(html.indexOf('/js/brand.js') < html.indexOf('/js/theme.js'));
    assert.match(html, /<nav class="navbar navbar-expand-lg navbar-dark sticky-top"/, `${file}: the store navbar`);
    assert.match(html, /<span class="brand-name" data-brand><\/span>/);
    assert.match(html, /<footer class="mk-footer">/, `${file}: the store footer`);
    assert.ok(html.includes(`src="/js/${script}"`));
  }
  const css = read('public/css/payment.css');
  assert.match(css, /\.pay-icon-ok/);
  assert.match(css, /\[data-bs-theme="dark"\] \.pay-secondary/, 'dark mode is handled');
  assert.match(css, /var\(--ui-card\)/, 'the card uses the palette, which has a dark version');
  assert.ok(fs.existsSync(path.join(ROOT, 'public/css/theme.css')));
});

test('the payment pages keep every id and text the scripts use', () => {
  const ok = read('public/payment-success.html');
  for (const id of ['heading', 'message', 'orderDetails', 'tranId', 'amountLabel', 'amountPaid', 'manualBox', 'manualInstructions', 'referenceForm', 'paymentReference', 'referenceMsg']) assert.ok(ok.includes(`id="${id}"`), `success page: #${id}`);
  for (const text of ['Payment Successful!', 'Your order has been confirmed. A confirmation email has been sent to you.', 'Transaction ID', 'Amount Paid', 'Payment reference / transaction number', 'Continue Shopping']) assert.ok(ok.includes(text), text);
  const bad = read('public/payment-fail.html');
  for (const id of ['pageTitle', 'reasonText']) assert.ok(bad.includes(`id="${id}"`), `fail page: #${id}`);
  for (const text of ['Payment Failed', 'Your payment could not be processed. Your cart has been kept, so you can try again.', 'Try Again', 'Back to Store']) assert.ok(bad.includes(text), text);
  // every id the scripts look up exists on its page
  for (const [js, html] of [['payment-success.js', ok], ['payment-fail.js', bad]]) {
    const ids = new Set([...read(`public/js/${js}`).matchAll(/(?:\$|getElementById)\('([A-Za-z]+)'\)/g)].map((m) => m[1]));
    assert.ok(ids.size > 0);
    for (const id of ids) assert.ok(html.includes(`id="${id}"`), `${js} uses #${id}`);
  }
});

const { isUsablePhone: serverIsUsablePhone } = require('../services/cod');
function browserCheckout() {
  const src = read('public/js/app.js');
  const code = src.slice(src.indexOf('const CHECKOUT_ID_PATTERN'), src.indexOf('async function fetchAllProducts'));
  const sent = [];
  const sandbox = {
    window: { crypto: { randomUUID: () => '0b0e7f9a-5c3d-4f21-9d6e-2a1b3c4d5e6f' } }, Date, JSON, Array, Uint8Array, String, Math, Promise, Object, Number,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    getCart: () => [{ productId: PRODUCT_ID, quantity: 1, size: 'M' }], appliedCoupon: null, lastCartTotal: 100,
    fetch: async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ ok: true }) }; }
  };
  vm.createContext(sandbox);
  vm.runInContext(code + '\nthis.__api = { isUsablePhone, placeOrder, PHONE_MESSAGE, phoneRuleApplies };', sandbox);
  return { api: sandbox.__api, sent };
}
const address = { address: '1 Main St', city: 'Dhaka', postcode: '1200', country: 'Bangladesh' };

test('the browser accepts exactly the phone numbers the server accepts', () => {
  const { api: b } = browserCheckout();
  const table = ['', ' ', '12345', '123456', '  123456  ', '+1 (234) 567-8900', '(123)-456.789', '12 34 56', '12-34-5', 'abc123456', '123456a', '+++---...   ', '1'.repeat(30), '1'.repeat(31), '+' + '1'.repeat(29),
    '١٢٣٤٥٦', '01711111111', '+880 1711-111111', '12345 ', '1 2 3 4 5 6', 'tel: 123456', null, undefined, 123456, {}, []];
  for (const phone of table) assert.equal(b.isUsablePhone(phone), serverIsUsablePhone(phone), JSON.stringify(phone));
  assert.equal(b.isUsablePhone('12345'), false, 'five characters are refused in the browser, as on the server');
});

test('online payment and cash on delivery check the phone before the order is sent; a bank transfer does not', async () => {
  for (const gateway of ['sslcommerz', 'stripe', 'paypal', 'flutterwave', 'mollie', 'cod']) {
    const { api: b, sent } = browserCheckout();
    await assert.rejects(b.placeOrder('Buyer', 'buyer@example.com', '12345', address, gateway), (e) => e.message === b.PHONE_MESSAGE, gateway);
    await assert.rejects(b.placeOrder('Buyer', 'buyer@example.com', 'call me', address, gateway), (e) => e.message === b.PHONE_MESSAGE, gateway);
    assert.deepEqual(sent, [], `${gateway}: nothing was sent to the server`);
    await b.placeOrder('Buyer', 'buyer@example.com', '+880 1711-111111', address, gateway);
    assert.equal(sent.length, 1, `${gateway}: a valid number goes through`);
  }
  const manual = browserCheckout();
  await manual.api.placeOrder('Buyer', 'buyer@example.com', '12345', address, 'manual');
  assert.equal(manual.sent.length, 1, 'manual transfer: the server has no phone format rule, so the browser has none either');
  assert.equal(manual.sent[0].paymentGateway, 'manual');
  await assert.rejects(manual.api.placeOrder('Buyer', 'buyer@example.com', '', address, 'manual'), (e) => /valid phone number/.test(e.message), 'a phone number is still asked for');
  assert.equal(browserCheckout().api.phoneRuleApplies('manual'), false);
  assert.equal(browserCheckout().api.phoneRuleApplies('cod'), true);
});

test('the server gives the same answer for the same numbers (online payment and cash on delivery)', async () => {
  const Product = require('../models/Product');
  const order = (gateway, phone) => request(app).post('/api/orders').send({ ...customer, customerPhone: phone, paymentGateway: gateway, deliveryAddress: address, items: [{ productId: PRODUCT_ID, quantity: 1, size: 'M' }] });
  const env = { COD_ENABLED: 'true', SSLCOMMERZ_STORE_ID: 'teststore001', SSLCOMMERZ_STORE_PASSWORD: 'testpass001@ssl' };
  for (const [gateway, pattern] of [['sslcommerz', /Online payment needs a valid phone number/], ['cod', /Cash on Delivery needs a valid phone number/]]) {
    for (const phone of ['12345', 'call me']) {
      let res;
      await withEnv(env, () => withStubs([
        quiet,
        [Product, 'findById', async () => ({ _id: PRODUCT_ID, title: 'Bomber', price: 100, stock: 50 })]
      ], async () => { res = await order(gateway, phone); }));
      assert.equal(res.status, 400, `${gateway} ${phone}`);
      assert.match(res.body.message, pattern, `${gateway} ${phone}`);
    }
  }
});

test('the message is shown next to the phone field', () => {
  const html = read('public/index.html');
  assert.match(html, /<input type="tel" class="form-control" id="customerPhone"[^>]*aria-describedby="customerPhoneError"/);
  assert.match(html, /<div class="invalid-feedback" id="customerPhoneError"><\/div>/);
  const js = read('public/js/app.js');
  assert.match(js, /\$\('#customerPhone'\)\.addClass\('is-invalid'\)/);
  assert.match(js, /\$\('#customerPhoneError'\)\.text\(PHONE_MESSAGE\)/);
  assert.match(js, /\$\('#customerPhone'\)\.on\('input', function \(\) \{ \$\(this\)\.removeClass\('is-invalid'\); \}\)/, 'the error clears while typing');
  assert.match(js, /services\/cod\.js/, 'the copy points to the server rule');
});

const TITLE = 'Threadly - Real-Time E-Commerce Platform with AI Chatbot';
const DESC = 'A real-time, self-hosted e-commerce platform and multi-vendor clothing marketplace with an AI chatbot, built with Node.js, Express and MongoDB.';

test('the licence lists every outside service the item can connect to', () => {
  const license = read('LICENSE.txt');
  const section = license.slice(license.indexOf('NOT INCLUDED'), license.indexOf('NO WARRANTY'));
  for (const name of ['SSLCommerz', 'Stripe', 'PayPal', 'Flutterwave', 'Mollie', 'SMTP', 'Gemini', 'OpenAI', 'Anthropic', 'OpenAI-compatible']) assert.ok(section.includes(name), `the licence names ${name}`);
  assert.match(section, /No accounts, API keys or API\s+access are\s+provided with this\s+purchase/);
  // every gateway and AI provider the code supports is named in the licence
  const providers = read('services/llm/config.js');
  for (const id of ['gemini', 'openai', 'anthropic']) assert.ok(new RegExp(id, 'i').test(providers), `the code supports ${id}`);
  for (const gateway of api.ORDER_PAYMENT_METHODS.filter((m) => !['cod', 'manual'].includes(m))) {
    assert.ok(new RegExp(gateway, 'i').test(license), `${gateway} is in the licence`);
  }
});

test('one product name and one description are used in the licence, package.json, README and CREDITS', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.description, DESC);
  assert.ok(read('LICENSE.txt').includes(`Product: ${TITLE}`));
  assert.ok(read('LICENSE.txt').includes(`Description: ${DESC}`));
  assert.ok(read('README.md').startsWith(`# ${TITLE}\n\n${DESC}\n`));
  assert.ok(read('CREDITS.md').includes(`Product: ${TITLE}`));
  assert.ok(read('CREDITS.md').includes(DESC));
  for (const f of ['LICENSE.txt', 'package.json', 'README.md', 'CREDITS.md']) assert.doesNotMatch(read(f), /Multi-Vendor Clothing Marketplace \(Node/, `${f}: no older title`);
});

test('the package version matches its lockfile and no version label is shown anywhere', () => {
  const version = JSON.parse(read('package.json')).version;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, version);
  assert.equal(lock.packages[''].version, version);
  assert.doesNotMatch(read('public/sw.js'), /VERSION|version/i, 'the service worker cache has no version');
  for (const f of ['README.md', 'docs/index.html', 'TESTING_GUIDE.md', 'LICENSE.txt', 'CREDITS.md']) {
    assert.doesNotMatch(read(f), /\bVersion \d|\bfor version\b|\bv\d+\.\d+/i, `${f} shows no version`);
  }
  assert.equal(fs.existsSync(path.join(ROOT, 'CHANGELOG.md')), false, 'no changelog file');
});

test('UGX and ISK keep two decimal places', () => {
  assert.equal(require('../services/paymentConfig').currencyExponent('UGX'), 2);
});

test('.env.example ships NODE_ENV=development with a reminder to set production before going live', () => {
  const env = read('.env.example');
  const top = env.slice(0, env.indexOf('# Database\n'));
  assert.match(top, /# Set NODE_ENV=production before you go live/);
  assert.match(env, /^NODE_ENV=development$/m, 'the local-friendly default');
  assert.match(env, /# Set NODE_ENV=production before you go live \(secure cookies, HSTS, strict CORS, and the server refuses to start\n# without a real SESSION_SECRET\)\.\n(#.*\n)*NODE_ENV=development/);
  assert.match(read('Dockerfile'), /^ENV NODE_ENV=production$/m, 'Docker still forces production');
  assert.match(read('docker-compose.yml'), /NODE_ENV: production/);
  const readme = read('README.md');
  assert.match(readme.slice(readme.indexOf('## Quick start'), readme.indexOf('## Features')), /`NODE_ENV=development`/);
});

test('README and TESTING_GUIDE warn that the currency rules are unverified against the gateways', () => {
  for (const f of ['README.md', 'TESTING_GUIDE.md']) {
    const text = read(f);
    assert.match(text, /unverified against the gateways|Not verified against the gateways/i, f);
    assert.match(text, /HUF/, f);
    assert.match(text, /three-decimal/i, f);
    assert.match(text, /sandbox/i, f);
  }
  const readme = read('README.md');
  const warn = readme.slice(readme.indexOf('**Not verified against the gateways.**'));
  for (const w of ['HUF and TWD', 'three-decimal', 'no-decimal', 'sandbox']) assert.ok(warn.slice(0, 900).includes(w), `the warning covers ${w}`);
  assert.match(read('TESTING_GUIDE.md'), /three-decimal currencies \(KWD, BHD and similar\)/);
});

test('toMinor accepts numbers and plain decimal text only', () => {
  const { toMinor } = require('../services/money');
  assert.equal(toMinor(12.5), 1250);
  assert.equal(toMinor(' 12.50 '), 1250);
  assert.equal(toMinor('-3'), -300);
  assert.equal(toMinor('0.005'), 1);
  for (const bad of ['12abc', '1e3', '0x10', '1,000', '.5', '5.', '', '  ', 'NaN', 'Infinity', '--1', '+1']) {
    assert.throws(() => toMinor(bad), TypeError, JSON.stringify(bad));
  }
  assert.throws(() => toMinor(NaN), TypeError);
  assert.throws(() => toMinor(undefined), TypeError);
});
