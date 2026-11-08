const { fixedAmount } = require('./money');
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

const DEFAULT_BASE_URL = 'http://localhost:3000';
const DEFAULT_SITE_NAME = 'Threadly';
const HOME_TAGLINE = 'Online Clothing Marketplace';

const LIMITS = {
  siteName: 60,
  siteDescription: 300,
  metaDescription: 160,
  title: 120,
  imageUrl: 2000
};

// A sitemap file may list at most 50,000 URLs; one is the home page.
const MAX_SITEMAP_PRODUCTS = 49999;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (m) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]
  ));
}

// Plain one-line text: control characters and line breaks become spaces.
function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Cuts to `max` characters (counted as whole characters, never half an emoji).
function clip(text, max) {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('').trimEnd();
}

// Like clip, but marks the cut with an ellipsis (for descriptions).
function truncate(text, max) {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, max - 1).join('').trimEnd() + '…';
}

// JSON for use inside <script type="application/ld+json">: the data cannot close the tag or open an HTML comment.
function jsonForScript(data) {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// BASE_URL without a trailing slash. Always comes from the setting, never from
// the request's Host header, so a forged Host header cannot poison canonical
// links or the sitemap. An unusable value falls back to the local default.
function normalizeBaseUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return DEFAULT_BASE_URL;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULT_BASE_URL;
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch (err) {
    return DEFAULT_BASE_URL;
  }
}

// Reads the settings each time it is called, so a changed .env value only needs
// a restart and the tests can change them freely.
function getSiteConfig(env = process.env) {
  const siteName = clip(cleanText(env.SITE_NAME), LIMITS.siteName) || DEFAULT_SITE_NAME;
  const siteDescription = truncate(cleanText(env.SITE_DESCRIPTION), LIMITS.siteDescription) ||
    `Shop men's, women's and kids' clothing from independent sellers at ${siteName}. Live stock, secure checkout and delivery across the country.`;
  return { siteName, siteDescription, baseUrl: normalizeBaseUrl(env.BASE_URL) };
}

const DATA_IMAGE = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i;

// Sorts a product's imageUrl into what it is. Anything that is not a plain
// image address (javascript:, protocol-relative, junk) counts as "none".
function classifyImage(imageUrl) {
  if (typeof imageUrl !== 'string') return { kind: 'none' };
  const value = imageUrl.trim();
  if (!value) return { kind: 'none' };
  if (DATA_IMAGE.test(value)) return { kind: 'data', value };
  if (value.length > LIMITS.imageUrl) return { kind: 'none' };
  if (value.startsWith('/') && !value.startsWith('//')) return { kind: 'path', value };
  if (/^https?:\/\//i.test(value)) {
    try { return { kind: 'remote', value: new URL(value).href }; } catch (err) { return { kind: 'none' }; }
  }
  return { kind: 'none' };
}

// Absolute http(s) URL for og:image and JSON-LD. Uploaded (base64) images and
// junk cannot be used for social previews, so they fall back to the
// og-default.png image. PNG, JPG/JPEG and WebP images are accepted.
const OG_SAFE_EXT = /\.(png|jpe?g|webp)$/i;

function seoImageUrl(baseUrl, imageUrl) {
  const img = classifyImage(imageUrl);
  if (img.kind === 'path' && OG_SAFE_EXT.test(img.value)) {
    try { return new URL(img.value, baseUrl + '/').href; } catch (err) { /* fall through */ }
  }
  if (img.kind === 'remote' && OG_SAFE_EXT.test(img.value.split('?')[0])) return img.value;
  return `${baseUrl}/img/og-default.png`;
}

// What the product page itself shows: a relative path, an http(s) address, or
// the uploaded image; the logo when there is nothing usable.
function pageImageSrc(imageUrl) {
  const img = classifyImage(imageUrl);
  return img.kind === 'none' ? '/img/logo.svg' : img.value;
}

// The extra pictures of a product that can be shown on its page: files of this site and http(s)
// addresses (never embedded data, which would bloat the page).
function galleryImages(product, max = 5) {
  const list = Array.isArray(product && product.images) ? product.images : [];
  const out = [];
  for (const entry of list) {
    const img = classifyImage(entry);
    if ((img.kind === 'path' || img.kind === 'remote') && !out.includes(img.value)) out.push(img.value);
    if (out.length >= max) break;
  }
  return out;
}

