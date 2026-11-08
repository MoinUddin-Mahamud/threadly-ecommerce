// Arabic loads Bootstrap's own right-to-left build; other languages load the normal one.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const request = require('supertest');
const { app } = require('./helpers');

const pub = (f) => path.join(__dirname, '..', 'public', f);
const sri = (file) => 'sha384-' + crypto.createHash('sha384').update(fs.readFileSync(file)).digest('base64');
const BOOTSTRAP = path.join(__dirname, '..', 'node_modules', 'bootstrap', 'dist', 'css');
const PREFIX = 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/';

// A head with the link the pages ship, and just enough DOM for i18n.js to run.
function load(pageHtml, lang) {
  const tag = pageHtml.match(/<link[^>]*bootstrap@5\.3\.3\/dist\/css\/bootstrap\.min\.css[^>]*>/)[0];
  const attr = (n) => (tag.match(new RegExp(`${n}="([^"]*)"`)) || [])[1];
  const head = { children: [] };
  const makeLink = (a) => {
    const el = {
      attrs: { ...a }, handlers: {}, parentNode: head,
      getAttribute(n) { return this.attrs[n] === undefined ? null : this.attrs[n]; },
      setAttribute(n, v) { this.attrs[n] = v; },
      addEventListener(t, fn) { this.handlers[t] = fn; }
    };
    return el;
  };
  head.insertBefore = (n, ref) => { n.parentNode = head; head.children.splice(head.children.indexOf(ref), 0, n); };
  head.removeChild = (n) => { head.children.splice(head.children.indexOf(n), 1); n.parentNode = null; };
  head.children.push(makeLink({ rel: 'stylesheet', href: attr('href'), integrity: attr('integrity'), crossorigin: attr('crossorigin') }));
  const document = {
    cookie: lang ? `lang=${lang}` : '',
    documentElement: {}, body: {},
    querySelector: (sel) => (sel.includes('bootstrap@5.3.3/dist/css/bootstrap') ? head.children.find((c) => c.attrs.href.includes('bootstrap@5.3.3/dist/css/bootstrap')) || null : null),
    createElement: () => makeLink({})
  };
  const window = {};
  const sandbox = {
    window, document, navigator: { language: 'en' }, console,
    localStorage: { getItem: () => null, setItem() {} },
    fetch: () => Promise.reject(new Error('offline'))
  };
  vm.runInNewContext(fs.readFileSync(pub('js/i18n.js'), 'utf8'), sandbox);
  const finish = () => head.children.filter((c) => c.handlers.load).forEach((c) => c.handlers.load());
  return { head, doc: document, ui: window.UI18n, finish, links: () => head.children.map((c) => c.attrs.href) };
}
const index = fs.readFileSync(pub('index.html'), 'utf8');

test('integrity values are the sha384 of the real Bootstrap 5.3.3 files', () => {
  const { ui } = load(index);
  assert.equal(ui.bootstrapCss.ltr.integrity, sri(path.join(BOOTSTRAP, 'bootstrap.min.css')));
  assert.equal(ui.bootstrapCss.rtl.integrity, sri(path.join(BOOTSTRAP, 'bootstrap.rtl.min.css')));
  assert.equal(ui.bootstrapCss.ltr.href, PREFIX + 'bootstrap.min.css');
  assert.equal(ui.bootstrapCss.rtl.href, PREFIX + 'bootstrap.rtl.min.css');
});

test('every page that loads Bootstrap CSS carries the real left-to-right hash', () => {
  const real = sri(path.join(BOOTSTRAP, 'bootstrap.min.css'));
  let checked = 0;
  for (const f of fs.readdirSync(pub('.')).filter((n) => n.endsWith('.html'))) {
    const tag = fs.readFileSync(pub(f), 'utf8').match(/<link[^>]*bootstrap@5\.3\.3\/dist\/css\/bootstrap\.min\.css[^>]*>/);
    if (!tag) { assert.equal(f, 'offline.html'); continue; }
    assert.ok(tag[0].includes(`integrity="${real}"`), f);
    checked++;
  }
  assert.ok(checked >= 10);
});

