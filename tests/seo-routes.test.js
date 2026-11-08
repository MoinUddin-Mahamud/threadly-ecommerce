// HTTP tests for the SEO pages: the storefront's meta tags, /robots.txt,
// /sitemap.xml, /product/:id and the noindex header on admin routes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('./helpers');
const Product = require('../models/Product');
const seo = require('../services/seo');

const ID = '64b7f0c2a1b2c3d4e5f60718';
const OTHER_ID = '64b7f0c2a1b2c3d4e5f60999';
const EVIL = '"><script>alert(1)</script>';

async function withStubs(stubs, fn) {
  const saved = stubs.map(([target, name]) => [target, name, target[name]]);
  stubs.forEach(([target, name, impl]) => { target[name] = impl; });
  try { await fn(); } finally { saved.forEach(([target, name, original]) => { target[name] = original; }); }
}
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { await fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
const quiet = [console, 'error', () => {}];
const SHOP = { BASE_URL: 'https://shop.example.com', SITE_NAME: 'Acme Apparel', SITE_DESCRIPTION: 'Warm coats for everyone.' };

const product = (extra = {}) => ({
  _id: ID, title: 'Cotton Shirt', description: 'Warm and light.', price: 8999, stock: 12,
  category: 'Men', imageUrl: '/img/products/cotton-shirt-men.svg', ...extra
});

// Mimics Product.find().select().sort().limit().lean() and records what it was asked.
function findStub(rows, calls = {}) {
  return () => {
    const q = {
      select(v) { calls.select = v; return q; },
      sort(v) { calls.sort = v; return q; },
      limit(v) { calls.limit = v; return q; },
      lean: async () => rows
    };
    return q;
  };
}
const ldBlocks = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

test('the home page has the SEO tags built from the settings, and is still the storefront', async () => {
  await withEnv(SHOP, async () => {
    const res = await request(app).get('/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /<title>Acme Apparel - Online Clothing Marketplace<\/title>/);
    assert.match(res.text, /name="description" content="Warm coats for everyone\."/);
    assert.match(res.text, /<link rel="canonical" href="https:\/\/shop\.example\.com\/" \/>/);
    assert.match(res.text, /property="og:title"/);
    assert.match(res.text, /property="og:image" content="https:\/\/shop\.example\.com\/img\/logo\.svg"/);
    assert.match(res.text, /name="twitter:card"/);
    const types = ldBlocks(res.text).map((b) => b['@type']).sort();
    assert.deepEqual(types, ['Organization', 'WebSite']);
    // the rest of the page is untouched
    assert.match(res.text, /Our Collection/);
    assert.match(res.text, /\/js\/app\.js/);
    assert.ok(!res.text.includes('<!--SEO_HEAD-->'));
  });
});

test('/index.html is the same page, and the canonical link ignores the query string', async () => {
  await withEnv(SHOP, async () => {
    for (const url of ['/index.html', '/?emailVerified=1', '/?utm_source=x&ref=y']) {
      const res = await request(app).get(url);
      assert.equal(res.status, 200, url);
      assert.match(res.text, /<link rel="canonical" href="https:\/\/shop\.example\.com\/" \/>/, url);
    }
  });
});

test('canonical links come from BASE_URL, never from the Host header', async () => {
  await withEnv(SHOP, async () => {
    const res = await request(app).get('/').set('Host', 'evil.test').set('X-Forwarded-Host', 'evil.test');
    assert.ok(!res.text.includes('evil.test'));
    assert.match(res.text, /href="https:\/\/shop\.example\.com\/"/);
  });
});

test('hostile SITE_NAME / SITE_DESCRIPTION values are escaped in the served page', async () => {
  await withEnv({ ...SHOP, SITE_NAME: EVIL, SITE_DESCRIPTION: EVIL }, async () => {
    const res = await request(app).get('/');
    assert.ok(!res.text.includes(EVIL));
    assert.ok(res.text.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;'));
  });
});

test('/robots.txt is plain text and points to the sitemap on BASE_URL', async () => {
  await withEnv(SHOP, async () => {
    const res = await request(app).get('/robots.txt');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/plain/);
    assert.match(res.text, /^Sitemap: https:\/\/shop\.example\.com\/sitemap\.xml$/m);
    assert.match(res.text, /^Disallow: \/api\/$/m);
    assert.match(res.text, /^Disallow: \/admin\/$/m);
  });
});

test('/sitemap.xml lists the home page and the products in the database', async () => {
  const calls = {};
  await withEnv(SHOP, async () => {
    await withStubs([[Product, 'find', findStub([{ _id: ID, updatedAt: new Date('2026-01-02T00:00:00Z') }, { _id: OTHER_ID }], calls)]], async () => {
      const res = await request(app).get('/sitemap.xml');
      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], /application\/xml/);
      assert.match(res.text, /<loc>https:\/\/shop\.example\.com\/<\/loc>/);
      assert.ok(res.text.includes(`<loc>https://shop.example.com/product/${ID}</loc>`));
      assert.ok(res.text.includes(`<loc>https://shop.example.com/product/${OTHER_ID}</loc>`));
      assert.ok(res.text.includes('<lastmod>2026-01-02T00:00:00.000Z</lastmod>'));
    });
  });
  assert.equal(calls.select, '_id updatedAt vendorId');  // only what the sitemap needs (vendorId
  assert.equal(calls.limit, seo.MAX_SITEMAP_PRODUCTS);   // bounded
});