// Star rating for structured data and the page: only when the product has visible reviews.
function ratingData(product, reviews) {
  const count = Number(product && product.ratingCount);
  const average = Number(product && product.ratingAverage);
  if (!(count > 0) || !(average >= 1 && average <= 5)) return {};
  const shown = (Array.isArray(reviews) ? reviews : []).slice(0, 5).map((r) => ({
    '@type': 'Review',
    reviewRating: { '@type': 'Rating', ratingValue: Number(r.rating), bestRating: 5, worstRating: 1 },
    author: { '@type': 'Person', name: cleanText(r.authorName) || 'Customer' },
    ...(r.text ? { reviewBody: truncate(cleanText(r.text), 500) } : {}),
    ...(r.createdAt ? { datePublished: new Date(r.createdAt).toISOString().slice(0, 10) } : {})
  }));
  return {
    aggregateRating: { '@type': 'AggregateRating', ratingValue: average, reviewCount: count, bestRating: 5, worstRating: 1 },
    ...(shown.length ? { review: shown } : {})
  };
}

const starsText = (n) => '\u2605'.repeat(Math.max(0, Math.min(5, Math.round(n)))) + '\u2606'.repeat(5 - Math.max(0, Math.min(5, Math.round(n))));

// opts: title, description, canonical, siteName, ogType, image, twitterCard,
//       jsonLd (array of objects), extraMeta (array of [property, content]),
//       noindex (bool)
function renderHead(opts) {
  const e = escapeHtml;
  const lines = [
    `<title>${e(opts.title)}</title>`,
    `<meta name="description" content="${e(opts.description)}" />`
  ];
  if (opts.noindex) lines.push('<meta name="robots" content="noindex, nofollow" />');
  if (opts.canonical) lines.push(`<link rel="canonical" href="${e(opts.canonical)}" />`);
  lines.push(
    `<meta property="og:site_name" content="${e(opts.siteName)}" />`,
    `<meta property="og:type" content="${e(opts.ogType || 'website')}" />`,
    `<meta property="og:title" content="${e(opts.title)}" />`,
    `<meta property="og:description" content="${e(opts.description)}" />`
  );
  if (opts.canonical) lines.push(`<meta property="og:url" content="${e(opts.canonical)}" />`);
  if (opts.image) lines.push(`<meta property="og:image" content="${e(opts.image)}" />`);
  (opts.extraMeta || []).forEach(([property, content]) => {
    lines.push(`<meta property="${e(property)}" content="${e(content)}" />`);
  });
  lines.push(
    `<meta name="twitter:card" content="${e(opts.twitterCard || 'summary')}" />`,
    `<meta name="twitter:title" content="${e(opts.title)}" />`,
    `<meta name="twitter:description" content="${e(opts.description)}" />`
  );
  if (opts.image) lines.push(`<meta name="twitter:image" content="${e(opts.image)}" />`);
  (opts.jsonLd || []).forEach((data) => {
    lines.push(`<script type="application/ld+json">${jsonForScript(data)}</script>`);
  });
  return lines.join('\n  ');
}

// Head tags for the home page, including the Organization and WebSite data.
function buildHomeHead(cfg) {
  const home = `${cfg.baseUrl}/`;
  const logo = `${cfg.baseUrl}/img/logo.svg`;
  const title = truncate(`${cfg.siteName} - ${HOME_TAGLINE}`, LIMITS.title);
  return renderHead({
    title,
    description: cfg.siteDescription,
    canonical: home,
    siteName: cfg.siteName,
    ogType: 'website',
    image: logo,
    twitterCard: 'summary',
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'Organization',
        name: cfg.siteName,
        url: home,
        logo,
        description: cfg.siteDescription
      },
      {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: cfg.siteName,
        url: home,
        description: cfg.siteDescription
      }
    ]
  });
}

// Search engines want a machine-readable currency for product prices. It comes from CURRENCY_CODE
// in .env and is left out when not set.
const { currencyCode } = require('./paymentConfig');