test('switching to Arabic adds the RTL build and drops the LTR one once it has loaded', () => {
  const { head, doc, ui, finish, links } = load(index);
  ui.swapBootstrap(doc, true);
  assert.equal(links().length, 2, 'both present until the new one has loaded');
  const added = head.children[0];
  assert.equal(added.attrs.href, PREFIX + 'bootstrap.rtl.min.css');
  assert.equal(added.attrs.integrity, ui.bootstrapCss.rtl.integrity);
  assert.equal(added.attrs.crossorigin, 'anonymous');
  assert.equal(added.attrs.rel, 'stylesheet');
  finish();
  assert.deepEqual(links(), [PREFIX + 'bootstrap.rtl.min.css']);
});

test('a visitor whose saved language is Arabic gets the RTL stylesheet at once', () => {
  const { finish, links } = load(index, 'ar');
  finish();
  assert.deepEqual(links(), [PREFIX + 'bootstrap.rtl.min.css']);
});

test('other languages keep the left-to-right build, and repeating a swap adds nothing', () => {
  for (const lang of [undefined, 'en', 'es', 'bn']) {
    const { finish, links } = load(index, lang);
    finish();
    assert.deepEqual(links(), [PREFIX + 'bootstrap.min.css'], String(lang));
  }
});

test('Arabic then another language swaps the left-to-right build back', () => {
  const { head, doc, ui, finish, links } = load(index, 'ar');
  finish();
  ui.swapBootstrap(doc, true);
  assert.equal(links().length, 1, 'already right-to-left: nothing to do');
  ui.swapBootstrap(doc, false);
  finish();
  assert.deepEqual(links(), [PREFIX + 'bootstrap.min.css']);
  assert.equal(head.children[0].attrs.integrity, ui.bootstrapCss.ltr.integrity);
});

test('ui2.css keeps its own right-to-left rules and does not copy Bootstrap utilities', () => {
  const css = fs.readFileSync(pub('css/ui2.css'), 'utf8');
  for (const sel of ['#cartModal .modal-dialog', '.bi-arrow-right', '.mk-footer a:hover', 'input[type="email"]', '.form-select']) {
    assert.ok(css.includes(`[dir="rtl"] ${sel}`), sel);
  }
  for (const gone of ['.ms-auto', '.me-2', '.ps-3', '.text-end', '.float-end', '.border-start', '.dropdown-menu-end', '.btn-close']) {
    assert.ok(!css.includes(`[dir="rtl"] ${gone}`), `${gone} is handled by the RTL build`);
  }
});

test('the content security policy allows the Bootstrap CDN for styles', async () => {
  const csp = (await request(app).get('/')).headers['content-security-policy'] || '';
  assert.match(csp, /style-src[^;]*https:\/\/cdn\.jsdelivr\.net/);
});

// Spanish and French keep some strings identical to English ("Total:", "Min"). Writing the same
// text back queued a new mutation each time and froze the page.
test('a translation equal to the English text is not written back, so no mutation loop starts', async () => {
  const locales = { en: { 'co.total': 'Total:', 'nav.cart': 'Cart' }, es: { 'co.total': 'Total:', 'nav.cart': 'Carrito' } };
  const node = (text) => {
    const n = { writes: 0, parentNode: { nodeName: 'SPAN' } };
    let v = text;
    Object.defineProperty(n, 'nodeValue', { get: () => v, set: (x) => { n.writes++; v = x; } });
    return n;
  };
  const same = node('Total:'), other = node('Cart');
  let observed;
  const document = {
    cookie: '', documentElement: {}, body: {},
    querySelector: () => null,
    createTreeWalker: () => { const list = [same, other]; let i = 0; return { nextNode: () => list[i++] || null }; }
  };
  const sandbox = {
    window: {}, document, navigator: { language: 'es' }, console, NodeFilter: { SHOW_TEXT: 4 },
    localStorage: { getItem: () => 'es', setItem() {} },
    MutationObserver: class { constructor(fn) { observed = fn; } observe() {} },
    fetch: (url) => Promise.resolve({ json: () => Promise.resolve(locales[url.match(/(\w+)\.json/)[1]]) })
  };
  vm.runInNewContext(fs.readFileSync(pub('js/i18n.js'), 'utf8'), sandbox);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(other.nodeValue, 'Carrito');
  assert.equal(other.writes, 1);
  assert.equal(same.nodeValue, 'Total:');
  assert.equal(same.writes, 0, 'identical text is left alone');
  observed([{ type: 'characterData', target: same }, { type: 'characterData', target: other }]);
  assert.equal(same.writes, 0);
  assert.equal(other.writes, 1, 'an already translated node is not touched again');
});