test('a database error gives a plain 500 for the sitemap, without leaking the error', async () => {
  await withStubs([quiet, [Product, 'find', () => { throw new Error('mongo secret host down'); }]], async () => {
    const res = await request(app).get('/sitemap.xml');
    assert.equal(res.status, 500);
    assert.ok(!res.text.includes('mongo secret'));
  });
});

test('/product/:id is a server-rendered page with its own tags and Product JSON-LD', async () => {
  await withEnv(SHOP, async () => {
    let askedFor = null;
    await withStubs([[Product, 'findById', async (id) => { askedFor = id; return product(); }]], async () => {
      const res = await request(app).get(`/product/${ID}`);
      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], /text\/html/);
      assert.equal(res.headers['x-robots-tag'], undefined);
      assert.match(res.text, /<title>Cotton Shirt \| Acme Apparel<\/title>/);
      assert.match(res.text, new RegExp(`rel="canonical" href="https://shop\\.example\\.com/product/${ID}"`));
      assert.match(res.text, /property="og:type" content="product"/);
      assert.match(res.text, /property="og:image" content="https:\/\/shop\.example\.com\/img\/og-default\.png"/);
      assert.match(res.text, /class="tl-price mb-2">8999\.00</);
      const [ld] = ldBlocks(res.text);
      assert.equal(ld['@type'], 'Product');
      assert.equal(ld.offers.priceCurrency, 'XXX');   // CURRENCY_CODE from the test setup; machine-readable only
      assert.equal(ld.offers.price, '8999.00');
      assert.equal(ld.offers.availability, 'https://schema.org/InStock');
    });
    assert.equal(askedFor, ID);
  });
});

test('product text from the database is escaped on the product page', async () => {
  await withStubs([[Product, 'findById', async () => product({ title: EVIL, description: EVIL })]], async () => {
    const res = await request(app).get(`/product/${ID}`);
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('<script>alert(1)</script>'));
  });
});

test('an unknown product id gives a 404 page that is not indexed', async () => {
  await withStubs([[Product, 'findById', async () => null]], async () => {
    const res = await request(app).get(`/product/${ID}`);
    assert.equal(res.status, 404);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
    assert.match(res.text, /Product not found/);
    assert.match(res.text, /<meta name="robots" content="noindex, nofollow" \/>/);
    assert.ok(!/rel="canonical"/.test(res.text));
  });
});

test('a malformed product id is a 404 and never reaches the database', async () => {
  let asked = false;
  await withStubs([[Product, 'findById', async () => { asked = true; return product(); }]], async () => {
    for (const bad of ['abc', 'not-an-id', '64b7f0c2a1b2c3d4e5f6071', '64b7f0c2a1b2c3d4e5f607189', '%7B%24ne%7D', 'zzzzzzzzzzzzzzzzzzzzzzzz']) {
      const res = await request(app).get(`/product/${bad}`);
      assert.equal(res.status, 404, bad);
    }
  });
  assert.equal(asked, false);
});

test('a database error on the product page is a generic 500 that is not indexed', async () => {
  await withStubs([quiet, [Product, 'findById', async () => { throw new Error('mongo secret host down'); }]], async () => {
    const res = await request(app).get(`/product/${ID}`);
    assert.equal(res.status, 500);
    assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
    assert.ok(!res.text.includes('mongo secret'));
  });
});

test('the admin page and the admin API send X-Robots-Tag noindex; the storefront does not', async () => {
  const page = await request(app).get('/admin.html');
  assert.equal(page.status, 200);
  assert.equal(page.headers['x-robots-tag'], 'noindex, nofollow');
  assert.match(page.text, /<meta name="robots" content="noindex, nofollow"/);

  const api = await request(app).get('/admin/products');          // not logged in
  assert.equal(api.status, 401);
  assert.equal(api.headers['x-robots-tag'], 'noindex, nofollow');

  const store = await request(app).get('/');
  assert.equal(store.headers['x-robots-tag'], undefined);
});

// Rate limit (keep this test last: it uses up the limit)

test('the product page and sitemap are rate limited per IP, and limited requests are not served', async () => {
  let limited = null;
  for (let i = 0; i < 130 && !limited; i++) {
    const res = await request(app).get('/product/not-an-id');
    if (res.status === 429) limited = res;
  }
  assert.ok(limited, 'expected a 429 after many requests in a minute');
  assert.ok(limited.headers['ratelimit'] || limited.headers['ratelimit-limit'] || limited.headers['retry-after']);
});