function productFacts(product, cfg) {
  const name = truncate(cleanText(product.title), LIMITS.title) || 'Product';
  const category = cleanText(product.category);
  const fullDescription = cleanText(product.description);
  const description = truncate(fullDescription, LIMITS.metaDescription) || `Buy ${name} at ${cfg.siteName}.`;
  const price = Number.isFinite(Number(product.price)) ? Number(product.price) : 0;
  const stock = Number.isFinite(Number(product.stock)) ? Number(product.stock) : 0;
  const id = String(product._id);
  return {
    id, name, category, description, fullDescription,
    price, stock,
    inStock: stock > 0,
    url: `${cfg.baseUrl}/product/${id}`
  };
}

function buildProductHead(product, cfg, reviews = []) {
  const f = productFacts(product, cfg);
  const image = seoImageUrl(cfg.baseUrl, product.imageUrl);
  const priceText = fixedAmount(f.price);
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: f.name,
    ...ratingData(product, reviews),
    image: [image, ...galleryImages(product).map((g) => seoImageUrl(cfg.baseUrl, g)).filter((u, i, all) => !u.endsWith('/img/og-default.png') && u !== image && all.indexOf(u) === i)],
    description: f.description,
    sku: f.id,
    offers: {
      '@type': 'Offer',
      url: f.url,
      ...(currencyCode() ? { priceCurrency: currencyCode() } : {}),
      price: priceText,
      itemCondition: 'https://schema.org/NewCondition',
      availability: f.inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock'
    }
  };
  if (f.category) jsonLd.category = f.category;

  return renderHead({
    title: truncate(`${f.name} | ${cfg.siteName}`, LIMITS.title),
    description: f.description,
    canonical: f.url,
    siteName: cfg.siteName,
    ogType: 'product',
    image,
    twitterCard: 'summary_large_image',
    extraMeta: [
      ['product:price:amount', priceText],
      ...(currencyCode() ? [['product:price:currency', currencyCode()]] : [])
    ],
    jsonLd: [jsonLd]
  });
}

// The read-only pages use the shop palette from /css/ui2.css (light and dark); only what is specific
// to them is defined here, with palette values and no colours of its own.
const PAGE_STYLE = `
    .tl-bar { background: linear-gradient(90deg, var(--ui-navy), var(--ui-navy-2)); border-bottom: 2px solid var(--ui-gold); padding: .75rem 1rem; }
    .tl-brand { color: var(--ui-gold-2); text-decoration: none; font-weight: 700; font-size: 1.25rem; display: inline-flex; align-items: center; gap: .6rem; }
    .tl-brand:hover { color: var(--ui-gold-2); }
    .tl-brand img { border-radius: 50%; border: 2px solid var(--ui-gold); object-fit: cover; }
    .tl-price { color: var(--ui-ink); font-weight: 800; font-size: 1.75rem; }
    .tl-desc { white-space: pre-line; }
    .tl-btn { background: linear-gradient(135deg, var(--ui-gold), var(--ui-gold-2)); color: var(--ui-navy); font-weight: 600; border: 0; }
    .tl-btn:hover { color: var(--ui-navy); filter: brightness(.95); }
    .tl-stars { color: var(--ui-gold-ink); }
    .tl-photo { background: var(--ui-card); }
    .tl-review { background: var(--ui-card); border: 1px solid var(--ui-line); border-radius: var(--ui-r-sm); }`;

function layout(headHtml, page) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/svg+xml" href="/img/logo.svg" />
  ${headHtml}
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet" integrity="sha384-QWTKZyjpPEjISv5WaRU9OFeRpok6YctnYmDr5pNlyT2bRjXh0JMhjY6hW+ALEwIH" crossorigin="anonymous" />
  <link rel="stylesheet" href="/css/ui2.css" />
  <style>${PAGE_STYLE}
  </style>
  <script src="/js/theme.js"></script>
</head>
<body>
  <header class="tl-bar">
    <a href="/" class="tl-brand"><img src="/img/logo.svg" alt="" width="36" height="36" />${escapeHtml(page.siteName)}</a>
  </header>
${page.main}
  <footer class="text-center text-muted small py-4">&copy; ${new Date().getFullYear()} ${escapeHtml(page.siteName)}<span>. All rights reserved.</span></footer>
  <script src="/js/img-fallback.js"></script>
  <script src="/js/i18n.js"></script>
