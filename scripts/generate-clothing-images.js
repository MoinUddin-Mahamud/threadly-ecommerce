// Draws the demo product pictures (public/img/products/*.svg) from seed/catalog.js. node
// scripts/generate-clothing-images.js It is safe to re-run.
const fs = require('fs');
const path = require('path');
const { PRODUCTS } = require('../seed/catalog');
const { productSvg } = require('./lib/garments');

const dir = path.join(__dirname, '..', 'public', 'img', 'products');
fs.mkdirSync(dir, { recursive: true });
const wanted = new Set(PRODUCTS.map((p) => `${p.slug}.svg`));

// Remove pictures of products that are no longer in the catalog (e.g. from an earlier catalog).
for (const file of fs.readdirSync(dir)) {
  if (file.endsWith('.svg') && !wanted.has(file)) fs.unlinkSync(path.join(dir, file));
}
for (const p of PRODUCTS) {
  fs.writeFileSync(path.join(dir, `${p.slug}.svg`), productSvg({ title: p.title, type: p.garment, color: p.color, kids: p.kids }));
}
console.log(`Wrote ${PRODUCTS.length} product pictures to public/img/products/`);
