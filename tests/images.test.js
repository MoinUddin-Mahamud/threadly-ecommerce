// Every image the storefront and admin panel use must be bundled with the
// project: no hot-linked photos, no missing files.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (publicPath) => fs.existsSync(path.join(root, 'public', publicPath.replace(/^\//, '')));

const PAGES = ['public/index.html', 'public/admin.html', 'public/js/app.js', 'public/js/admin.js'];

test('pages and scripts do not load images from other websites', () => {
  for (const file of PAGES) {
    const hotLinked = read(file).match(/<img[^>]+src=["']https?:\/\/[^"']+/gi) || [];
    assert.deepEqual(hotLinked, [], `${file} hot-links an image`);
  }
});

test('every local image referenced by the pages exists', () => {
  const missing = [];
  for (const file of PAGES) {
    for (const [, ref] of read(file).matchAll(/["'(](\/img\/[A-Za-z0-9_\-./]+\.(?:svg|png|jpe?g|webp))/g)) {
      if (!exists(ref)) missing.push(`${file}: ${ref}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('every seed product has its own bundled image', () => {
  // The demo catalog lives in seed/catalog.js; the seed script builds each product's image address
  // from its slug.
  const refs = require('../seed/catalog').PRODUCTS.map((p) => `/img/products/${p.slug}.svg`);
  assert.ok(read('seed/seed.js').includes('/img/products/${p.slug}.svg'), 'seed.js uses the catalog slug for the image');
  assert.ok(refs.length >= 30, 'expected the demo catalog');
  assert.equal(new Set(refs).size, refs.length, 'two products share an image');
  for (const ref of refs) assert.ok(exists(ref), `${ref} is missing`);
});

test('no photo files are bundled in public/img', () => {
  const photos = fs.readdirSync(path.join(root, 'public/img')).filter((f) => /\.(jpe?g|png|webp|gif)$/i.test(f) && f !== 'og-default.png' && !/^icon-(192|512)\.png$/.test(f));
  assert.deepEqual(photos, []);
});

test('bundled SVG images are well formed and contain no scripts', () => {
  const dir = path.join(root, 'public/img');
  const files = [path.join(dir, 'logo.svg'), path.join(dir, 'hero.svg'),
    ...fs.readdirSync(path.join(dir, 'products')).map((f) => path.join(dir, 'products', f))];
  for (const file of files) {
    const svg = fs.readFileSync(file, 'utf8');
    assert.match(svg, /^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, file);
    assert.match(svg, /<\/svg>\s*$/, file);
    assert.ok(!/<script|onload=|onerror=|href=/i.test(svg), `${file} contains active content`);
  }
});

test('a picture address must be https or a file of this site', () => {
  const { cleanImageInput } = require('../services/images');
  assert.equal(cleanImageInput('https://cdn.example.org/a.png').ok, true);
  assert.equal(cleanImageInput('/img/products/a.png').ok, true);
  const plain = cleanImageInput('http://cdn.example.org/a.png');
  assert.equal(plain.ok, false);
  assert.equal(plain.message, 'Image address must start with https:// or /.');
});
