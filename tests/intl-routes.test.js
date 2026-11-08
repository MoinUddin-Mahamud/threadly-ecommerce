// Tests for PayPal, Flutterwave and Mollie at checkout and when the customer comes
// back. The database models and the payment gateways are replaced by fakes, so no
// database, account or internet connection is needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { app } = require('./helpers');
const Order = require('../models/Order');
const Product = require('../models/Product');
const emailService = require('../services/emailService');
const intl = require('../services/intlGateways');
const { settleIntlPayment } = require('../routes/api');

const ROOT = path.join(__dirname, '..');
const PRODUCT_ID = '64b7f0c2a1b2c3d4e5f60999';
const ORDER_ID = '64b7f0c2a1b2c3d4e5f60718';
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

// Replaces fetch (what the gateways are called with). [urlPart, status, body] per reply.
async function withFetch(replies, fn) {
  const calls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body });
    const hit = replies.find(([m]) => String(url).includes(m));
    if (!hit) throw new Error(`unexpected request to ${url}`);
    const [, status, body] = hit;
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  };
  try { await fn(calls); } finally { globalThis.fetch = saved; }
}

const KEYS = {
  paypal:      { PAYPAL_CLIENT_ID: 'client-id-123', PAYPAL_CLIENT_SECRET: 'secret-456' },
  flutterwave: { FLUTTERWAVE_SECRET_KEY: 'FLWSECK_TEST-abc123' },
  mollie:      { MOLLIE_API_KEY: 'test_abcdefghijklmnopqrstuvwxyz1234' }
};
const NO_KEYS = {
  PAYPAL_CLIENT_ID: undefined, PAYPAL_CLIENT_SECRET: undefined,
  FLUTTERWAVE_SECRET_KEY: undefined, FLUTTERWAVE_WEBHOOK_HASH: undefined, MOLLIE_API_KEY: undefined
};
const withKeys = (gateway, fn) => withEnv({ ...NO_KEYS, ...KEYS[gateway], CARD_RATE: '0.01' }, fn);

const address = { address: '1 Main St', city: 'Dhaka', postcode: '1200', country: 'Bangladesh' };
const checkoutBody = (gateway, extra = {}) => ({
  customerName: 'Buyer', customerEmail: 'buyer@example.com', customerPhone: '01700000000',
  deliveryAddress: address, paymentGateway: gateway,
  items: [{ productId: PRODUCT_ID, quantity: 1, size: 'M' }], ...extra
});

// A shop with one shirt that costs `price`; records what happened.
function shop(log, price = 100) {
  Object.assign(log, { reserved: 0, restocked: 0, created: [], updates: [], cancels: 0 });
  return [
    quiet,
    [Product, 'findById', async () => ({ _id: PRODUCT_ID, title: 'Bomber', price, stock: 50 })],
    [Product, 'findOneAndUpdate', async () => { log.reserved++; return {}; }],
    [Product, 'updateOne', async () => { log.restocked++; return {}; }],
    [Order, 'create', async (doc) => { log.created.push(doc); return { _id: ORDER_ID, ...doc }; }],
    [Order, 'updateOne', async (f, u) => { log.updates.push([f, u]); return {}; }]
  ];
}

