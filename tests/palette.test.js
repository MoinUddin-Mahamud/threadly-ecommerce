// One colour palette: --ui-* in ui2.css, light and dark. The other stylesheets only use it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = (name) => fs.readFileSync(path.join(__dirname, '..', 'public', 'css', name), 'utf8');
const hexes = (text) => (text.match(/#[0-9a-fA-F]{3,8}\b/g) || []).map((h) => h.toLowerCase());

test('ui2.css defines the palette for light and dark, including success and failure colours', () => {
  const ui2 = css('ui2.css');
  for (const token of ['--ui-navy', '--ui-gold', '--ui-ink', '--ui-bg', '--ui-card', '--ui-muted', '--ui-sand', '--ui-field', '--ui-head', '--ui-ok', '--ui-bad']) {
    assert.ok(ui2.includes(`${token}:`), token);
  }
  const dark = ui2.slice(ui2.indexOf('[data-bs-theme="dark"] {'));
  for (const token of ['--ui-bg', '--ui-card', '--ui-ink', '--ui-muted', '--ui-ok', '--ui-bad']) assert.ok(dark.includes(`${token}:`), `dark ${token}`);
});

test('theme.css and payment.css define no colours of their own, apart from white text on navy', () => {
  for (const file of ['theme.css', 'payment.css']) {
    const own = hexes(css(file)).filter((h) => h !== '#fff' && h !== '#ffffff' && h !== '#555');   // #555 only matches an inline style
    assert.deepEqual(own, [], `${file} has its own colours`);
  }
});

test('the old grey GitHub-dark colours and the brown marketplace dark colours are gone', () => {
  const old = ['#161b22', '#0d1117', '#30363d', '#21262d', '#e6edf3', '#f0f6fc', '#9da7b3', '#201b18', '#a79c93'];
  for (const file of ['theme.css', 'payment.css', 'marketplace.css', 'styles.css', 'ui2.css']) {
    const found = hexes(css(file)).filter((h) => old.includes(h));
    assert.deepEqual(found, [], file);
  }
});

test('marketplace.css and styles.css only alias the palette, they do not define colour values', () => {
  const mk = css('marketplace.css');
  assert.doesNotMatch(mk, /--mk-(cream|sand|card|text|muted|line|accent|ink)\s*:\s*#/);
  const root = css('styles.css').slice(0, css('styles.css').indexOf('--shadow-sm'));
  assert.deepEqual(hexes(root).filter((h) => h !== '#ffffff'), []);
});

test('the payment pages draw their icons inline, so they show without the icon font, and label them', () => {
  for (const [file, id] of [['payment-success.html', 'heading'], ['payment-fail.html', 'pageTitle']]) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
    assert.match(html, /<div class="pay-icon pay-icon-(ok|fail)" role="img" aria-labelledby="/, file);
    assert.ok(html.includes(`aria-labelledby="${id}"`), `${file} is labelled by its heading`);
    assert.match(html, /<div class="pay-icon[^>]*>\s*<svg/, `${file}: an inline SVG, not an icon font`);
  }
});

test('the server-rendered product page uses the shop palette and the saved light or dark choice', () => {
  const seo = require('../services/seo');
  const html = seo.renderProductPage(
    { _id: '64b7f0c2a1b2c3d4e5f60718', title: 'Tee', price: 10, stock: 5, category: 'Men', description: 'A tee.', imageUrl: '/img/x.svg', ratingAverage: 4.5, ratingCount: 1 },
    { siteName: 'Acme', siteDescription: 'Shop.', baseUrl: 'https://shop.example.com' },
    [{ rating: 5, authorName: 'Sam', text: 'Great.', createdAt: new Date() }]
  );
  assert.ok(html.includes('href="/css/ui2.css"'), 'palette stylesheet');
  assert.ok(html.includes('src="/js/theme.js"'), 'light and dark choice');
  assert.ok(html.indexOf('/css/ui2.css') > html.indexOf('bootstrap.min.css'), 'after Bootstrap, so it wins');
  assert.deepEqual(hexes(html).filter((h) => ['#001f3f', '#003366', '#d4af37', '#f4d03f', '#f8f9fa', '#212529'].includes(h)), []);
  assert.doesNotMatch(html, /bg-white/);
});

test('no colour from the original blue theme is left in the stylesheets', () => {
  for (const file of ['styles.css', 'marketplace.css', 'theme.css', 'payment.css', 'ui2.css']) {
    assert.doesNotMatch(css(file), /0,\s*102,\s*204/, `${file} still has the old blue`);
    assert.deepEqual(hexes(css(file)).filter((h) => ['#0066cc', '#0d6efd', '#007bff'].includes(h)), [], file);
  }
});

test('info notices and badges follow the palette instead of Bootstrap cyan', () => {
  const ui2 = css('ui2.css');
  assert.match(ui2, /\.alert-info\s*\{[^}]*--bs-alert-bg:\s*var\(--ui-sand\)/);
  assert.match(ui2, /\.badge\.bg-info[^{]*\{[^}]*var\(--ui-navy-2\)/);
});
