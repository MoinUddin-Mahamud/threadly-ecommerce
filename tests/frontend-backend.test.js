// The pages and the server agree: every address a script calls exists on the server with the same
// method, every element id a script looks up exists on a page that loads it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function checkEndpoints() {
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Backend routes as { METHOD path-regex }
const mounts = { 'routes/api.js': '/api', 'routes/users.js': '/api/users', 'routes/vendor.js': '/api/vendor', 'routes/admin.js': '/admin', 'routes/adminExtras.js': '/admin', 'routes/seo.js': '', 'routes/setup.js': '/api/setup' };
const routes = [];
for (const [file, prefix] of Object.entries(mounts)) {
  const src = read(file);
  const re = /\b(\w+)\.(get|post|put|patch|delete)\(\s*(\[[^\]]*\]|'[^']*'|`[^`]*`)/g;
  let m;
  while ((m = re.exec(src))) {
    const owner = m[1];
    const method = m[2].toUpperCase();
    const paths = m[3].startsWith('[') ? [...m[3].matchAll(/'([^']*)'/g)].map((x) => x[1]) : [m[3].slice(1, -1)];
    // vendor.js has two routers: shopsRouter is mounted at /api/shops
    const base = file === 'routes/vendor.js' && owner === 'shopsRouter' ? '/api/shops' : prefix;
    for (const p of paths) routes.push({ method, path: base + (p === '/' ? '' : p), file });
  }
}
const toRegex = (p) => new RegExp('^' + p.replace(/:[A-Za-z]+/g, '[^/]+').replace(/\//g, '\\/') + '\\/?$');
const compiled = routes.map((r) => ({ ...r, re: toRegex(r.path) }));
const find = (method, url) => compiled.filter((r) => r.re.test(url) && (r.method === method));
const findAny = (url) => compiled.filter((r) => r.re.test(url));

function readArg(src, i) {            // reads one call argument starting at i; string pieces kept
  let out = '', depth = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1, lit = '';
      while (j < src.length && src[j] !== ch) { if (src[j] === '\\') j++; lit += src[j]; j++; }
      out += lit; i = j + 1; continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) break; depth--; }
    if (ch === ',' && depth === 0) break;
    if (ch === '+' && depth === 0) { i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    // an identifier / call expression piece
    let j = i; let d = 0;
    while (j < src.length) { const c = src[j]; if (c === '(' || c === '[') d++; else if (c === ')' || c === ']') { if (d === 0) break; d--; } else if (d === 0 && (c === '+' || c === ',' || /\s/.test(c))) break; j++; }
    out += 'X'; i = j;
  }
  return out;
}
const calls = [];
for (const f of fs.readdirSync(path.join(ROOT, 'public/js')).filter((x) => x.endsWith('.js'))) {
  const src = read('public/js/' + f);
  const lineOf = (idx) => src.slice(0, idx).split('\n').length;
  const add = (method, url, idx) => calls.push({ f, method, url, line: lineOf(idx) });
  let m;
  const reFetch = /\bfetch\(\s*/g;
  while ((m = reFetch.exec(src))) {
    const url = readArg(src, m.index + m[0].length);
    if (!/^\/(api|admin)/.test(url)) continue;
    const after = src.slice(m.index, m.index + 400);
    const mm = /method:\s*'(\w+)'/.exec(after.split('fetch(')[1] || after);
    add(mm ? mm[1].toUpperCase() : 'GET', url, m.index);
  }
  const reApi = /\bapi\(\s*'(GET|POST|PUT|PATCH|DELETE)'\s*,\s*/g;
  while ((m = reApi.exec(src))) add(m[1], readArg(src, m.index + m[0].length), m.index);
  const reHelp = /\bapi(Get|Post|Put|Patch|Delete)\(\s*/g;
  while ((m = reHelp.exec(src))) add(m[1].toUpperCase(), readArg(src, m.index + m[0].length), m.index);
  const reAjax = /\$\.(get|post)\(\s*/g;
  while ((m = reAjax.exec(src))) add(m[1].toUpperCase(), readArg(src, m.index + m[0].length), m.index);
}
let bad = 0, checked = 0; const problems = [];
const seen = new Set();
for (const c of calls) {
  const url = c.url.split('?')[0].replace(/\$\{[^}]*\}/g, 'X');
  if (!/^\/(api|admin)\b/.test(url)) continue;
  const key = c.method + ' ' + url; if (seen.has(key)) continue; seen.add(key);
  checked++;
  if (!find(c.method, url).length) {
    const other = findAny(url);
    bad++;
    problems.push(`${c.f}:${c.line} ${c.method} ${c.url} -> ` + (other.length ? 'server has ' + other.map((o) => o.method).join('/') + ' only' : 'no such route'));
  }
}
return { problems, checked, routes: routes.length };

}

function checkIds() {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const htmls = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.html'));
const htmlIds = {}; // file name to Set of ids
for (const f of htmls) htmlIds[f] = new Set([...read('public/' + f).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const allHtml = new Set(Object.values(htmlIds).flatMap((s) => [...s]));
const pageOf = {};
for (const f of htmls) for (const m of read('public/' + f).matchAll(/src="\/js\/([A-Za-z0-9_.-]+\.js)"/g)) (pageOf[m[1]] = pageOf[m[1]] || []).push(f);
// The product page is built by the server (services/seo.js): its element ids and the scripts it
// loads count as a page.
const seoSrc = read('services/seo.js');
htmlIds['(product page)'] = new Set([...seoSrc.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
for (const m of seoSrc.matchAll(/src="\/js\/([A-Za-z0-9_.-]+\.js)"/g)) (pageOf[m[1]] = pageOf[m[1]] || []).push('(product page)');
const problems = [];
for (const js of fs.readdirSync(path.join(ROOT, 'public/js')).filter((f) => f.endsWith('.js'))) {
  const src = read('public/js/' + js);
  const dynamic = new Set([...src.matchAll(/\bid=\\?["']([A-Za-z0-9_-]+)\\?["']/g)].map((m) => m[1]).concat([...src.matchAll(/\.id\s*=\s*['"]([A-Za-z0-9_-]+)['"]/g)].map((m) => m[1]), [...src.matchAll(/\bid:\s*['"]([A-Za-z0-9_-]+)['"]/g)].map((m) => m[1])));
  const used = new Set([...src.matchAll(/\$\(\s*['"`]#([A-Za-z][A-Za-z0-9_-]*)['"`]/g)].map((m) => m[1]).concat([...src.matchAll(/getElementById\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g)].map((m) => m[1]), [...src.matchAll(/\$\(\s*'([A-Za-z0-9_-]+)'\s*\)/g)].filter(() => js.startsWith('payment')).map((m) => m[1])));
  const pages = pageOf[js] || [];
  for (const id of used) {
    const onPage = pages.some((p) => htmlIds[p].has(id));
    if (onPage || dynamic.has(id)) continue;
    problems.push(`${js}: #${id} ${allHtml.has(id) ? 'is only on another page than the ones loading this script (' + pages.join(', ') + ')' : 'is not in any page and not created by the script'}`);
  }
}
return problems;

}

test('every address the browser scripts call exists on the server with the same HTTP method', () => {
  const r = checkEndpoints();
  assert.deepEqual(r.problems, []);
  assert.ok(r.checked >= 35, `only ${r.checked} calls were found: the checker may be broken`);
  assert.ok(r.routes >= 100, `only ${r.routes} routes were found: the checker may be broken`);
});

test('every element id a script looks up exists on a page that loads that script (or is created by the script)', () => {
  assert.deepEqual(checkIds(), []);
});

test('every linked style sheet and script exists, and every script in public/js is loaded by some page', () => {
  const pages = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.html'));
  const loaded = new Set();
  for (const f of pages) {
    const html = read(`public/${f}`);
    for (const m of html.matchAll(/(?:src|href)="(\/[^"#?]+)"/g)) {
      if (/^\/(api|admin|product|socket\.io|manifest\.webmanifest)\b/.test(m[1]) || m[1] === '/' || /^\/(index|privacy|terms|returns|shipping|faq|contact|vendor|admin|payment-success|payment-fail)\.html$/.test(m[1])) continue;
      assert.ok(fs.existsSync(path.join(ROOT, 'public', m[1])), `${f} links to ${m[1]}, which does not exist`);
      if (m[1].startsWith('/js/')) loaded.add(m[1].slice(4));
    }
  }
  // Pages the server builds (the product page) load their own scripts.
  for (const m of read('services/seo.js').matchAll(/src="(\/js\/[^"]+)"/g)) loaded.add(m[1].slice(4));
  for (const f of fs.readdirSync(path.join(ROOT, 'public/js'))) assert.ok(loaded.has(f), `public/js/${f} is not loaded by any page`);
  for (const f of fs.readdirSync(path.join(ROOT, 'public/css'))) assert.ok(pages.some((p) => read(`public/${p}`).includes(`/css/${f}`)), `public/css/${f} is not used by any page`);
});

test('the fields the browser reads from the order reply and the payment status reply are in those replies', () => {
  const app = read('public/js/app.js');
  const api = read('routes/api.js');
  const call = app.lastIndexOf('placeOrder(name, email, phone, address, paymentGateway)');
  const keys = [...new Set([...app.slice(call, call + 2800).matchAll(/\bdata\.([A-Za-z]+)/g)].map((m) => m[1]))];
  assert.ok(keys.length >= 6, `found ${keys.join(', ')}`);
  const start = api.indexOf("router.post('/orders', sameOrigin, orderLimiter");
  const orderRoute = api.slice(start, api.indexOf('router.', start + 10));
  for (const k of keys) assert.match(orderRoute, new RegExp(`\\b${k}\\b`), `the order reply has ${k}`);
  const s2 = api.indexOf("router.get('/payment/status'");
  const status = api.slice(s2, s2 + 4000);
  for (const k of ['amount', 'found', 'gateway', 'status', 'underReview']) assert.match(status, new RegExp(`\\b${k}\\b`), `the payment status reply has ${k}`);
});

test('the storefront confirms the emailed token with POST /api/users/verify-email', () => {
  const app = read('public/js/app.js');
  assert.match(app, /verifyToken=/);
  assert.match(app, /fetch\('\/api\/users\/verify-email',\s*\{\s*method: 'POST'/);
  assert.match(read('routes/users.js'), /router\.post\('\/verify-email'/);
});

test('escapeHtml shows a number 0 and only turns null and undefined into nothing', () => {
  const vm = require('node:vm');
  for (const file of ['public/js/app.js', 'public/js/admin.js']) {
    const source = read(file).match(/function escapeHtml\(text\) \{[\s\S]*?\n\}/)[0];
    const escapeHtml = vm.runInNewContext(`(${source})`);
    assert.equal(escapeHtml(0), '0', file);
    assert.equal(escapeHtml(null), '', file);
    assert.equal(escapeHtml(undefined), '', file);
    assert.equal(escapeHtml(''), '', file);
    assert.equal(escapeHtml('<b>"x" & \'y\'</b>'), '&lt;b&gt;&quot;x&quot; &amp; &#039;y&#039;&lt;/b&gt;', file);
  }
});

test('the storefront and the size grid get the sizes from GET /api/sizes, not from their own copy', async () => {
  const request = require('supertest');
  const { app } = require('./helpers');
  const { SIZES } = require('../services/sizes');
  const res = await request(app).get('/api/sizes');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.sizes, SIZES);
  for (const file of ['public/js/app.js', 'public/js/size-grid.js']) {
    const source = read(file);
    assert.match(source, /fetch\('\/api\/sizes'\)/, file);
    assert.ok(!/'XXL'/.test(source), `${file} has no hard-coded size list`);
  }
});