const GATEWAY_REPLIES = {
  paypal: [
    ['/v1/oauth2/token', 200, { access_token: 'T' }],
    ['/v2/checkout/orders', 201, { id: 'PAYPALORDER123', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=PAYPALORDER123' }] }]
  ],
  flutterwave: [['/v3/payments', 200, { status: 'success', data: { link: 'https://checkout.flutterwave.com/v3/hosted/pay/flwlnk-1' } }]],
  mollie: [['/v2/payments', 201, { id: 'tr_test123', _links: { checkout: { href: 'https://www.mollie.com/checkout/test123' } } }]]
};

test('/api/payment-options lists PayPal, Flutterwave and Mollie only when they are set up', async () => {
  await withEnv(NO_KEYS, async () => {
    const body = (await request(app).get('/api/payment-options')).body;
    for (const g of intl.INTL_GATEWAYS) assert.equal(body[g].enabled, false, g);
  });
  for (const g of intl.INTL_GATEWAYS) {
    await withKeys(g, async () => {
      const body = (await request(app).get('/api/payment-options')).body;
      assert.equal(body[g].enabled, true, g);
      for (const other of intl.INTL_GATEWAYS.filter((x) => x !== g)) assert.equal(body[other].enabled, false, `${other} while only ${g} is set`);
    });
  }
  await withEnv({ ...NO_KEYS, PAYPAL_CLIENT_ID: 'your-paypal-client-id', PAYPAL_CLIENT_SECRET: 'your-paypal-client-secret' }, async () => {
    assert.equal((await request(app).get('/api/payment-options')).body.paypal.enabled, false);   // the .env.example values do not count
  });
});

test('an order for a gateway that is not set up is refused before any stock is taken', async () => {
  for (const g of intl.INTL_GATEWAYS) {
    const log = {};
    await withEnv(NO_KEYS, async () => {
      await withStubs(shop(log), async () => {
        const res = await request(app).post('/api/orders').send(checkoutBody(g));
        assert.equal(res.status, 400, g);
        assert.match(res.body.message, /not configured/i);
      });
    });
    assert.equal(log.reserved, 0, g);
    assert.equal(log.created.length, 0, g);
  }
});

test('a PayPal, Flutterwave or Mollie order reserves stock, stays PENDING and goes to the gateway page', async () => {
  const expectedRef = { paypal: 'PAYPALORDER123', flutterwave: null, mollie: 'tr_test123' };
  for (const g of intl.INTL_GATEWAYS) {
    const log = {};
    await withKeys(g, async () => {
      await withStubs(shop(log), async () => {
        await withFetch(GATEWAY_REPLIES[g], async (calls) => {
          const res = await request(app).post('/api/orders').send(checkoutBody(g));
          assert.equal(res.status, 200, `${g}: ${JSON.stringify(res.body)}`);
          assert.ok(res.body.paymentUrl, g);
          assert.equal(res.body.transactionId, log.created[0].transactionId);
          assert.ok(calls.length >= 1);
        });
      });
    });
    const order = log.created[0];
    assert.equal(order.paymentGateway, g);
    assert.equal(order.status, 'PENDING');
    assert.equal(log.reserved, 1);
    assert.equal(order.gatewayCurrency, 'XXX');
    assert.equal(order.gatewayAmountMinor, 100, 'a 100 order at rate 0.01 is 100 minor units');
    const saved = log.updates.find(([, u]) => u.$set && u.$set.gatewayRef);
    assert.ok(saved, `${g}: the gateway reference is saved on the order`);
    assert.equal(saved[1].$set.gatewayRef, expectedRef[g] || order.transactionId);
    assert.equal(saved[1].$set.gatewayUrl, res_url(g));
  }
});
function res_url(g) {
  return { paypal: 'https://www.sandbox.paypal.com/checkoutnow?token=PAYPALORDER123', flutterwave: 'https://checkout.flutterwave.com/v3/hosted/pay/flwlnk-1', mollie: 'https://www.mollie.com/checkout/test123' }[g];
}

test('when the gateway refuses, the stock goes back once and the customer is told to try again', async () => {
  for (const g of intl.INTL_GATEWAYS) {
    const log = {};
    const line = { productId: PRODUCT_ID, title: 'Bomber', price: 100, quantity: 1, size: 'M' };
    await withKeys(g, async () => {
      await withStubs([
        ...shop(log),
        [Order, 'findOneAndUpdate', async () => { log.cancels++; return { _id: ORDER_ID, items: [line] }; }],
        [Order, 'findByIdAndDelete', async () => ({})]
      ], async () => {
        await withFetch([['/', 500, { error: 'down' }]], async () => {
          const res = await request(app).post('/api/orders').send(checkoutBody(g));
          assert.equal(res.status, 502, g);
          assert.match(res.body.message, /payment gateway/i);
        });
      });
    });
    assert.equal(log.cancels, 1, g);
    assert.equal(log.restocked, 1, `${g}: one restock for the one reserved line`);
  }
});

test('a card amount under the 50 minor-unit minimum is refused by the international gateways, nothing reserved', async () => {
  const log = {};
  await withEnv({ ...NO_KEYS, ...KEYS.paypal, CARD_RATE: '0.0084' }, async () => {
    await withStubs(shop(log, 10), async () => {
      const res = await request(app).post('/api/orders').send(checkoutBody('paypal'));
      assert.equal(res.status, 400);
      assert.match(res.body.message, /too small/i);
    });
  });
  assert.equal(log.reserved, 0);
  assert.equal(log.created.length, 0);
});

test('an unknown payment method is refused; leaving the method out still means SSLCommerz', async () => {
  const log = {};
  await withEnv({ ...NO_KEYS, SSLCOMMERZ_STORE_ID: undefined, SSLCOMMERZ_STORE_PASSWORD: undefined }, async () => {
    await withStubs(shop(log), async () => {
      const unknown = await request(app).post('/api/orders').send(checkoutBody('bitcoin'));
      assert.equal(unknown.status, 400);
      assert.equal(unknown.body.message, 'Unknown payment method.');
      const none = await request(app).post('/api/orders').send(checkoutBody(undefined));
      assert.equal(none.status, 400);
      assert.match(none.body.message, /not set up/i, 'no method given: SSLCommerz, which is not configured in this test');
    });
  });
  assert.equal(log.reserved, 0);
});

const pendingOrder = (gateway, extra = {}) => ({
  _id: ORDER_ID, status: 'PENDING', paymentGateway: gateway, transactionId: 'TXN-1', totalAmount: 2000,
  customerEmail: 'a@b.com', items: [], gatewayAmountMinor: 168, gatewayCurrency: 'XXX', ...extra
});

// Fakes the order collection for a return page. `log.confirmed` / `log.cancelled` say what was
// done.
function ordersFor(order, log) {
  Object.assign(log, { finds: [], confirmed: 0, cancelled: 0, cancelFilters: [], flagged: false });
  return [
    quiet,
    [Order, 'findOne', async (f) => { log.finds.push(f); return order; }],
    [Order, 'findOneAndUpdate', async (f, u) => {
      if (u.status === 'CONFIRMED') { if (order.status !== 'PENDING') return null; log.confirmed++; return { ...order, status: 'CONFIRMED' }; }
      if (u.status === 'CANCELLED') { if (order.status !== 'PENDING') return null; log.cancelled++; log.cancelFilters.push(f); return { ...order, status: 'CANCELLED' }; }
      return null;
    }],
    [Order, 'updateOne', async () => { log.flagged = true; return {}; }],
    [emailService, 'sendOrderConfirmation', () => Promise.resolve()]
  ];
}

const capture = (value, currency = 'XXX') => ({
  id: 'PAYPALORDER123', status: 'COMPLETED',
  purchase_units: [{ payments: { captures: [{ id: 'CAP-9', status: 'COMPLETED', amount: { currency_code: currency, value } }] } }]
});
const PAYPAL_OK = [['/v1/oauth2/token', 200, { access_token: 'T' }], ['/capture', 201, capture('1.68')]];

test('PayPal: coming back with an approved payment captures it once and confirms the order', async () => {
  const log = {};
  await withKeys('paypal', async () => {
    await withStubs(ordersFor(pendingOrder('paypal'), log), async () => {
      await withFetch(PAYPAL_OK, async (calls) => {
        const res = await request(app).get('/api/payment/paypal-return?token=PAYPALORDER123&PayerID=P1');
        assert.equal(res.status, 302);
        assert.match(res.headers.location, /payment-success\.html\?tran_id=TXN-1&amount=2000/);
        assert.equal(calls.filter((c) => c.url.endsWith('/capture')).length, 1);
      });
    });
  });
  assert.deepEqual(log.finds[0], { gatewayRef: 'PAYPALORDER123', paymentGateway: 'paypal' });
  assert.equal(log.confirmed, 1);
});

const PAYPAL_EVENT = { event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'PAYPALORDER123' } };
const verifyReply = (status) => ['/v1/notifications/verify-webhook-signature', 200, { verification_status: status }];

test('PayPal webhook: with no PAYPAL_WEBHOOK_ID it answers 400 and nothing is captured', async () => {
  await withKeys('paypal', async () => {
    await withEnv({ PAYPAL_WEBHOOK_ID: undefined }, async () => {
      await withFetch(PAYPAL_OK, async (calls) => {
        const res = await request(app).post('/api/payment/paypal-webhook').send(PAYPAL_EVENT);
        assert.equal(res.status, 400);
        assert.equal(calls.length, 0);
      });
    });
  });
});

test('PayPal webhook: a call PayPal does not vouch for is refused, a genuine one settles the order', async () => {
  const log = {};
  await withKeys('paypal', async () => {
    await withEnv({ PAYPAL_WEBHOOK_ID: 'WH-1' }, async () => {
      await withStubs(ordersFor(pendingOrder('paypal'), log), async () => {
        await withFetch([['/v1/oauth2/token', 200, { access_token: 'T' }], verifyReply('FAILURE'), ['/capture', 201, capture('1.68')]], async (calls) => {
          const res = await request(app).post('/api/payment/paypal-webhook').set('paypal-transmission-id', 'abc').send(PAYPAL_EVENT);
          assert.equal(res.status, 400);
          assert.equal(calls.filter((c) => c.url.endsWith('/capture')).length, 0);
        });
        assert.equal(log.confirmed || 0, 0);
        await withFetch([['/v1/oauth2/token', 200, { access_token: 'T' }], verifyReply('SUCCESS'), ['/capture', 201, capture('1.68')]], async (calls) => {
          const res = await request(app).post('/api/payment/paypal-webhook').set('paypal-transmission-id', 'abc').send(PAYPAL_EVENT);
          assert.equal(res.status, 200);
          const sent = JSON.parse(calls.find((c) => c.url.endsWith('/verify-webhook-signature')).body);
          assert.equal(sent.webhook_id, 'WH-1');
          assert.equal(sent.transmission_id, 'abc');
          assert.equal(calls.filter((c) => c.url.endsWith('/capture')).length, 1);
        });
      });
    });
  });
  assert.equal(log.confirmed, 1);
});

test('PayPal: a capture for a different amount or currency does not confirm the order', async () => {
  for (const reply of [capture('0.01'), capture('1.68', 'ZZZ')]) {
    const log = {};
    await withKeys('paypal', async () => {
      await withStubs(ordersFor(pendingOrder('paypal'), log), async () => {
        await withFetch([['/v1/oauth2/token', 200, { access_token: 'T' }], ['/capture', 201, reply]], async () => {
          const res = await request(app).get('/api/payment/paypal-return?token=PAYPALORDER123');
          assert.match(res.headers.location, /payment-fail\.html\?reason=validation_failed/);
        });
      });
    });
    assert.equal(log.confirmed, 0);
  }
});

test('PayPal: money is never taken for an order that was cancelled or has expired', async () => {
  const log = {};
  await withKeys('paypal', async () => {
    await withStubs(ordersFor(pendingOrder('paypal', { status: 'CANCELLED' }), log), async () => {
      await withFetch([], async (calls) => {
        const res = await request(app).get('/api/payment/paypal-return?token=PAYPALORDER123');
        assert.match(res.headers.location, /payment-fail\.html\?reason=cancelled/);
        assert.equal(calls.length, 0, 'PayPal is not called at all');
      });
    });
  });
  assert.equal(log.confirmed, 0);
});

test('PayPal: a repeat visit to the return page does not capture again', async () => {
  const log = {};
  await withKeys('paypal', async () => {
    await withStubs(ordersFor(pendingOrder('paypal', { status: 'CONFIRMED' }), log), async () => {
      await withFetch([], async (calls) => {
        const res = await request(app).get('/api/payment/paypal-return?token=PAYPALORDER123');
        assert.match(res.headers.location, /payment-success\.html\?tran_id=TXN-1&already=true/);
        assert.equal(calls.length, 0);
      });
    });
  });
});

test('PayPal: an unknown, missing or malformed token is rejected without calling PayPal', async () => {
  const log = {};
  const order = null;
  await withKeys('paypal', async () => {
    await withStubs(ordersFor(order, log), async () => {
      await withFetch([], async (calls) => {
        let res = await request(app).get('/api/payment/paypal-return?token=NOSUCHORDER1');
        assert.match(res.headers.location, /reason=validation_failed/);
        res = await request(app).get('/api/payment/paypal-return');
        assert.match(res.headers.location, /reason=invalid_status/);
        res = await request(app).get('/api/payment/paypal-return?token[$ne]=1');
        assert.match(res.headers.location, /reason=invalid_status/);
        assert.equal(calls.length, 0);
      });
    });
  });
});

test('PayPal: an order that belongs to another gateway cannot be confirmed through the PayPal page', async () => {
  const log = {};
  await withKeys('paypal', async () => {
    await withStubs(ordersFor(pendingOrder('mollie'), log), async () => {
      await withFetch(PAYPAL_OK, async () => {
        const res = await request(app).get('/api/payment/paypal-return?token=PAYPALORDER123');
        assert.match(res.headers.location, /payment-fail\.html\?reason=validation_failed/);
      });
    });
  });
  assert.equal(log.confirmed, 0);
});

const flwVerify = (txRef = 'TXN-1', amount = 1.68, status = 'successful') =>
  [['/v3/transactions/4455/verify', 200, { status: 'success', data: { id: 4455, tx_ref: txRef, status, amount, currency: 'XXX' } }]];

test('Flutterwave: a successful, verified payment for this order confirms it', async () => {
  const log = {};
  await withKeys('flutterwave', async () => {
    await withStubs(ordersFor(pendingOrder('flutterwave'), log), async () => {
      await withFetch(flwVerify(), async () => {
        const res = await request(app).get('/api/payment/flutterwave-return?status=successful&tx_ref=TXN-1&transaction_id=4455');
        assert.match(res.headers.location, /payment-success\.html\?tran_id=TXN-1&amount=2000/);
      });
    });
  });
  assert.equal(log.confirmed, 1);
});

test('Flutterwave: "successful" in the address is not trusted; a wrong amount, wrong order or unpaid transaction is refused', async () => {
  const cases = [flwVerify('TXN-1', 0.5), flwVerify('TXN-OTHER'), flwVerify('TXN-1', 1.68, 'failed')];
  for (const replies of cases) {
    const log = {};
    await withKeys('flutterwave', async () => {
      await withStubs(ordersFor(pendingOrder('flutterwave'), log), async () => {
        await withFetch(replies, async () => {
          const res = await request(app).get('/api/payment/flutterwave-return?status=successful&tx_ref=TXN-1&transaction_id=4455');
          assert.match(res.headers.location, /payment-fail\.html\?reason=validation_failed/);
        });
      });
    });
    assert.equal(log.confirmed, 0);
  }
});

test('Flutterwave: cancelled or failed brings the stock back and keeps the cart', async () => {
  for (const [status, reason] of [['cancelled', 'cancelled'], ['failed', 'payment_failed']]) {
    const log = {};
    await withKeys('flutterwave', async () => {
      await withStubs(ordersFor(pendingOrder('flutterwave'), log), async () => {
        await withFetch([], async (calls) => {
          const res = await request(app).get(`/api/payment/flutterwave-return?status=${status}&tx_ref=TXN-1`);
          assert.match(res.headers.location, new RegExp(`payment-fail\\.html\\?reason=${reason}`));
          assert.equal(calls.length, 0);
        });
      });
    });
    assert.equal(log.cancelled, 1, status);
    assert.deepEqual(log.cancelFilters[0], { transactionId: 'TXN-1', paymentGateway: 'flutterwave', status: 'PENDING', paymentIssue: { $ne: 'PAYMENT_UNCONFIRMED' } });
  }
});

test('Flutterwave webhook: needs the secret hash, then confirms what Flutterwave itself reports', async () => {
  const hook = (hash) => {
    const r = request(app).post('/api/payment/flutterwave-webhook');
    return (hash ? r.set('verif-hash', hash) : r).send({ event: 'charge.completed', data: { id: 4455, tx_ref: 'TXN-1', status: 'successful' } });
  };
  const log = {};
  await withEnv({ ...NO_KEYS, ...KEYS.flutterwave, FLUTTERWAVE_WEBHOOK_HASH: 'my-secret-hash' }, async () => {
    await withStubs(ordersFor(pendingOrder('flutterwave'), log), async () => {
      await withFetch(flwVerify(), async () => {
        assert.equal((await hook(null)).status, 401);
        assert.equal((await hook('wrong-hash')).status, 401);
        assert.equal(log.confirmed, 0);
        assert.equal((await hook('my-secret-hash')).status, 200);
      });
    });
  });
  assert.equal(log.confirmed, 1);
});

test('Flutterwave webhook: with no FLUTTERWAVE_WEBHOOK_HASH set, every call is refused', async () => {
  await withEnv({ ...NO_KEYS, ...KEYS.flutterwave }, async () => {
    const res = await request(app).post('/api/payment/flutterwave-webhook').set('verif-hash', '').send({ data: { id: 1 } });
    assert.equal(res.status, 401);
  });
});

const mollieReply = (status) => [['/v2/payments/tr_test123', 200, { id: 'tr_test123', status, amount: { currency: 'XXX', value: '1.68' } }]];
const mollieOrder = (extra) => pendingOrder('mollie', { gatewayRef: 'tr_test123', ...extra });

test('Mollie: a paid payment confirms the order', async () => {
  const log = {};
  await withKeys('mollie', async () => {
    await withStubs(ordersFor(mollieOrder(), log), async () => {
      await withFetch(mollieReply('paid'), async () => {
        const res = await request(app).get('/api/payment/mollie-return?tran_id=TXN-1');
        assert.match(res.headers.location, /payment-success\.html\?tran_id=TXN-1&amount=2000/);
      });
    });
  });
  assert.equal(log.confirmed, 1);
});

test('Mollie: a cancelled, expired or failed payment cancels the order; an open one is left alone', async () => {
  for (const [status, reason, cancels] of [['canceled', 'cancelled', 1], ['expired', 'cancelled', 1], ['failed', 'payment_failed', 1], ['open', 'validation_failed', 0]]) {
    const log = {};
    await withKeys('mollie', async () => {
      await withStubs(ordersFor(mollieOrder(), log), async () => {
        await withFetch(mollieReply(status), async () => {
          const res = await request(app).get('/api/payment/mollie-return?tran_id=TXN-1');
          assert.match(res.headers.location, new RegExp(`payment-fail\\.html\\?reason=${reason}`), status);
        });
      });
    });
    assert.equal(log.confirmed, 0, status);
    assert.equal(log.cancelled, cancels, status);
  }
});

test('Mollie: a payment for the wrong amount is not confirmed', async () => {
  const log = {};
  await withKeys('mollie', async () => {
    await withStubs(ordersFor(mollieOrder({ gatewayAmountMinor: 9999 }), log), async () => {
      await withFetch(mollieReply('paid'), async () => {
        const res = await request(app).get('/api/payment/mollie-return?tran_id=TXN-1');
        assert.match(res.headers.location, /payment-fail\.html\?reason=validation_failed/);
      });
    });
  });
  assert.equal(log.confirmed, 0);
});

test('Mollie webhook: confirms a paid order, ignores unknown ids, and always answers 200 for them', async () => {
  const log = {};
  await withKeys('mollie', async () => {
    await withStubs(ordersFor(mollieOrder(), log), async () => {
      await withFetch(mollieReply('paid'), async () => {
        const res = await request(app).post('/api/payment/mollie-webhook').type('form').send({ id: 'tr_test123' });
        assert.equal(res.status, 200);
      });
    });
  });
  assert.equal(log.confirmed, 1);

  const none = {};
  await withKeys('mollie', async () => {
    await withStubs(ordersFor(null, none), async () => {
      await withFetch([], async (calls) => {
        assert.equal((await request(app).post('/api/payment/mollie-webhook').type('form').send({ id: 'tr_unknown1' })).status, 200);
        assert.equal((await request(app).post('/api/payment/mollie-webhook').send({})).status, 200);
        assert.equal(calls.length, 0, 'Mollie is not asked about an order this shop does not have');
      });
    });
  });
  assert.equal(none.confirmed, 0);
});

test('settleIntlPayment: needs a paid result, the right gateway, the exact amount and the right currency', async () => {
  const req = { app: { get: () => null } };
  const ok = { paid: true, amountMinor: 168, currency: 'XXX', ref: 'R1' };
  const cases = [
    [pendingOrder('paypal'), { ...ok, paid: false }, 'invalid'],
    [pendingOrder('paypal'), { ...ok, amountMinor: 167 }, 'invalid'],
    [pendingOrder('paypal'), { ...ok, currency: 'ZZZ' }, 'invalid'],
    [pendingOrder('paypal', { gatewayAmountMinor: undefined }), ok, 'invalid'],
    [pendingOrder('stripe'), ok, 'invalid'],
    [null, ok, 'invalid'],
    [pendingOrder('paypal'), ok, 'confirmed']
  ];
  for (const [order, verified, expected] of cases) {
    const log = {};
    await withStubs(ordersFor(order, log), async () => {
      const out = await settleIntlPayment('paypal', 'TXN-1', verified, req);
      assert.equal(out.result, expected, JSON.stringify([order && order.paymentGateway, verified]));
    });
  }
  assert.equal((await settleIntlPayment('paypal', '', ok, req)).result, 'invalid');
  assert.equal((await settleIntlPayment('paypal', { $ne: 1 }, ok, req)).result, 'invalid');
});

test('a payment that arrives after the order was cancelled is flagged for the owner, not lost', async () => {
  const req = { app: { get: () => null } };
  const log = {};
  await withStubs(ordersFor(pendingOrder('mollie', { status: 'CANCELLED' }), log), async () => {
    const out = await settleIntlPayment('mollie', 'TXN-1', { paid: true, amountMinor: 168, currency: 'XXX', ref: 'tr_x' }, req);
    assert.equal(out.result, 'late');
  });
  assert.equal(log.flagged, true);
});

test('the Order model accepts the three new gateways and keeps the gateway amount and reference', async () => {
  for (const g of intl.INTL_GATEWAYS) {
    const o = new Order({
      customerName: 'A', customerEmail: 'a@b.com', totalAmount: 100, paymentGateway: g,
      gatewayRef: 'ref-1', gatewayAmountMinor: 84, gatewayCurrency: 'XXX'
    });
    await o.validate();   // rejects when the gateway is not accepted
    assert.equal(o.gatewayAmountMinor, 84);
  }
  await assert.rejects(new Order({ customerName: 'A', customerEmail: 'a@b.com', totalAmount: 1, paymentGateway: 'bitcoin' }).validate());
});

test('the checkout form has a hidden-until-enabled option for each new gateway, and the storefront script knows them', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  for (const [value, id] of [['paypal', 'gatewayPaypal'], ['flutterwave', 'gatewayFlutterwave'], ['mollie', 'gatewayMollie']]) {
    assert.match(html, new RegExp(`id="${id}" value="${value}" disabled`));
    assert.match(html, new RegExp(`<label class="btn btn-outline-primary d-none" for="${id}">`));
    assert.ok(js.includes(`#${id}`), `${id} is in the storefront script`);
    assert.match(js, new RegExp(`'${value}'`));
  }
  const admin = fs.readFileSync(path.join(ROOT, 'public/js/admin.js'), 'utf8');
  assert.match(admin, /PayPal \(International\)/);
});

test('.env.example and the README describe the new gateways', () => {
  const env = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  for (const key of ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_IS_LIVE', 'FLUTTERWAVE_SECRET_KEY', 'FLUTTERWAVE_WEBHOOK_HASH', 'MOLLIE_API_KEY']) {
    assert.ok(env.includes(`${key}=`), `${key} is in .env.example`);
    assert.ok(readme.includes(key), `${key} is in the README`);
  }
});
