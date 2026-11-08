// Tests for the PayPal, Flutterwave and Mollie gateways (services/intlGateways.js).
// No server, database or internet is used: fetch is replaced by a small fake that
// records what was sent and answers with canned gateway replies.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const intl = require('../services/intlGateways');
const { paypalConfigured, flutterwaveConfigured, mollieConfigured } = require('../services/paymentConfig');

// Replaces fetch for one test. `replies` is a list of [matcher, status, body]; the
// first matcher (a string the URL must contain) that fits answers the call.
async function withFetch(replies, fn) {
  const calls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
    const hit = replies.find(([m]) => String(url).includes(m));
    if (!hit) throw new Error(`unexpected request to ${url}`);
    const [, status, body] = hit;
    return { ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) };
  };
  try { await fn(calls); } finally { globalThis.fetch = saved; }
}

const CUR = { CURRENCY_CODE: 'XXX' };   // the machine-readable code every gateway needs
const PAYPAL_ENV = { ...CUR, PAYPAL_CLIENT_ID: 'client-id-123', PAYPAL_CLIENT_SECRET: 'secret-456', PAYPAL_IS_LIVE: 'false' };
const FLW_ENV = { ...CUR, FLUTTERWAVE_SECRET_KEY: 'FLWSECK_TEST-abc123' };
const MOLLIE_ENV = { ...CUR, MOLLIE_API_KEY: 'test_abcdefghijklmnopqrstuvwxyz1234' };

const payment = (extra = {}) => ({
  transactionId: 'TXN-1700000000000-ABCD1234', amountMinor: 2687, currency: 'XXX',
  description: 'Order TXN-1: Bomber (M) x1', brandName: 'Threadly',
  returnUrl: 'https://shop.example/api/payment/x-return', cancelUrl: 'https://shop.example/api/payment/cancel?tran_id=TXN-1',
  webhookUrl: 'https://shop.example/api/payment/mollie-webhook',
  customerName: 'Buyer', customerEmail: 'buyer@example.com', customerPhone: '01700000000', ...extra
});

test('each gateway counts as configured only with real keys; the .env.example placeholders do not count', () => {
  assert.equal(paypalConfigured({}), false);
  assert.equal(paypalConfigured({ PAYPAL_CLIENT_ID: 'abc' }), false);
  assert.equal(paypalConfigured({ PAYPAL_CLIENT_ID: 'your-paypal-client-id', PAYPAL_CLIENT_SECRET: 'x' }), false);
  assert.equal(paypalConfigured(PAYPAL_ENV), true);
  assert.equal(flutterwaveConfigured({ FLUTTERWAVE_SECRET_KEY: '' }), false);
  assert.equal(flutterwaveConfigured({ FLUTTERWAVE_SECRET_KEY: 'your-flutterwave-secret-key' }), false);
  assert.equal(flutterwaveConfigured(FLW_ENV), true);
  assert.equal(mollieConfigured({ MOLLIE_API_KEY: '   ' }), false);
  assert.equal(mollieConfigured({ MOLLIE_API_KEY: 'replace-with-your-mollie-key' }), false);
  assert.equal(mollieConfigured(MOLLIE_ENV), true);
  assert.equal(intl.isConfigured('paypal', PAYPAL_ENV), true);
  assert.equal(intl.isConfigured('stripe', PAYPAL_ENV), false);
});

test('only the three extra gateways are international gateways', () => {
  assert.deepEqual(intl.INTL_GATEWAYS, ['paypal', 'flutterwave', 'mollie']);
  for (const g of intl.INTL_GATEWAYS) assert.equal(intl.isIntlGateway(g), true);
  for (const g of ['stripe', 'sslcommerz', 'cod', 'manual', '', undefined, { $ne: 1 }]) assert.equal(intl.isIntlGateway(g), false);
});

