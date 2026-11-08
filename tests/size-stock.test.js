// Stock per size: the helpers, the atomic updates (against a small in-memory fake that
// understands the exact update shapes the app sends), the CSV column and the storefront/seller
// scripts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Product = require('../models/Product');
const { withStubs } = require('./fakeDb');
const sizes = require('../services/sizes');
const stock = require('../services/stock');
const { reserveItems, restockItems } = require('../services/orderService');
const { checkRow, parseSizesCell } = require('../services/csvImport');

// a small fake for the product collection
const getPath = (d, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), d);
const setPath = (d, p, v) => { const ks = p.split('.'); let o = d; ks.slice(0, -1).forEach((k) => { if (typeof o[k] !== 'object' || o[k] === null) o[k] = {}; o = o[k]; }); o[ks[ks.length - 1]] = v; };
const delPath = (d, p) => { const ks = p.split('.'); let o = d; for (const k of ks.slice(0, -1)) { if (!o || typeof o[k] !== 'object') return; o = o[k]; } if (o) delete o[ks[ks.length - 1]]; };
function ok(doc, f) {
  return Object.entries(f).every(([k, c]) => {
    if (k === '_id') return String(doc._id) === String(c);
    const v = getPath(doc, k);
    if (c && typeof c === 'object' && '$gte' in c) return typeof v === 'number' && v >= c.$gte;
    if (c && typeof c === 'object' && '$exists' in c) return (v !== undefined) === c.$exists;
    return v === c;
  });
}
// Evaluates the few aggregation expressions the stock pipeline uses.
function ev(e, doc) {
  if (typeof e === 'string' && e.startsWith('$$')) return doc.__vars[e.slice(2).split('.')[0]] === undefined ? undefined : getPath(doc.__vars, e.slice(2));
  if (typeof e === 'string' && e.startsWith('$')) return getPath(doc, e.slice(1));
  if (!e || typeof e !== 'object') return e;
  if ('$ifNull' in e) { const v = ev(e.$ifNull[0], doc); return v === undefined || v === null ? ev(e.$ifNull[1], doc) : v; }
  if ('$add' in e) return e.$add.reduce((s, x) => s + ev(x, doc), 0);
  if ('$max' in e) return Math.max(...e.$max.map((x) => ev(x, doc)));
  if ('$min' in e) return Math.min(...e.$min.map((x) => ev(x, doc)));
  if ('$objectToArray' in e) { const o = ev(e.$objectToArray, doc); return o ? Object.entries(o).map(([k, v]) => ({ k, v })) : null; }
  if ('$map' in e) { const arr = ev(e.$map.input, doc); return arr ? arr.map((item) => { doc.__vars = { [e.$map.as]: item }; return ev(e.$map.in, doc); }) : null; }
  if ('$sum' in e) { const a = ev(e.$sum, doc); return Array.isArray(a) ? a.reduce((s, x) => s + (Number(x) || 0), 0) : Number(a) || 0; }
  throw new Error('unsupported expression ' + JSON.stringify(e));
}
function makeStore(docs) {
  const find = (f) => docs.find((d) => ok(d, f)) || null;
  const copy = (d) => (d ? JSON.parse(JSON.stringify(d)) : d);
  return [
    [Product, 'findOneAndUpdate', async (f, u, o) => {
      const d = find(f); if (!d) return null;
      const before = copy(d);
      if (Array.isArray(u)) {
        for (const st of u) {
          if (st.$set) { const out = {}; for (const [k, v] of Object.entries(st.$set)) { d.__vars = {}; out[k] = ev(v, d); } Object.entries(out).forEach(([k, v]) => setPath(d, k, v)); }
          if (st.$unset) st.$unset.forEach((k) => delPath(d, k));
        }
      } else {
        Object.entries(u.$inc || {}).forEach(([k, v]) => setPath(d, k, (getPath(d, k) || 0) + v));
        Object.keys(u.$unset || {}).forEach((k) => delPath(d, k));
      }
      delete d.__vars;
      return o && (o.new || o.returnDocument === 'after') ? copy(d) : before;
    }],
    [Product, 'updateOne', async (f, u) => {
      const d = find(f); if (!d) return { matchedCount: 0, modifiedCount: 0 };
      Object.entries(u.$inc || {}).forEach(([k, v]) => setPath(d, k, (getPath(d, k) || 0) + v));
      return { matchedCount: 1, modifiedCount: 1 };
    }]
  ];
}
const tee = (over = {}) => ({ _id: 'p1', title: 'Tee', stock: 7, sizeStock: { S: 3, M: 0, L: 4 }, ...over });
const line = (over = {}) => ({ productId: 'p1', title: 'Tee', quantity: 1, size: 'S', sizeTracked: true, ...over });

