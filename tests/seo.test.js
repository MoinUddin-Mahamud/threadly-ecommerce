// Tests for the SEO basics: settings and their limits, meta tags, JSON-LD,
// robots.txt, sitemap.xml, the product page and the noindex rules.
// These need no server and no database (the HTTP side is in seo-routes.test.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
process.env.CURRENCY_CODE = 'XXX';   // machine-readable only (structured data)
const seo = require('../services/seo');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const CFG = { siteName: 'Acme Apparel', siteDescription: 'Warm coats for everyone.', baseUrl: 'https://shop.example.com' };
const EVIL = '"><script>alert(1)</script><img src=x onerror=alert(2)>';
const ID = '64b7f0c2a1b2c3d4e5f60718';

// Reads every <script type="application/ld+json"> block back as an object.
function jsonLdBlocks(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
}
const productDoc = (extra = {}) => ({
  _id: ID, title: 'Cotton Shirt', description: 'Warm and light.', price: 8999, stock: 12,
  category: 'Men', imageUrl: '/img/products/cotton-shirt-men.svg', ...extra
});

test('settings have sensible defaults', () => {
  const cfg = seo.getSiteConfig({});
  assert.equal(cfg.siteName, 'Threadly');
  assert.equal(cfg.baseUrl, 'http://localhost:3000');
  assert.match(cfg.siteDescription, /Threadly/);
});

test('SITE_NAME and SITE_DESCRIPTION are used, cleaned and length-limited', () => {
  const cfg = seo.getSiteConfig({ SITE_NAME: '  Acme\n  Coats\t', SITE_DESCRIPTION: 'Line one\r\nline two' });
  assert.equal(cfg.siteName, 'Acme Coats');
  assert.equal(cfg.siteDescription, 'Line one line two');

  const long = seo.getSiteConfig({ SITE_NAME: 'N'.repeat(500), SITE_DESCRIPTION: 'D'.repeat(2000) });
  assert.equal(Array.from(long.siteName).length, seo.LIMITS.siteName);
  assert.ok(Array.from(long.siteDescription).length <= seo.LIMITS.siteDescription);
  assert.ok(long.siteDescription.endsWith('…'));
});

test('a blank SITE_NAME falls back to the default; a default description follows the site name', () => {
  assert.equal(seo.getSiteConfig({ SITE_NAME: '   ' }).siteName, 'Threadly');
  assert.match(seo.getSiteConfig({ SITE_NAME: 'Acme Apparel' }).siteDescription, /Acme Apparel/);
});

test('BASE_URL is normalised; unusable values fall back to the local default', () => {
  const n = seo.normalizeBaseUrl;
  assert.equal(n('https://shop.example.com/'), 'https://shop.example.com');
  assert.equal(n('https://shop.example.com///'), 'https://shop.example.com');
  assert.equal(n('  http://localhost:3000  '), 'http://localhost:3000');
  assert.equal(n('https://example.com/store/'), 'https://example.com/store');
  for (const bad of [undefined, '', '   ', 'not a url', 'ftp://example.com', 'javascript:alert(1)']) {
    assert.equal(n(bad), 'http://localhost:3000', String(bad));
  }
});

test('text helpers never cut a character in half', () => {
  assert.equal(seo.clip('a😀b', 2), 'a😀');
  assert.equal(seo.truncate('abcdef', 4), 'abc…');
  assert.equal(seo.truncate('abc', 4), 'abc');
});

test('the home page head has title, description, canonical, Open Graph and Twitter tags', () => {
  const head = seo.buildHomeHead(CFG);
  assert.match(head, /<title>Acme Apparel - Online Clothing Marketplace<\/title>/);
  assert.match(head, /<meta name="description" content="Warm coats for everyone\." \/>/);
  assert.match(head, /<link rel="canonical" href="https:\/\/shop\.example\.com\/" \/>/);
  assert.match(head, /property="og:site_name" content="Acme Apparel"/);
  assert.match(head, /property="og:type" content="website"/);
  assert.match(head, /property="og:title" content="Acme Apparel - Online Clothing Marketplace"/);
  assert.match(head, /property="og:description" content="Warm coats for everyone\."/);
  assert.match(head, /property="og:url" content="https:\/\/shop\.example\.com\/"/);
  assert.match(head, /property="og:image" content="https:\/\/shop\.example\.com\/img\/logo\.svg"/);
  assert.match(head, /name="twitter:card" content="summary"/);
  assert.match(head, /name="twitter:title"/);
  assert.match(head, /name="twitter:description"/);
  assert.match(head, /name="twitter:image" content="https:\/\/shop\.example\.com\/img\/logo\.svg"/);
});

