// Product pictures: files on disk, several pictures per product, clean-up, the upload endpoints
// and the product page.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { app, OWNER } = require('./helpers');
const Product = require('../models/Product');
const images = require('../services/images');
const uploads = require('../services/uploads');
const seo = require('../services/seo');

// a real 1x1 PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const quiet = [console, 'error', () => {}];
async function withStubs(stubs, fn) {
  const saved = stubs.map(([t, n]) => [t, n, t[n]]);
  stubs.forEach(([t, n, impl]) => { t[n] = impl; });
  try { await fn(); } finally { saved.forEach(([t, n, o]) => { t[n] = o; }); }
}
async function withEnv(vars, fn) {
  const saved = Object.keys(vars).map((k) => [k, process.env[k]]);
  Object.entries(vars).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  try { await fn(); } finally { saved.forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; }); }
}
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'threadly-up-'));

test('storage mode: disk by default, database when asked', () => {
  assert.equal(uploads.storageMode({}), 'disk');
  assert.equal(uploads.storageMode({ UPLOAD_STORAGE: 'Database' }), 'database');
  assert.equal(uploads.storageMode({ UPLOAD_STORAGE: 'nonsense' }), 'disk');
  assert.equal(uploads.uploadDir({ UPLOAD_DIR: '/data/pics' }), path.resolve('/data/pics'));
});

test('an upload becomes a file with a random name and only a short address is stored', async () => {
  const dir = tmpDir();
  const env = { UPLOAD_DIR: dir };
  const url = await uploads.storeImageValue(PNG, env);
  assert.match(url, /^\/uploads\/[0-9a-f]{32}\.png$/);
  assert.ok(uploads.UPLOAD_URL.test(url));
  assert.ok(fs.existsSync(path.join(dir, path.basename(url))));
  const other = await uploads.storeImageValue(PNG, env);
  assert.notEqual(url, other, 'names are random');
  assert.equal(await uploads.storeImageValue('https://example.com/a.png', env), 'https://example.com/a.png');
  assert.equal(await uploads.storeImageValue(PNG, { ...env, UPLOAD_STORAGE: 'database' }), PNG, 'database mode keeps the data address');
});

test('an unwritable upload folder falls back to the database instead of failing', async () => {
  const file = path.join(tmpDir(), 'a-file');
  fs.writeFileSync(file, 'x');   // a FILE where the folder should be
  const warn = console.warn; console.warn = () => {};
  try { assert.equal(await uploads.storeImageValue(PNG, { UPLOAD_DIR: path.join(file, 'sub') }), PNG); } finally { console.warn = warn; }
});

test('only the exact file names this app makes are accepted as upload addresses', () => {
  for (const bad of ['/uploads/../server.js', '/uploads/abc.png', '/uploads/' + 'a'.repeat(32) + '.svg', '/uploads/' + 'g'.repeat(32) + '.png',
    '/uploads/' + 'a'.repeat(32) + '.png/../x', '//uploads/' + 'a'.repeat(32) + '.png', '/uploads/' + 'a'.repeat(32) + '.PNG']) {
    assert.equal(uploads.UPLOAD_URL.test(bad), false, bad);
  }
  assert.equal(uploads.UPLOAD_URL.test('/uploads/' + 'a1'.repeat(16) + '.webp'), true);
});

test('removeUnusedUploads deletes a file only when no product refers to it, and never touches other paths', async () => {
  const dir = tmpDir(); const env = { UPLOAD_DIR: dir };
  const keep = await uploads.storeImageValue(PNG, env);
  const drop = await uploads.storeImageValue(PNG, env);
  const outside = path.join(dir, '..', 'precious.txt'); fs.writeFileSync(outside, 'keep me');
  await withEnv({ UPLOAD_DIR: dir }, async () => withStubs([
    quiet, [Product, 'exists', async (q) => (q.$or[0].imageUrl === keep ? { _id: 1 } : null)]
  ], async () => {
    await uploads.removeUnusedUploads([keep, drop, '/uploads/../precious.txt', 'https://example.com/x.png', null]);
  }));
  assert.ok(fs.existsSync(path.join(dir, path.basename(keep))), 'still used');
  assert.ok(!fs.existsSync(path.join(dir, path.basename(drop))), 'unused file removed');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep me');
});