test('sizes: keys, canonical names and per-size reading', () => {
  assert.equal(sizes.sizeKey('One Size'), 'OneSize');
  assert.equal(sizes.canonicalSize('one size'), 'One Size');
  assert.equal(sizes.canonicalSize('m'), 'M');
  assert.equal(sizes.canonicalSize('XXXL'), null);
  assert.equal(sizes.tracksSizes({ sizeStock: { S: 1 } }), true);
  assert.equal(sizes.tracksSizes({ sizeStock: {} }), false);
  assert.equal(sizes.tracksSizes({ stock: 3 }), false);
  assert.equal(sizes.unitsOf(tee(), 'L'), 4);
  assert.equal(sizes.unitsOf(tee(), 'XL'), 0);
  assert.equal(sizes.sizeStockTotal({ S: 3, M: 0, L: 4 }), 7);
});

test('cleanSizeStock: not sent, switched off, valid and invalid input', () => {
  assert.deepEqual(sizes.cleanSizeStock(undefined), { ok: true, provided: false });
  assert.deepEqual(sizes.cleanSizeStock({}), { ok: true, provided: true, value: null });
  assert.deepEqual(sizes.cleanSizeStock({ S: '3', 'One Size': 2, m: '' }).value, { S: 3, OneSize: 2, M: 0 });
  for (const bad of [{ XXXL: 1 }, { S: -1 }, { S: 1.5 }, { S: 'abc' }, { S: 100001 }, [1, 2], 'S:3', { S: '1e3' }]) {
    assert.equal(sizes.cleanSizeStock(bad).ok, false, JSON.stringify(bad));
  }
  // prototype pollution style keys are unknown sizes
  assert.equal(sizes.cleanSizeStock(JSON.parse('{"__proto__": 1}')).ok, false);
});

test('reserveItems takes from the chosen size and the total; the last unit cannot be sold twice', async () => {
  const docs = [tee({ sizeStock: { S: 1, M: 5 }, stock: 6 })];
  await withStubs(makeStore(docs), async () => {
    const [a, b] = await Promise.all([reserveItems([line()]), reserveItems([line()])]);
    assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
    assert.equal(docs[0].sizeStock.S, 0);
    assert.equal(docs[0].sizeStock.M, 5);
    assert.equal(docs[0].stock, 5);
  });
});

test('reserveItems: a sold-out size fails even when other sizes have stock, and gives back earlier lines', async () => {
  const docs = [tee()];
  await withStubs(makeStore(docs), async () => {
    const r = await reserveItems([line({ size: 'L', quantity: 2 }), line({ size: 'M' })]);
    assert.equal(r.ok, false);
    assert.equal(docs[0].sizeStock.L, 4, 'the L units taken first were put back');
    assert.equal(docs[0].stock, 7);
  });
});

test('restockItems returns units to the size; legacy lines and products that left per-size tracking use the total', async () => {
  const docs = [tee({ sizeStock: { S: 0 }, stock: 0 }), { _id: 'p2', stock: 2 }, { _id: 'p3', stock: 1 }];
  await withStubs(makeStore(docs), async () => {
    await restockItems([line({ quantity: 2 })]);
    assert.equal(docs[0].sizeStock.S, 2); assert.equal(docs[0].stock, 2);
    await restockItems([{ productId: 'p2', quantity: 3, size: 'M' }]);   // an older order: no sizeTracked
    assert.equal(docs[1].stock, 5); assert.equal(docs[1].sizeStock, undefined);
    await restockItems([{ productId: 'p3', quantity: 4, size: 'M', sizeTracked: true }]);   // the product stopped tracking sizes
    assert.equal(docs[2].stock, 5); assert.equal(docs[2].sizeStock, undefined);
  });
});