test('the home page carries Organization and WebSite JSON-LD', () => {
  const blocks = jsonLdBlocks(seo.buildHomeHead(CFG));
  const org = blocks.find((b) => b['@type'] === 'Organization');
  const site = blocks.find((b) => b['@type'] === 'WebSite');
  assert.equal(org['@context'], 'https://schema.org');
  assert.equal(org.name, 'Acme Apparel');
  assert.equal(org.url, 'https://shop.example.com/');
  assert.equal(org.logo, 'https://shop.example.com/img/logo.svg');
  assert.equal(site.name, 'Acme Apparel');
  assert.equal(site.url, 'https://shop.example.com/');
});

test('hostile settings cannot break out of attributes, tags or JSON-LD', () => {
  const head = seo.buildHomeHead({ ...CFG, siteName: EVIL, siteDescription: EVIL });
  assert.ok(!head.includes('<script>alert'), 'raw script tag leaked');
  assert.ok(!head.includes('<img src=x'), 'raw img tag leaked');
  assert.ok(!/content="[^"]*"[^>]*><script/.test(head));
  // exactly the two JSON-LD blocks, and they still parse
  assert.equal((head.match(/<script/g) || []).length, 2);
  const blocks = jsonLdBlocks(head);
  assert.equal(blocks[0].name, EVIL);       // the data is intact, just made safe inside the page
});

test('injectHead puts the tags at the marker and keeps "$" characters literal', () => {
  const html = '<head>\n  <!--SEO_HEAD-->\n</head>';
  const out = seo.injectHead(html, '<title>Cost $& $1 $$</title>');
  assert.equal(out, '<head>\n  <title>Cost $& $1 $$</title>\n</head>');
});

test('injectHead still works when an owner removed the marker', () => {
  const html = '<head><title>Old</title><meta name="description" content="old"><link rel="icon" href="/x"></head>';
  const out = seo.injectHead(html, '<title>New</title>');
  assert.ok(out.includes('<title>New</title>'));
  assert.ok(!out.includes('Old') && !out.includes('content="old"'));
  assert.ok(out.includes('<link rel="icon"'));
});

test('the storefront file uses the marker and has no title or description of its own', () => {
  const html = read('public/index.html');
  assert.equal(html.split(seo.SEO_MARKER).length - 1, 1);
  assert.ok(!/<title>/i.test(html));
  assert.ok(!/<meta name="description"/i.test(html));
  // rendered with the real file, the page has exactly one of each
  const page = seo.injectHead(html, seo.buildHomeHead(CFG));
  assert.equal((page.match(/<title>/g) || []).length, 1);
  assert.equal((page.match(/<link rel="canonical"/g) || []).length, 1);
  assert.equal((page.match(/name="description"/g) || []).length, 1);
  assert.match(page, /\/css\/theme\.css/);
  assert.match(page, /\/js\/theme\.js/);
});

test('the product head has its own title, description, canonical and Open Graph tags', () => {
  const head = seo.buildProductHead(productDoc(), CFG);
  assert.match(head, /<title>Cotton Shirt \| Acme Apparel<\/title>/);
  assert.match(head, /name="description" content="Warm and light\."/);
  assert.match(head, new RegExp(`rel="canonical" href="https://shop\\.example\\.com/product/${ID}"`));
  assert.match(head, /property="og:type" content="product"/);
  assert.match(head, /property="og:title" content="Cotton Shirt \| Acme Apparel"/);
  assert.match(head, new RegExp(`property="og:url" content="https://shop\\.example\\.com/product/${ID}"`));
  assert.match(head, /property="og:image" content="https:\/\/shop\.example\.com\/img\/og-default\.png"/, 'an SVG picture is not used for link previews');
  assert.match(head, /property="product:price:amount" content="8999\.00"/);
  assert.match(head, /property="product:price:currency" content="XXX"/);
  assert.match(head, /name="twitter:card" content="summary_large_image"/);
});

test('the product JSON-LD has name, image, price and availability', () => {
  const [data] = jsonLdBlocks(seo.buildProductHead(productDoc(), CFG));
  assert.equal(data['@type'], 'Product');
  assert.equal(data.name, 'Cotton Shirt');
  assert.deepEqual(data.image, ['https://shop.example.com/img/og-default.png']);
  assert.equal(data.offers['@type'], 'Offer');
  assert.equal(data.offers.priceCurrency, 'XXX');
  assert.equal(data.offers.price, '8999.00');
  assert.equal(data.offers.availability, 'https://schema.org/InStock');
  assert.equal(data.offers.url, `https://shop.example.com/product/${ID}`);

  const [sold] = jsonLdBlocks(seo.buildProductHead(productDoc({ stock: 0 }), CFG));
  assert.equal(sold.offers.availability, 'https://schema.org/OutOfStock');
  const [low] = jsonLdBlocks(seo.buildProductHead(productDoc({ stock: 2 }), CFG));
  assert.equal(low.offers.availability, 'https://schema.org/InStock');
});

