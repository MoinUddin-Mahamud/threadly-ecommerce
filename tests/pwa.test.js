// Installable store: the manifest, the icons, the service worker rules and the cache headers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { app } = require('./helpers');
const sw = require('../public/sw.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('the manifest is JSON, named after the shop, and points at icons that exist', async () => {
  const res = await request(app).get('/manifest.webmanifest');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /application\/manifest\+json/);
  const m = JSON.parse(res.text);
  assert.ok(m.name && m.short_name && m.short_name.length <= 12);
  assert.equal(m.display, 'standalone'); assert.equal(m.start_url, '/'); assert.equal(m.scope, '/');
  const sizes = m.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
  for (const icon of m.icons) assert.ok(fs.existsSync(path.join(ROOT, 'public', icon.src)), icon.src);
});

test('the PNG icons are real PNG files of the declared size', () => {
  for (const size of [192, 512]) {
    const b = fs.readFileSync(path.join(ROOT, 'public/img', `icon-${size}.png`));
    assert.deepEqual([...b.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(b.readUInt32BE(16), size); assert.equal(b.readUInt32BE(20), size);
  }
});

test('the home page links the manifest and registers the worker from a file (no inline script)', () => {
  const html = read('public/index.html');
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /name="theme-color"/);
  assert.match(html, /src="\/js\/pwa\.js"/);
  assert.match(read('public/js/pwa.js'), /serviceWorker\.register\('\/sw\.js'\)/);
});

test('service worker: store files are handled, private and dynamic things never are', () => {
  const o = 'https://shop.example';
  assert.equal(sw.routeFor('GET', `${o}/img/logo.svg`, 'no-cors'), 'images');
  assert.equal(sw.routeFor('GET', `${o}/css/styles.css`, 'no-cors'), 'assets');
  assert.equal(sw.routeFor('GET', `${o}/js/app.js`, 'no-cors'), 'assets');
  assert.equal(sw.routeFor('GET', `${o}/`, 'navigate'), 'page');
  assert.equal(sw.routeFor('GET', `${o}/index.html`, 'navigate'), 'page');
  for (const never of ['/api/products', '/api/users/my-orders', '/admin.html', '/admin/products', '/vendor.html', '/payment-success.html',
    '/socket.io/?EIO=4', '/uploads/' + 'a'.repeat(32) + '.png', '/product/64b7f0c2a1b2c3d4e5f60999', '/manifest.webmanifest']) {
    assert.equal(sw.routeFor('GET', o + never, 'navigate'), null, never);
    assert.equal(sw.routeFor('GET', o + never, 'cors'), null, never);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(sw.routeFor(method, `${o}/img/logo.svg`, 'cors'), null);
  assert.equal(sw.routeFor('GET', `${o}/js/app.js?token=abc`, 'no-cors'), null, 'links that carry a secret are never kept');
  assert.equal(sw.routeFor('GET', 'not a url', 'cors'), null);
});

test('service worker: only complete, same-site, cacheable answers are kept', () => {
  const res = (status, type, cc) => ({ status, type, headers: { get: (h) => (h === 'Cache-Control' ? cc : null) } });
  assert.equal(sw.cacheable(res(200, 'basic', 'public, max-age=60')), true);
  assert.equal(sw.cacheable(res(200, 'basic', null)), true);
  assert.equal(sw.cacheable(res(404, 'basic', null)), false);
  assert.equal(sw.cacheable(res(206, 'basic', null)), false);
  assert.equal(sw.cacheable(res(200, 'cors', null)), false);
  assert.equal(sw.cacheable(res(200, 'opaque', null)), false);
  assert.equal(sw.cacheable(res(200, 'basic', 'no-store')), false);
  assert.equal(sw.cacheable(res(200, 'basic', 'private, max-age=0')), false);
  assert.equal(sw.cacheable(null), false);
});

test('the worker file is served from the root, checked on every visit, and the offline page exists', async () => {
  const res = await request(app).get('/sw.js');
  assert.equal(res.status, 200);
  assert.match(res.headers['cache-control'], /no-cache/);
  assert.match(res.headers['content-type'], /javascript/);
  assert.equal((await request(app).get('/offline.html')).status, 200);
  const img = await request(app).get('/img/icon-192.png');
  assert.match(img.headers['cache-control'], /max-age=604800/);
  const js = await request(app).get('/js/app.js');
  assert.match(js.headers['cache-control'], /no-cache/);
});

test('the content security policy still allows the worker and the manifest, and stays strict', async () => {
  const csp = (await request(app).get('/')).headers['content-security-policy'];
  assert.match(csp, /default-src 'self'/);
  assert.doesNotMatch(csp, /worker-src[^;]*\*/);
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
});

test('service worker: one cache without a version number, and scripts load network first', () => {
  assert.match(read('public/sw.js'), /const CACHE = 'store-static';/);
  assert.doesNotMatch(read('public/sw.js'), /VERSION/);
  const src = read('public/sw.js');
  const assets = src.slice(src.indexOf('Scripts and style sheets'));
  assert.ok(assets.indexOf('fetch(request)') < assets.indexOf('cache.match(request)'), 'the network is tried before the cache');
});