</body>
</html>
`;
}

// "Customer reviews": the average and the latest reviews, all text escaped. Nothing when there are
// none.
function reviewsSection(product, reviews) {
  const e = escapeHtml;
  const count = Number(product && product.ratingCount);
  const list = Array.isArray(reviews) ? reviews : [];
  if (!(count > 0) || !list.length) return '';
  const average = Number(product.ratingAverage) || 0;
  const items = list.slice(0, 10).map((r) => `<li class="tl-review p-3 mb-2">
        <div><span aria-label="${e(Number(r.rating))} out of 5 stars" class="tl-stars">${e(starsText(Number(r.rating)))}</span> <strong>${e(cleanText(r.authorName) || 'Customer')}</strong>${r.createdAt ? ` <span class="text-muted small">${e(new Date(r.createdAt).toISOString().slice(0, 10))}</span>` : ''}</div>
        ${r.text ? `<p class="mb-0 mt-1">${e(cleanText(r.text))}</p>` : ''}
      </li>`).join('\n      ');
  return `    <section class="mt-4" id="productReviews" aria-labelledby="reviewsHeading">
      <h2 class="h4" id="reviewsHeading">Customer reviews</h2>
      <p class="mb-3"><span class="tl-stars" style="font-size:1.2rem">${e(starsText(average))}</span> <strong>${e(average.toFixed(1))}</strong> <span class="text-muted">(${e(count)} review${count === 1 ? '' : 's'})</span></p>
      <ul class="list-unstyled">
      ${items}
      </ul>
    </section>`;
}

// The read-only product page: no cart, no forms. It links back to the store.
function renderProductPage(product, cfg, reviews = []) {
  const f = productFacts(product, cfg);
  const e = escapeHtml;
  const stockBadge = f.stock <= 0
    ? '<span class="badge bg-danger">Out of Stock</span>'
    : f.stock < 5
      ? `<span class="badge bg-warning text-dark">Only ${e(f.stock)} left</span>`
      : '<span class="badge bg-success">In Stock</span>';

  const main = `  <main class="container py-4">
    <nav aria-label="breadcrumb">
      <ol class="breadcrumb">
        <li class="breadcrumb-item"><a href="/">Home</a></li>
        <li class="breadcrumb-item"><a href="/#products">Products</a></li>
        <li class="breadcrumb-item active" aria-current="page">${e(f.name)}</li>
      </ol>
    </nav>
    <article class="row g-4">
      <div class="col-md-6">
        <img id="productMainImage" class="img-fluid rounded border w-100 tl-photo" src="${e(pageImageSrc(product.imageUrl))}" alt="${e(f.name)}" data-fallback-src="/img/logo.svg" />
        ${galleryImages(product).length ? `<div class="d-flex flex-wrap gap-2 mt-2" id="productGallery">${[pageImageSrc(product.imageUrl), ...galleryImages(product)].filter((src, i, all) => src !== '/img/logo.svg' && all.indexOf(src) === i).map((src, n) => `<a href="${e(src)}" data-gallery-thumb class="d-block border rounded bg-white"><img src="${e(src)}" alt="${e(f.name)} picture ${n + 1}" width="64" height="64" style="object-fit:cover" loading="lazy" /></a>`).join('')}</div><script src="/js/product-gallery.js"></script>` : ''}
      </div>
      <div class="col-md-6">
        <h1 class="h2 mb-2">${e(f.name)}</h1>
        ${f.category ? `<p class="mb-2"><span class="badge bg-secondary">${e(f.category)}</span></p>` : ''}
        <p class="tl-price mb-2">${e(fixedAmount(f.price))}</p>
        <p class="mb-3">${stockBadge}</p>
        <p class="tl-desc">${e(f.fullDescription || 'Quality clothing')}</p>
        <a class="btn tl-btn btn-lg" href="/#products">Shop all clothing</a>
      </div>
    </article>