test('the product price is shown without a currency, whatever extra fields a stored product has', () => {
  const [data] = jsonLdBlocks(seo.buildProductHead(productDoc({ currency: 'XXX', price: 12.5 }), CFG));
  assert.equal(data.offers.priceCurrency, 'XXX');
  assert.equal(data.offers.price, '12.50');
});

test('product images: relative paths and web addresses become absolute; uploads, SVG and junk use the default image', () => {
  const fallback = 'https://shop.example.com/img/og-default.png';
  const img = (imageUrl) => seo.seoImageUrl(CFG.baseUrl, imageUrl);
  assert.equal(img('/img/a.png'), 'https://shop.example.com/img/a.png');
  assert.equal(img('/img/a.svg'), fallback);
  assert.equal(img('https://cdn.example.org/a.svg'), fallback);
  assert.equal(img('https://cdn.example.org/a.jpg'), 'https://cdn.example.org/a.jpg');
  assert.equal(img('data:image/png;base64,AAAA'), fallback);   // an upload has no public address
  assert.equal(img('javascript:alert(1)'), fallback);
  assert.equal(img('//evil.example/x.png'), fallback);
  assert.equal(img('relative/path.png'), fallback);
  assert.equal(img(''), fallback);
  assert.equal(img(undefined), fallback);
  assert.equal(img('https://cdn.example.org/' + 'a'.repeat(3000)), fallback);   // over the length limit
});