test('sweepOrphanUploads removes old unreferenced files only', async () => {
  const dir = tmpDir(); const env = { UPLOAD_DIR: dir };
  const used = await uploads.storeImageValue(PNG, env);
  const old = await uploads.storeImageValue(PNG, env);
  const fresh = await uploads.storeImageValue(PNG, env);
  const past = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  for (const u of [used, old]) fs.utimesSync(path.join(dir, path.basename(u)), past, past);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x'); fs.utimesSync(path.join(dir, 'notes.txt'), past, past);
  const removed = await withStubs([[Product, 'find', () => ({ select: () => ({ lean: async () => [{ imageUrl: used, images: [] }] }) })]], async () => {
    assert.equal(await uploads.sweepOrphanUploads(24 * 3600 * 1000, env), 1);
  });
  assert.ok(fs.existsSync(path.join(dir, path.basename(used))));
  assert.ok(!fs.existsSync(path.join(dir, path.basename(old))));
  assert.ok(fs.existsSync(path.join(dir, path.basename(fresh))), 'a recent upload may still be in an unsaved form');
  assert.ok(fs.existsSync(path.join(dir, 'notes.txt')), 'foreign files are never touched');
  void removed;
});

test('cleanImageList: limits, duplicates, blanks and uploads', () => {
  assert.deepEqual(images.cleanImageList(undefined), { ok: true, provided: false, values: [] });
  assert.deepEqual(images.cleanImageList([]).values, []);
  assert.deepEqual(images.cleanImageList(['https://e.com/a.png', '', 'https://e.com/a.png', '/uploads/' + 'a'.repeat(32) + '.png']).values, ['https://e.com/a.png', '/uploads/' + 'a'.repeat(32) + '.png']);
  assert.equal(images.cleanImageList(new Array(6).fill('https://e.com/a.png')).ok, false);
  assert.equal(images.cleanImageList('https://e.com/a.png').ok, false);
  assert.equal(images.cleanImageList(['javascript:alert(1)']).ok, false);
  assert.equal(images.cleanImageList(['data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=']).ok, false);
  assert.equal(images.cleanImageList([PNG]).ok, true);
  assert.equal(images.cleanImageList([PNG], { allowUploads: false }).ok, false);
});

async function ownerLogin() {
  const agent = request.agent(app);
  const res = await agent.post('/admin/login').send(OWNER);
  assert.equal(res.status, 200);
  return { agent, csrf: res.body.csrfToken };
}