${reviewsSection(product, reviews)}
  </main>`;

  return layout(buildProductHead(product, cfg, reviews), { main, siteName: cfg.siteName });
}

// A plain page for "not found" and similar. Never indexed.
function renderMessagePage(cfg, { title, heading, text }) {
  const head = renderHead({
    title: truncate(`${title} | ${cfg.siteName}`, LIMITS.title),
    description: text,
    siteName: cfg.siteName,
    noindex: true
  });
  const main = `  <main class="container py-5 text-center">
    <h1 class="h2">${escapeHtml(heading)}</h1>
    <p class="text-muted">${escapeHtml(text)}</p>
    <a class="btn tl-btn" href="/">Back to the store</a>
  </main>`;
  return layout(head, { main, siteName: cfg.siteName });
}

// /admin.html is NOT disallowed: a crawler that may not fetch it
// cannot see its "noindex", and the storefront links to it. Only the
// private API routes are blocked.
function renderRobots(baseUrl) {
  return [
    'User-agent: *',
    'Disallow: /api/',
    'Disallow: /admin/',
    'Disallow: /socket.io/',
    '',
    `Sitemap: ${baseUrl}/sitemap.xml`,
    ''
  ].join('\n');
}

// Static policy pages listed in the sitemap (they are served from /public).
const POLICY_PAGES = ['privacy', 'terms', 'returns', 'shipping', 'faq', 'contact'];

// The policy pages are plain files whose title and description carry no name (the browser adds it,
// see public/js/brand.js).
function brandPolicyPage(html, siteName) {
  const name = escapeHtml(siteName);
  return String(html)
    .replace(/<title data-brand-title="([^"]*)">[^<]*<\/title>/, (m, base) => `<title data-brand-title="${base}">${base} - ${name}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(" data-brand-content=")([^"]*)(")/,
      (m, open, middle, template, close) => `${open}${template.replace(/\{name\}/g, () => name)}${middle}${template}${close}`);
}

function renderSitemap(baseUrl, products) {
  const entries = [`  <url>\n    <loc>${escapeHtml(baseUrl + '/')}</loc>\n  </url>`];
  for (const page of POLICY_PAGES) entries.push(`  <url>\n    <loc>${escapeHtml(`${baseUrl}/${page}.html`)}</loc>\n  </url>`);
  for (const p of products || []) {
    if (entries.length > MAX_SITEMAP_PRODUCTS) break;   // the policy pages above count towards the limit
    const id = p && p._id != null ? String(p._id) : '';
    if (!OBJECT_ID.test(id)) continue;
    const modified = p.updatedAt ? new Date(p.updatedAt) : null;
    const lastmod = modified && !Number.isNaN(modified.getTime())
      ? `\n    <lastmod>${modified.toISOString()}</lastmod>`
      : '';
    entries.push(`  <url>\n    <loc>${escapeHtml(`${baseUrl}/product/${id}`)}</loc>${lastmod}\n  </url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`;
}

// Puts the SEO tags into the storefront HTML at <!--SEO_HEAD- to ; if the marker was removed, they
// go before </head>.
const SEO_MARKER = '<!--SEO_HEAD-->';
function injectHead(html, headHtml) {
  if (html.includes(SEO_MARKER)) return html.replace(SEO_MARKER, () => headHtml);
  return html
    .replace(/<title>[\s\S]*?<\/title>\s*/i, '')
    .replace(/<meta\s+name=["']description["'][^>]*>\s*/i, '')
    .replace(/<\/head>/i, () => `  ${headHtml}\n</head>`);
}

// Admin, seller and first-run setup pages (and the admin API) are never indexed.
function isNoindexPath(path) {
  return /^\/(admin|vendor|setup)(\.html)?(\/|$)/i.test(String(path || ''));
}

module.exports = { galleryImages,
  OBJECT_ID, LIMITS, MAX_SITEMAP_PRODUCTS, DEFAULT_BASE_URL, DEFAULT_SITE_NAME, SEO_MARKER,
  escapeHtml, cleanText, clip, truncate, jsonForScript,
  normalizeBaseUrl, getSiteConfig,
  classifyImage, seoImageUrl, pageImageSrc,
  renderHead, buildHomeHead, buildProductHead,
  renderProductPage, renderMessagePage,
  renderRobots, renderSitemap,
  injectHead, isNoindexPath, POLICY_PAGES, brandPolicyPage
};