test('the product page itself can show an uploaded image, but never an unsafe address', () => {
  assert.equal(seo.pageImageSrc('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(seo.pageImageSrc('/img/a.svg'), '/img/a.svg');
  assert.equal(seo.pageImageSrc('javascript:alert(1)'), '/img/logo.svg');
  assert.equal(seo.pageImageSrc('data:text/html;base64,AAAA'), '/img/logo.svg');
  assert.equal(seo.pageImageSrc('data:image/png;base64,AA"onerror="x'), '/img/logo.svg');
});

test('long product text is cut for the meta description and the title', () => {
  const head = seo.buildProductHead(productDoc({ title: 'T'.repeat(300), description: 'word '.repeat(200) }), CFG);
  const desc = head.match(/name="description" content="([^"]*)"/)[1];
  assert.ok(Array.from(desc).length <= seo.LIMITS.metaDescription);
  assert.ok(desc.endsWith('…'));
  const title = head.match(/<title>([^<]*)<\/title>/)[1];
  assert.ok(Array.from(title).length <= seo.LIMITS.title);
});

test('a product with no description still gets a useful one', () => {
  const head = seo.buildProductHead(productDoc({ description: '' }), CFG);
  assert.match(head, /name="description" content="Buy Cotton Shirt at Acme Apparel\."/);
});

test('customer-visible product text is escaped everywhere on the product page', () => {
  const html = seo.renderProductPage(productDoc({ title: EVIL, description: EVIL, category: EVIL, imageUrl: '/x.png' }), CFG);
  assert.ok(!html.includes('<script>alert'), 'raw script leaked');
  assert.ok(!html.includes('<img src=x onerror'), 'raw img leaked');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  // the only script tags are the JSON-LD block (it still parses), the light/dark choice, the picture-fallback file and the translation file
  assert.equal((html.match(/<script/g) || []).length, 4);
  assert.equal((html.match(/<script src=/g) || []).length, 3);
  assert.match(html, /<script src="\/js\/theme\.js"><\/script>/);
  assert.match(html, /<script src="\/js\/img-fallback\.js"><\/script>/);
  assert.match(html, /<script src="\/js\/i18n\.js"><\/script>/);
  assert.equal(jsonLdBlocks(html)[0].name.includes('<script>'), true);
});

test('the product page is read-only: no cart button and no form', () => {
  const html = seo.renderProductPage(productDoc(), CFG);
  assert.ok(!/<form/i.test(html));
  assert.ok(!/add to cart|add-to-cart/i.test(html));
  assert.match(html, /class="tl-price mb-2">8999\.00</);
  assert.match(html, /In Stock/);
  assert.match(html, /href="\/#products"/);
  assert.match(html, /<link rel="icon"/);
  assert.ok(!/noindex/.test(html), 'a real product page must be indexable');
});

test('the product page shows low and zero stock like the storefront does', () => {
  assert.match(seo.renderProductPage(productDoc({ stock: 3 }), CFG), /Only 3 left/);
  assert.match(seo.renderProductPage(productDoc({ stock: 0 }), CFG), /Out of Stock/);
});

test('the not-found page is noindex and escapes the site name', () => {
  const html = seo.renderMessagePage({ ...CFG, siteName: EVIL }, { title: 'Product not found', heading: 'Product not found', text: 'Gone.' });
  assert.match(html, /<meta name="robots" content="noindex, nofollow" \/>/);
  assert.ok(!html.includes('<script>alert'));
  assert.ok(!/rel="canonical"/.test(html));
});

test('robots.txt points to the sitemap on BASE_URL and blocks only the private routes', () => {
  const txt = seo.renderRobots('https://shop.example.com');
  assert.match(txt, /^User-agent: \*$/m);
  assert.match(txt, /^Disallow: \/api\/$/m);
  assert.match(txt, /^Disallow: \/admin\/$/m);
  assert.match(txt, /^Sitemap: https:\/\/shop\.example\.com\/sitemap\.xml$/m);
  // /admin.html must stay crawlable, otherwise search engines cannot see its noindex
  assert.ok(!/^Disallow: \/admin\.html/m.test(txt));
  assert.ok(!/^Disallow: \/$/m.test(txt), 'must not block the whole site');
});

test('sitemap.xml lists the home page and every product with its modified date', () => {
  const xml = seo.renderSitemap('https://shop.example.com', [
    { _id: ID, updatedAt: new Date('2026-03-04T05:06:07Z') },
    { _id: '64b7f0c2a1b2c3d4e5f60999' }
  ]);
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.match(xml, /<loc>https:\/\/shop\.example\.com\/<\/loc>/);
  assert.match(xml, new RegExp(`<loc>https://shop\\.example\\.com/product/${ID}</loc>\\s*<lastmod>2026-03-04T05:06:07\\.000Z</lastmod>`));
  assert.match(xml, /<loc>https:\/\/shop\.example\.com\/product\/64b7f0c2a1b2c3d4e5f60999<\/loc>/);
  assert.equal((xml.match(/<url>/g) || []).length, 3 + seo.POLICY_PAGES.length);   // home + products + the policy pages
  for (const page of seo.POLICY_PAGES) assert.match(xml, new RegExp(`<loc>https://shop\\.example\\.com/${page}\\.html</loc>`));
});

test('the sitemap skips documents without a valid id and escapes the base URL', () => {
  const xml = seo.renderSitemap('https://shop.example.com/a&b', [{ title: 'no id' }, { _id: 'nope' }, { _id: null }, null, { _id: ID }]);
  assert.equal((xml.match(/<url>/g) || []).length, 2 + seo.POLICY_PAGES.length);
  assert.ok(xml.includes('https://shop.example.com/a&amp;b/'));
  assert.ok(!xml.includes('a&b'));
});

test('the sitemap never lists more than 50,000 URLs', () => {
  const many = Array.from({ length: 50500 }, (_, i) => ({ _id: i.toString(16).padStart(24, '0') }));
  const xml = seo.renderSitemap('https://shop.example.com', many);
  assert.equal((xml.match(/<url>/g) || []).length, 50000);
});

test('admin pages and the admin API are marked noindex; storefront pages are not', () => {
  for (const p of ['/admin.html', '/admin', '/admin/', '/admin/products', '/admin/auth/status', '/ADMIN.HTML', '/vendor.html', '/vendor', '/setup']) {
    assert.equal(seo.isNoindexPath(p), true, p);
  }
  for (const p of ['/', '/index.html', '/product/' + ID, '/robots.txt', '/administrator', '/api/admin', '/api/vendor', '/vendors', '/payment-fail.html']) {
    assert.equal(seo.isNoindexPath(p), false, p);
  }
});

test('admin.html carries a robots noindex meta tag', () => {
  assert.match(read('public/admin.html'), /<meta name="robots" content="noindex, nofollow"\s*\/?>/);
});

test('both kinds of product card link to the product page', () => {
  const js = read('public/js/app.js');
  assert.equal((js.match(/href="\/product\/\$\{safeId\}"/g) || []).length, 4);   // image + title, in 2 card renderers
});

test('without CURRENCY_CODE the product data carries no currency at all', () => {
  const saved = process.env.CURRENCY_CODE;
  delete process.env.CURRENCY_CODE;
  try {
    const head = seo.buildProductHead(productDoc(), CFG);
    assert.ok(!/priceCurrency|product:price:currency/.test(head));
  } finally { process.env.CURRENCY_CODE = saved; }
});