test('the total becomes whole minor units with CARD_RATE (1 by default), and the minimum is 50 minor units', () => {
  assert.equal(intl.toMinorUnits(3199, {}), 319900);                         // no rate: the amount is charged as it is
  assert.equal(intl.toMinorUnits(1000, { CARD_RATE: '0.01' }), 1000);
  assert.equal(intl.toMinorUnits(1000, { CARD_RATE: 'abc' }), 100000);       // a bad value means "no conversion"
  assert.equal(intl.cardRate({ CARD_RATE: '0.0082' }), 0.0082);
  assert.equal(intl.cardRate({ CARD_RATE: '-1' }), 1);
  // A different card currency without a rate is a start-up problem; the same currency needs none.
  assert.match(intl.cardRateProblem({ CURRENCY_CODE: 'AAA', CARD_CURRENCY: 'BBB' }) || '', /CARD_RATE/);
  assert.equal(intl.cardRateProblem({ CURRENCY_CODE: 'AAA', CARD_CURRENCY: 'BBB', CARD_RATE: '0.5' }), null);
  assert.equal(intl.cardRateProblem({ CURRENCY_CODE: 'AAA' }), null);
  assert.equal(intl.cardRateProblem({}), null);
  // Without a currency code no online method counts as configured.
  assert.equal(paypalConfigured({ PAYPAL_CLIENT_ID: 'client-id-123', PAYPAL_CLIENT_SECRET: 'secret-456' }), false);
  assert.equal(intl.cardCurrency({ CURRENCY_CODE: 'aaa' }), 'AAA');
  assert.equal(intl.cardCurrency({ CURRENCY_CODE: 'AAA', CARD_CURRENCY: 'bbb' }), 'BBB');
  assert.equal(intl.minorToDecimal(2687), '26.87');
  assert.equal(intl.minorToDecimal(5), '0.05');
  assert.equal(intl.decimalToMinor('26.87'), 2687);
  assert.equal(intl.decimalToMinor(26.87), 2687);
  assert.ok(Number.isNaN(intl.decimalToMinor('abc')));
  assert.equal(intl.MIN_INTL_MINOR, 50);
});

