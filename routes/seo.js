const fs = require('fs');
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const Product = require('../models/Product');
const Review = require('../models/Review');
const marketplace = require('../services/marketplace');
const seo = require('../services/seo');

// Search-engine pages: home page with meta tags, robots.txt, sitemap.xml and the read-only product
// page.
const router = express.Router();

const INDEX_FILE = path.join(__dirname, '..', 'public', 'index.html');

// The product page and sitemap hit the database, so they get their own generous limit.
const seoLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests, please try again later.'
});

// index.html is cached and re-read when the file changes.
let indexCache = { mtimeMs: -1, html: '' };
function readIndexHtml() {
  const { mtimeMs } = fs.statSync(INDEX_FILE);
  if (mtimeMs !== indexCache.mtimeMs) {
    indexCache = { mtimeMs, html: fs.readFileSync(INDEX_FILE, 'utf8') };
  }
  return indexCache.html;
}

router.get(['/', '/index.html'], (req, res, next) => {
  let html;
  try {
    html = readIndexHtml();
  } catch (err) {
    return next();   // file missing: let the static handler answer as before
  }
  res.type('html').send(seo.injectHead(html, seo.buildHomeHead(seo.getSiteConfig())));
});

// Policy pages are static files with the shop's name added to title and description.
const POLICY_URLS = seo.POLICY_PAGES.map((page) => `/${page}.html`);
router.get(POLICY_URLS, (req, res, next) => {
  const file = path.join(__dirname, '..', 'public', req.path.toLowerCase().slice(1));
  let html;
  try {
    html = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return next();   // file missing: let the static handler answer as before
  }
  res.type('html').send(seo.brandPolicyPage(html, seo.getSiteConfig().siteName));
});

router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(seo.renderRobots(seo.getSiteConfig().baseUrl));
});

router.get('/sitemap.xml', seoLimiter, async (req, res) => {
  try {
    const found = await Product.find()
      .select('_id updatedAt vendorId')
      .sort({ updatedAt: -1 })
      .limit(seo.MAX_SITEMAP_PRODUCTS)
      .lean();
    const products = (await marketplace.visibleProducts(found)).map(({ product }) => product);
    res.type('application/xml').send(seo.renderSitemap(seo.getSiteConfig().baseUrl, products));
  } catch (err) {
    console.error('Sitemap error:', err.message);
    res.status(500).type('text/plain').send('Sitemap is unavailable right now.');
  }
});

function sendMessagePage(res, status, page) {
  res.status(status).set('X-Robots-Tag', 'noindex, nofollow').type('html')
    .send(seo.renderMessagePage(seo.getSiteConfig(), page));
}

// The web app manifest: lets a phone install the store like an app. The name comes from SITE_NAME.
router.get('/manifest.webmanifest', (req, res) => {
  const name = seo.getSiteConfig().siteName;
  res.set('Cache-Control', 'public, max-age=3600').type('application/manifest+json').send(JSON.stringify({
    name,
    short_name: Array.from(name).slice(0, 12).join(''),
    description: `Shop at ${name}`,
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0f1f3d',
    theme_color: '#0f1f3d',
    icons: [
      { src: '/img/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/img/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/img/logo.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }
    ]
  }));
});

router.get('/product/:id', seoLimiter, async (req, res) => {
  const notFound = () => sendMessagePage(res, 404, {
    title: 'Product not found',
    heading: 'Product not found',
    text: 'We could not find that product. It may have been removed.'
  });

  // Malformed ids never reach the database.
  if (!seo.OBJECT_ID.test(req.params.id)) return notFound();

  try {
    const product = await Product.findById(req.params.id);
    if (!product) return notFound();
    const seller = await marketplace.sellerOf(product);
    if (seller === false) return notFound();
    // The latest reviews (best effort: a problem here must never take the product page down).
    let reviews = [];
    if (Number(product.ratingCount) > 0) {
      try { reviews = await Review.find({ productId: product._id, hidden: false }).sort({ createdAt: -1 }).limit(10).select('authorName rating text createdAt').lean(); } catch (e) { /* page without reviews */ }
    }
    res.type('html').send(seo.renderProductPage(product, seo.getSiteConfig(), reviews));
  } catch (err) {
    console.error('Product page error:', err.message);
    sendMessagePage(res, 500, {
      title: 'Something went wrong',
      heading: 'Something went wrong',
      text: 'This page is unavailable right now. Please try again in a moment.'
    });
  }
});

module.exports = router;
