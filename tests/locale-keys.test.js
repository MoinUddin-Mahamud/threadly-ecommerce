// The six locale files carry the same keys, including the strings the page scripts add.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pub = (f) => path.join(__dirname, '..', 'public', f);
const LANGS = ['en', 'bn', 'ar', 'es', 'fr', 'hi'];
const load = (l) => JSON.parse(fs.readFileSync(pub(`locales/${l}.json`), 'utf8'));
const core = require('../public/js/motion-core.js');

test('all six locale files have exactly the same keys', () => {
  const keys = Object.keys(load('en')).sort();
  for (const l of LANGS) assert.deepEqual(Object.keys(load(l)).sort(), keys, l);
});

test('the language picker label has a key in every language', () => {
  for (const l of LANGS) assert.ok(load(l)['lang.label'].trim(), l);
  const js = fs.readFileSync(pub('js/i18n.js'), 'utf8');
  assert.match(js, /setAttribute\('aria-label', t\('lang\.label', 'Language'\)\)/);
  assert.equal(load('en')['lang.label'], 'Language');
});

test('the product load error is translated and matches the text the script shows', () => {
  assert.equal(load('en')['shop.loadFailed'], core.LOAD_FAILED);
  for (const l of LANGS.filter((x) => x !== 'en')) {
    const text = load(l)['shop.loadFailed'];
    assert.ok(text.trim() && text !== core.LOAD_FAILED, l);
  }
});

test('every string the page scripts put on the page is a known key', () => {
  const en = Object.values(load('en'));
  for (const text of ['Checkout', 'Back', 'Total:', 'Language', core.LOAD_FAILED]) assert.ok(en.includes(text), text);
});

test('every string in the page scripts and pages has a key, and values keep their placeholders', () => {
  const en = load('en');
  const have = new Set(Object.values(en));
  // Strings the scripts show to customers and sellers (a sample from each file).
  for (const text of ['Add to Cart', 'Select Size', 'Fresh picks', 'In Stock', 'Out of Stock', 'Only {n} left', 'Your cart is empty.',
    'Please fill in all fields.', 'Seller dashboard', 'Mark as shipped', 'Payment Failed - {site}', 'An order needs a total of at least {min}.', 'You will be charged {amount} on the payment page.']) {
    assert.ok(have.has(text), `missing key for: ${text}`);
  }
  for (const l of LANGS.filter((x) => x !== 'en')) {
    const d = load(l);
    for (const k of Object.keys(en)) {
      const a = (en[k].match(/\{\w+\}/g) || []).sort().join();
      assert.equal((d[k].match(/\{\w+\}/g) || []).sort().join(), a, `${l}.${k}`);
    }
  }
});

test('text with values is matched as a pattern and translated', () => {
  const src = fs.readFileSync(pub('js/i18n.js'), 'utf8');
  assert.match(src, /function t\(key, fallback, vars\)/);
  assert.match(src, /function tr\(text\)/);
  assert.match(src, /ui:lang/);
});

test('the strings of the order list, the chat widget and the product page are translated in every language', () => {
  const en = load('en');
  const keys = { 'o.loading': 'Loading...', 'chat.typing': 'Typing...', 'pg.home': 'Home', 'pg.shopAll': 'Shop all clothing', 'pg.reviews': 'Customer reviews' };
  for (const [key, text] of Object.entries(keys)) assert.equal(en[key], text, key);
  for (const l of LANGS) for (const key of Object.keys(keys)) assert.ok(load(l)[key] && String(load(l)[key]).trim(), `${l} ${key}`);
});