test('admin upload endpoint: needs login and CSRF, stores a file, refuses non-pictures', async () => {
  const dir = tmpDir();
  const realFind = Product.find;
  Product.find = () => require('./fakeDb').chain([]);
  await withEnv({ UPLOAD_DIR: dir, UPLOAD_STORAGE: undefined }, async () => {
    assert.equal((await request(app).post('/admin/upload-image').send({ data: PNG })).status, 401);
    const o = await ownerLogin();
    assert.equal((await o.agent.post('/admin/upload-image').send({ data: PNG })).status, 403, 'no CSRF token');
    const send = (data) => o.agent.post('/admin/upload-image').set('X-CSRF-Token', o.csrf).send({ data });
    const ok = await send(PNG);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.match(ok.body.url, /^\/uploads\/[0-9a-f]{32}\.png$/);
    assert.ok(fs.existsSync(path.join(dir, path.basename(ok.body.url))));
    assert.equal((await send('https://example.com/a.png')).status, 400);
    assert.equal((await send('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).status, 400);
    assert.equal((await send('data:image/png;base64,AAAA')).status, 400, 'bytes are not a PNG');
    assert.equal((await send(undefined)).status, 400);
  }).finally(() => { Product.find = realFind; });
  await withEnv({ UPLOAD_DIR: dir, UPLOAD_STORAGE: 'database' }, async () => {
    const o = await ownerLogin();
    assert.equal((await o.agent.post('/admin/upload-image').set('X-CSRF-Token', o.csrf).send({ data: PNG })).status, 400);
  });
});

test('uploaded files are served as plain pictures; any other name is 404', async () => {
  await withEnv({ UPLOAD_DIR: undefined }, async () => {
    // the static folder is fixed when the server starts (the default folder here), so use that
    // folder for this check
    const real = path.join(__dirname, '..', 'uploads');
    const existed = fs.existsSync(real);
    fs.mkdirSync(real, { recursive: true });
    const url = await uploads.storeImageValue(PNG, { UPLOAD_DIR: real });
    try {
      const res = await request(app).get(url);
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], 'image/png');
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.match(res.headers['content-security-policy'], /sandbox/);
      assert.equal((await request(app).get('/uploads/../server.js')).status, 404);
      assert.equal((await request(app).get('/uploads/%2e%2e/server.js')).status, 404);
      assert.equal((await request(app).get('/uploads/')).status, 404);
      assert.equal((await request(app).get('/uploads/notes.txt')).status, 404);
    } finally { fs.rmSync(path.join(real, path.basename(url)), { force: true }); if (!existed) try { fs.rmdirSync(real); } catch (e) { /* not empty */ } }
  });
});

test('admin create stores uploads as files, keeps addresses, and the product gets its pictures', async () => {
  const dir = tmpDir(); const created = [];
  await withEnv({ UPLOAD_DIR: dir, UPLOAD_STORAGE: undefined }, async () => withStubs([
    quiet, [Product, 'create', async (d) => { created.push(d); return { _id: '64b7f0c2a1b2c3d4e5f60999', ...d, toObject() { return { ...this }; } }; }]
  ], async () => {
    const o = await ownerLogin();
    const post = (b) => o.agent.post('/admin/products').set('X-CSRF-Token', o.csrf).send({ title: 'Tee', price: 10, stock: 3, category: 'Men', ...b });
    const res = await post({ imageUrl: PNG, images: [PNG, 'https://example.com/b.jpg'] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(created[0].imageUrl, /^\/uploads\/[0-9a-f]{32}\.png$/);
    assert.equal(created[0].images.length, 2);
    assert.match(created[0].images[0], /^\/uploads\//);
    assert.equal(created[0].images[1], 'https://example.com/b.jpg');
    assert.equal(fs.readdirSync(dir).length, 2);
    assert.equal((await post({ images: new Array(6).fill('https://example.com/x.png') })).status, 400);
    assert.equal((await post({ images: 'nope' })).status, 400);
    const plain = await post({ imageUrl: 'https://example.com/a.png' });
    assert.equal(plain.status, 201); assert.equal(created[1].images, undefined);
  }));
});

test('deleting a product removes its picture files', async () => {
  const dir = tmpDir(); const env = { UPLOAD_DIR: dir };
  const main = await uploads.storeImageValue(PNG, env); const extra = await uploads.storeImageValue(PNG, env);
  await withEnv({ UPLOAD_DIR: dir }, async () => withStubs([
    quiet,
    [Product, 'findByIdAndDelete', async () => ({ _id: '64b7f0c2a1b2c3d4e5f60999', title: 'Tee', imageUrl: main, images: [extra] })],
    [Product, 'exists', async () => null]
  ], async () => {
    const o = await ownerLogin();
    const res = await o.agent.delete('/admin/products/64b7f0c2a1b2c3d4e5f60999').set('X-CSRF-Token', o.csrf);
    assert.equal(res.status, 200);
  }));
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('the product page shows the extra pictures and lists them in the search-engine data', () => {
  const CFG = { baseUrl: 'https://shop.example', siteName: 'Shop' };
  const doc = { _id: '64b7f0c2a1b2c3d4e5f60999', title: 'Tee', price: 10, stock: 3, category: 'Men', description: 'd',
    imageUrl: '/uploads/' + 'a'.repeat(32) + '.png', images: ['/uploads/' + 'b'.repeat(32) + '.jpg', 'https://example.com/c.webp', 'javascript:alert(1)', PNG] };
  const html = seo.renderProductPage(doc, CFG);
  assert.match(html, /id="productGallery"/);
  assert.match(html, /product-gallery\.js/);
  assert.ok(html.includes('/uploads/' + 'b'.repeat(32) + '.jpg'));
  assert.ok(!html.includes('javascript:alert'));
  assert.ok(!html.includes('base64'), 'embedded pictures never go into the page');
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.ok(ld.image.length >= 2, JSON.stringify(ld.image));
  const without = seo.renderProductPage({ ...doc, images: undefined }, CFG);
  assert.ok(!/productGallery|product-gallery/.test(without));
});

test('Docker and git files keep the pictures safe', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.match(read('docker-compose.yml'), /uploads-data:\/app\/uploads/);
  assert.match(read('Dockerfile'), /chown node:node \/app\/uploads/);
  assert.match(read('.gitignore'), /^uploads\/$/m);
  assert.match(read('.dockerignore'), /^uploads$/m);
});

function fillUploadDir(dir, count, ageMs = 0) {
  const names = [];
  for (let i = 0; i < count; i++) {
    const name = `${i.toString(16).padStart(32, '0')}.png`;
    fs.writeFileSync(path.join(dir, name), 'x');
    if (ageMs) { const t = new Date(Date.now() - ageMs); fs.utimesSync(path.join(dir, name), t, t); }
    names.push(name);
  }
  return names;
}

test('picture count: the seller\'s products plus unreferenced uploads from the last day', async () => {
  const { chain } = require('./fakeDb');
  const dir = tmpDir();
  const [used, , old, theirs] = fillUploadDir(dir, 4);
  const aged = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  fs.utimesSync(path.join(dir, old), aged, aged);
  const rows = [
    { vendorId: 'v1', imageUrl: `/uploads/${used}`, images: [] },
    { vendorId: 'v2', imageUrl: `/uploads/${theirs}`, images: [] }
  ];
  const real = Product.find;
  Product.find = (f) => chain(rows.filter((p) => (f.vendorId !== undefined ? p.vendorId === f.vendorId : f.$or[0].imageUrl.$in.includes(p.imageUrl))));
  try {
    assert.equal(await uploads.storedPictureCount('v1', { UPLOAD_DIR: dir }), 2, 'one used file and one fresh unreferenced file');
  } finally { Product.find = real; }
});

test('admin upload: the 301st stored picture is refused with 429', async () => {
  const { chain } = require('./fakeDb');
  const dir = tmpDir();
  fillUploadDir(dir, uploads.MAX_PICTURES_PER_VENDOR);
  const real = Product.find;
  Product.find = () => chain([]);
  try {
    await withEnv({ UPLOAD_DIR: dir, UPLOAD_STORAGE: undefined }, async () => {
      const o = await ownerLogin();
      const res = await o.agent.post('/admin/upload-image').set('X-CSRF-Token', o.csrf).send({ data: PNG });
      assert.equal(res.status, 429);
      assert.match(res.body.message, /at most 300 pictures/);
      assert.equal(fs.readdirSync(dir).length, 300, 'nothing was written');
    });
  } finally { Product.find = real; }
});

test('vendor upload: a shop at its picture limit gets 429, below it the upload works', async () => {
  const { withStubs: stubbed, newWorld, stubsFor, seedVendor, chain } = require('./fakeDb');
  const w = newWorld();
  const agent = request.agent(app);
  const dir = tmpDir();
  await withEnv({ MULTIVENDOR_ENABLED: 'true', UPLOAD_DIR: dir, UPLOAD_STORAGE: undefined }, () => stubbed(stubsFor(w), async () => {
    const reg = await agent.post('/api/users/register').send({ name: 'Seller', email: 'seller@example.com', password: 'LongEnough123' });
    assert.equal(reg.status, 201);
    const shop = seedVendor(w, { name: 'Mine', slug: 'mine', ownerUserId: w.users[0]._id });
    w.users[0].vendorId = shop._id;
    const real = Product.find;
    Product.find = () => chain([]);
    try {
      const ok = await agent.post('/api/vendor/upload-image').send({ data: PNG });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      fillUploadDir(dir, uploads.MAX_PICTURES_PER_VENDOR);
      const full = await agent.post('/api/vendor/upload-image').send({ data: PNG });
      assert.equal(full.status, 429);
    } finally { Product.find = real; }
  }));
});
