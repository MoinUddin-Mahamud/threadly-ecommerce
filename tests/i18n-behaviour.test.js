// Runs public/js/i18n.js against a small fake DOM and checks what it does.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dir = path.join(__dirname, '..', 'public', 'locales');
const locale = (l) => JSON.parse(fs.readFileSync(path.join(dir, `${l}.json`), 'utf8'));
const LANGS = ['en', 'bn', 'ar', 'es', 'fr', 'hi'];

test('every locale has every English key, non-empty, with the same {placeholders}', () => {
  const en = locale('en');
  const holes = (v) => (String(v).match(/\{\w+\}/g) || []).sort().join(',');
  for (const l of LANGS) {
    const d = locale(l);
    for (const k of Object.keys(en)) {
      assert.ok(typeof d[k] === 'string' && d[k].trim() !== '', `${l} is missing ${k}`);
      assert.equal(holes(d[k]), holes(en[k]), `${l} changes the placeholders of ${k}`);
    }
    for (const k of Object.keys(d)) assert.ok(k in en, `${l} has a key that en.json lacks: ${k}`);
  }
});

test('English values are unique, so text maps back to one key', () => {
  const seen = {};
  for (const [k, v] of Object.entries(locale('en'))) {
    assert.ok(!(v in seen), `"${v}" is used by both ${seen[v]} and ${k}`);
    seen[v] = k;
  }
});

function textNode(value, parent) { return { nodeType: 3, nodeValue: value, parentNode: parent, isConnected: true }; }
function element(attrs = {}, parent = null) {
  const el = { nodeType: 1, nodeName: 'DIV', attrs, parentNode: parent, getAttribute: (a) => attrs[a] ?? null, setAttribute: (a, v) => { attrs[a] = v; } };
  el.closest = (sel) => { for (let n = el; n; n = n.parentNode) if (sel === '[translate="no"]' && n.attrs && n.attrs.translate === 'no') return n; return null; };
  return el;
}

async function loadI18n() {
  const body = element();
  const doc = {
    cookie: '', body, documentElement: { lang: '', dir: '' },
    querySelector: () => null, getElementById: () => null, createElement: () => element(),
    createTreeWalker: () => ({ nextNode: () => null })
  };
  const store = {};
  const window = {};
  const sandbox = {
    window, document: doc, NodeFilter: { SHOW_TEXT: 4 },
    navigator: { language: 'en-US' }, localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
    MutationObserver: class { observe() {} },
    fetch: async (url) => ({ json: async () => locale(url.match(/locales\/(\w+)\.json/)[1]) })
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'i18n.js'), 'utf8'), sandbox);
  await new Promise((r) => setTimeout(r, 20));
  return { api: window.UI18n, doc, store };
}

test('setLang translates known text, sets dir and remembers the choice', async () => {
  const { api, doc, store } = await loadI18n();
  await api.setLang('ar');
  assert.equal(doc.documentElement.dir, 'rtl');
  assert.equal(doc.documentElement.lang, 'ar');
  assert.equal(store.lang, 'ar');
  assert.equal(api.t('cart.checkout'), locale('ar')['cart.checkout']);
  const node = textNode('Checkout', element());
  api.translateNode(node);
  assert.equal(node.nodeValue, locale('ar')['cart.checkout']);
  await api.setLang('es');
  assert.equal(doc.documentElement.dir, 'ltr');
});

test('names typed by shops are never translated', async () => {
  const { api } = await loadI18n();
  await api.setLang('es');
  const marked = textNode('Men', element({ translate: 'no' }));
  api.translateNode(marked);
  assert.equal(marked.nodeValue, 'Men');
  const plain = textNode('Men', element());
  api.translateNode(plain);
  assert.equal(plain.nodeValue, locale('es')['cat.men']);
});

test('text without a key and a missing key stay English', async () => {
  const { api } = await loadI18n();
  await api.setLang('fr');
  const node = textNode('Some text nobody translated', element());
  api.translateNode(node);
  assert.equal(node.nodeValue, 'Some text nobody translated');
  assert.equal(api.t('no.such.key', 'Fallback'), 'Fallback');
});

test('the saved language is read back on the next load', async () => {
  const { api, store } = await loadI18n();
  await api.setLang('hi');
  assert.equal(store.lang, 'hi');
  assert.equal(api.getLang(), 'hi');
});