test('PayPal: an order is created in XXX for the exact amount and the approval page is returned', async () => {
  await withFetch([
    ['/v1/oauth2/token', 200, { access_token: 'TOKEN-1' }],
    ['/v2/checkout/orders', 201, { id: 'PAYPALORDER123', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'self', href: 'https://api/self' }, { rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=PAYPALORDER123' }] }]
  ], async (calls) => {
    const out = await intl.createPayment('paypal', payment(), PAYPAL_ENV);
    assert.deepEqual(out, { url: 'https://www.sandbox.paypal.com/checkoutnow?token=PAYPALORDER123', ref: 'PAYPALORDER123' });

    assert.match(calls[0].url, /^https:\/\/api-m\.sandbox\.paypal\.com\/v1\/oauth2\/token$/);   // sandbox unless PAYPAL_IS_LIVE=true
    assert.equal(calls[0].headers.Authorization, 'Basic ' + Buffer.from('client-id-123:secret-456').toString('base64'));
    const body = JSON.parse(calls[1].body);
    assert.equal(calls[1].headers.Authorization, 'Bearer TOKEN-1');
    assert.equal(body.intent, 'CAPTURE');
    assert.deepEqual(body.purchase_units[0].amount, { currency_code: 'XXX', value: '26.87' });
    assert.equal(body.purchase_units[0].custom_id, 'TXN-1700000000000-ABCD1234');
    assert.equal(body.payment_source.paypal.experience_context.return_url, 'https://shop.example/api/payment/x-return');
  });
});

test('PayPal: live mode uses the live address, and an error from PayPal is thrown, not hidden', async () => {
  await withFetch([['/v1/oauth2/token', 401, { error: 'invalid_client' }]], async (calls) => {
    await assert.rejects(intl.createPayment('paypal', payment(), { ...PAYPAL_ENV, PAYPAL_IS_LIVE: ' TRUE ' }), /PayPal sign-in failed/);
    assert.match(calls[0].url, /^https:\/\/api-m\.paypal\.com\//);
  });
  await withFetch([
    ['/v1/oauth2/token', 200, { access_token: 'T' }],
    ['/v2/checkout/orders', 422, { name: 'UNPROCESSABLE_ENTITY' }]
  ], async () => {
    await assert.rejects(intl.createPayment('paypal', payment(), PAYPAL_ENV), /did not create the order/);
  });
});

const completedCapture = (value = '26.87', currency = 'XXX') => ({
  id: 'PAYPALORDER123', status: 'COMPLETED',
  purchase_units: [{ payments: { captures: [{ id: 'CAP-9', status: 'COMPLETED', custom_id: 'TXN-1', amount: { currency_code: currency, value } }] } }]
});

test('PayPal: a completed capture reads as paid with its amount, currency and reference', async () => {
  await withFetch([
    ['/v1/oauth2/token', 200, { access_token: 'T' }],
    ['/capture', 201, completedCapture()]
  ], async (calls) => {
    const out = await intl.paypalCapture('PAYPALORDER123', PAYPAL_ENV);
    assert.deepEqual(out, { paid: true, amountMinor: 2687, currency: 'XXX', ref: 'CAP-9', customId: 'TXN-1' });
    assert.equal(calls[1].method, 'POST');
    assert.match(calls[1].url, /\/v2\/checkout\/orders\/PAYPALORDER123\/capture$/);
  });
});

test('PayPal: pending, declined and malformed captures are never "paid"', async () => {
  assert.equal(intl.readPaypalOrder(null).paid, false);
  assert.equal(intl.readPaypalOrder({ status: 'APPROVED' }).paid, false);
  const pending = completedCapture();
  pending.purchase_units[0].payments.captures[0].status = 'PENDING';
  assert.equal(intl.readPaypalOrder(pending).paid, false);
  const noCaptures = { status: 'COMPLETED', purchase_units: [{}] };
  assert.equal(intl.readPaypalOrder(noCaptures).paid, false);

  await withFetch([['/v1/oauth2/token', 200, { access_token: 'T' }], ['/capture', 422, { details: [{ issue: 'INSTRUMENT_DECLINED' }] }]], async () => {
    assert.equal((await intl.paypalCapture('PAYPALORDER123', PAYPAL_ENV)).paid, false);
  });
});

test('PayPal: capturing twice reads the order instead of failing', async () => {
  await withFetch([
    ['/v1/oauth2/token', 200, { access_token: 'T' }],
    ['/capture', 422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] }],
    ['/v2/checkout/orders/PAYPALORDER123', 200, completedCapture()]
  ], async () => {
    const out = await intl.paypalCapture('PAYPALORDER123', PAYPAL_ENV);
    assert.equal(out.paid, true);
    assert.equal(out.amountMinor, 2687);
  });
});

test('PayPal: an order id with odd characters is refused before any request is made', async () => {
  await withFetch([], async (calls) => {
    for (const bad of ['', 'a/../b', 'x y', '../../v1/payments', 'a'.repeat(100)]) {
      assert.equal((await intl.paypalCapture(bad, PAYPAL_ENV)).paid, false);
    }
    assert.equal(calls.length, 0);
  });
});

test('Flutterwave: a hosted payment link is created with our reference and the exact amount', async () => {
  await withFetch([['/v3/payments', 200, { status: 'success', data: { link: 'https://checkout.flutterwave.com/v3/hosted/pay/flwlnk-1' } }]], async (calls) => {
    const out = await intl.createPayment('flutterwave', payment(), FLW_ENV);
    assert.deepEqual(out, { url: 'https://checkout.flutterwave.com/v3/hosted/pay/flwlnk-1', ref: 'TXN-1700000000000-ABCD1234' });
    assert.equal(calls[0].headers.Authorization, 'Bearer FLWSECK_TEST-abc123');
    const body = JSON.parse(calls[0].body);
    assert.equal(body.tx_ref, 'TXN-1700000000000-ABCD1234');
    assert.equal(body.amount, 26.87);
    assert.equal(body.currency, 'XXX');
    assert.equal(body.customer.email, 'buyer@example.com');
  });
  await withFetch([['/v3/payments', 400, { status: 'error', message: 'Invalid key' }]], async () => {
    await assert.rejects(intl.createPayment('flutterwave', payment(), FLW_ENV), /did not create the payment/);
  });
});

test('Flutterwave: only a "successful" transaction is paid, and its amount, currency and tx_ref are returned', async () => {
  const ok = { status: 'success', data: { id: 4455, tx_ref: 'TXN-1', status: 'successful', amount: 26.87, currency: 'XXX' } };
  await withFetch([['/v3/transactions/4455/verify', 200, ok]], async (calls) => {
    assert.deepEqual(await intl.flutterwaveVerify('4455', FLW_ENV), { paid: true, amountMinor: 2687, currency: 'XXX', ref: '4455', txRef: 'TXN-1' });
    assert.equal(calls[0].headers.Authorization, 'Bearer FLWSECK_TEST-abc123');
  });
  for (const status of ['failed', 'pending', 'cancelled']) {
    await withFetch([['/verify', 200, { status: 'success', data: { ...ok.data, status } }]], async () => {
      assert.equal((await intl.flutterwaveVerify('4455', FLW_ENV)).paid, false, status);
    });
  }
  await withFetch([['/verify', 404, { status: 'error' }]], async () => {
    assert.equal((await intl.flutterwaveVerify('4455', FLW_ENV)).paid, false);
  });
});

test('Flutterwave: a transaction id that is not a plain number is refused without a request', async () => {
  await withFetch([], async (calls) => {
    for (const bad of ['', 'abc', '12/../x', '1 2', undefined, { a: 1 }]) assert.equal((await intl.flutterwaveVerify(bad, FLW_ENV)).paid, false);
    assert.equal(calls.length, 0);
  });
});

test('Flutterwave webhook: only the exact secret hash from .env is allowed', () => {
  const env = { FLUTTERWAVE_WEBHOOK_HASH: 'my-secret-hash' };
  assert.equal(intl.flutterwaveWebhookAllowed('my-secret-hash', env), true);
  assert.equal(intl.flutterwaveWebhookAllowed('my-secret-hasH', env), false);
  assert.equal(intl.flutterwaveWebhookAllowed('short', env), false);
  assert.equal(intl.flutterwaveWebhookAllowed(undefined, env), false);
  assert.equal(intl.flutterwaveWebhookAllowed('', {}), false);                 // no secret set: nothing is allowed
  assert.equal(intl.flutterwaveWebhookAllowed('anything', { FLUTTERWAVE_WEBHOOK_HASH: '  ' }), false);
});

test('Mollie: a payment is created with a 2-decimal amount, our redirect and the webhook', async () => {
  await withFetch([['/v2/payments', 201, { id: 'tr_WDqYK6vllg', status: 'open', _links: { checkout: { href: 'https://www.mollie.com/checkout/select-method/WDqYK6vllg' } } }]], async (calls) => {
    const out = await intl.createPayment('mollie', payment(), MOLLIE_ENV);
    assert.deepEqual(out, { url: 'https://www.mollie.com/checkout/select-method/WDqYK6vllg', ref: 'tr_WDqYK6vllg' });
    const body = JSON.parse(calls[0].body);
    assert.deepEqual(body.amount, { currency: 'XXX', value: '26.87' });
    assert.equal(body.redirectUrl, 'https://shop.example/api/payment/x-return');
    assert.equal(body.webhookUrl, 'https://shop.example/api/payment/mollie-webhook');
    assert.equal(body.metadata.transactionId, 'TXN-1700000000000-ABCD1234');
    assert.equal(calls[0].headers.Authorization, 'Bearer test_abcdefghijklmnopqrstuvwxyz1234');
  });
});

test('Mollie: the webhook address is left out for localhost and plain http, where Mollie cannot reach it', async () => {
  assert.equal(intl.isPublicHttps('https://shop.example/x'), true);
  for (const u of ['http://shop.example/x', 'https://localhost:3000/x', 'https://127.0.0.1/x', 'not a url', '']) assert.equal(intl.isPublicHttps(u), false, u);
  await withFetch([['/v2/payments', 201, { id: 'tr_abc123', _links: { checkout: { href: 'https://pay.example/c' } } }]], async (calls) => {
    await intl.createPayment('mollie', payment({ webhookUrl: 'http://localhost:3000/api/payment/mollie-webhook' }), MOLLIE_ENV);
    assert.equal('webhookUrl' in JSON.parse(calls[0].body), false);
  });
});

test('Mollie: only a "paid" payment is paid; other states are reported as they are', async () => {
  await withFetch([['/v2/payments/tr_abc123', 200, { id: 'tr_abc123', status: 'paid', amount: { currency: 'XXX', value: '26.87' } }]], async () => {
    assert.deepEqual(await intl.mollieGet('tr_abc123', MOLLIE_ENV), { status: 'paid', paid: true, amountMinor: 2687, currency: 'XXX', ref: 'tr_abc123' });
  });
  for (const status of ['open', 'pending', 'canceled', 'expired', 'failed', 'authorized']) {
    await withFetch([['/v2/payments/tr_abc123', 200, { id: 'tr_abc123', status, amount: { currency: 'XXX', value: '26.87' } }]], async () => {
      const out = await intl.mollieGet('tr_abc123', MOLLIE_ENV);
      assert.equal(out.paid, false, status);
      assert.equal(out.status, status);
    });
  }
  await withFetch([['/v2/payments/', 404, { status: 404 }]], async () => {
    assert.equal((await intl.mollieGet('tr_abc123', MOLLIE_ENV)).paid, false);
  });
});

test('Mollie: a payment id with odd characters is refused without a request', async () => {
  await withFetch([], async (calls) => {
    for (const bad of ['', 'abc', 'tr_', 'tr_../x', 'tr_a b', undefined]) assert.equal((await intl.mollieGet(bad, MOLLIE_ENV)).paid, false);
    assert.equal(calls.length, 0);
  });
});

test('an unknown gateway name cannot create a payment', async () => {
  await assert.rejects(intl.createPayment('bitcoin', payment(), {}), /Unknown gateway/);
});

test('a request that hangs is stopped by the timeout instead of waiting forever', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn) => realSetTimeout(fn, 5);   // make the 15 second timeout 5 ms for this test
  try {
    await assert.rejects(intl.mollieGet('tr_abc123', MOLLIE_ENV), /aborted/);
  } finally {
    global.setTimeout = realSetTimeout;
    globalThis.fetch = saved;
  }
});