test('a legacy product (no sizeStock) is reserved exactly as before', async () => {
  const docs = [{ _id: 'p9', stock: 2 }];
  await withStubs(makeStore(docs), async () => {
    assert.equal((await reserveItems([{ productId: 'p9', title: 'x', quantity: 2, size: 'M' }])).ok, true);
    assert.equal(docs[0].stock, 0);
    assert.equal((await reserveItems([{ productId: 'p9', title: 'x', quantity: 1, size: 'M' }])).ok, false);
  });
});

test('applySizeStockChange applies only the change, so units sold while the form was open stay sold', async () => {
  const docs = [tee({ sizeStock: { S: 10, M: 5 }, stock: 15 })];
  await withStubs(makeStore(docs), async () => {
    // the form was opened with S=10; an order then took 3 (S=7); the seller saves S=12 (+2)
    docs[0].sizeStock.S = 7; docs[0].stock = 12;
    const updated = await stock.applySizeStockChange('p1', { S: 10, M: 5 }, { S: 12, M: 5 });
    assert.equal(updated.sizeStock.S, 9);
    assert.equal(updated.sizeStock.M, 5);
    assert.equal(updated.stock, 14, 'the total is the sum of the sizes');
  });
});

test('applySizeStockChange: new sizes, removed sizes, clamping at zero and starting from a single stock number', async () => {
  const docs = [tee({ sizeStock: { S: 2, M: 5 }, stock: 7 })];
  await withStubs(makeStore(docs), async () => {
    docs[0].sizeStock.S = 0; docs[0].stock = 5;   // two units sold meanwhile
    const u = await stock.applySizeStockChange('p1', { S: 2, M: 5 }, { S: 0, XL: 4 });   // S set to 0, M removed, XL added
    assert.deepEqual(u.sizeStock, { S: 0, XL: 4 });   // never below zero
    assert.equal(u.stock, 4);
  });
  const legacy = [{ _id: 'p5', stock: 10 }];
  await withStubs(makeStore(legacy), async () => {
    const u = await stock.applySizeStockChange('p5', {}, { S: 6, L: 4 });
    assert.deepEqual(u.sizeStock, { S: 6, L: 4 });
    assert.equal(u.stock, 10);
  });
});

test('clearSizeStock keeps the total and drops the sizes', async () => {
  const docs = [tee()];
  await withStubs(makeStore(docs), async () => {
    const u = await stock.clearSizeStock('p1');
    assert.equal(u.sizeStock, undefined); assert.equal(u.stock, 7);
  });
});

test('CSV: the sizes column is read and checked', () => {
  assert.deepEqual(parseSizesCell('S:5;M:3;One Size:1').value, { S: 5, M: 3, OneSize: 1 });
  assert.deepEqual(parseSizesCell('s=2|l=4').value, { S: 2, L: 4 });
  for (const bad of ['S5', 'XXXL:1', 'S:1;s:2', 'S:-1', 'S:x', ';;']) assert.ok(parseSizesCell(bad).error, bad);
  const r = checkRow({ title: 'Tee', price: '10', category: 'Men', sizes: 'S:2;M:3', stock: '99' });
  assert.deepEqual(r.values.sizeStock, { S: 2, M: 3 });
  assert.equal(r.values.stock, 5, 'the stock cell is replaced by the sum of the sizes');
});

test('Product and Order models carry the new fields', () => {
  assert.ok(Product.schema.path('sizeStock'));
  assert.ok(require('../models/Order').schema.path('items').schema.path('sizeTracked'));
});

test('storefront and seller scripts offer only the sizes a product keeps, and mark sold-out ones', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  assert.match(app, /function sizeOptionsHtml/);
  assert.match(app, /\(sold out\)/);
  assert.match(app, /availableFor\(product, size\)/);
  const grid = fs.readFileSync(path.join(__dirname, '../public/js/size-grid.js'), 'utf8');
  assert.match(grid, /previousSizeStock/);
  for (const page of ['admin.html', 'vendor.html']) {
    assert.match(fs.readFileSync(path.join(__dirname, '../public', page), 'utf8'), /\/js\/size-grid\.js/);
  }
});
