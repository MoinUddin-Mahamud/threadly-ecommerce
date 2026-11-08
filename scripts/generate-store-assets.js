// Draws the pictures for a marketplace listing, from the brand artwork in public/img:
//   store-assets/icon-200x200.svg      (square, 200 x 200)
//   store-assets/preview-1600x800.svg  (wide, 1600 x 800, exactly 2:1)
// node scripts/generate-store-assets.js   Plain SVG files made with Node only (no extra packages).
// Export them to PNG with any browser, Inkscape or ImageMagick at the sizes in the file names.
const fs = require('fs');
const path = require('path');
const { garment } = require('./lib/garments');

const INK = '#0f1f3d', ACCENT = '#e0a92e', CREAM = '#f6f1e4', LIGHT = '#e8edf7', GOLD_LIGHT = '#f6d365';   // the site's navy and gold
const root = path.join(__dirname, '..');
const outDir = path.join(root, 'store-assets');
fs.mkdirSync(outDir, { recursive: true });

// The artwork of public/img/hero.svg (everything after its <title>), reused so the two always match.
const hero = fs.readFileSync(path.join(root, 'public', 'img', 'hero.svg'), 'utf8');
const heroInner = hero.slice(hero.indexOf('</title>') + '</title>'.length, hero.lastIndexOf('</svg>')).trim();

const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200" role="img" aria-label="Threadly icon">
<rect width="200" height="200" fill="${INK}"/>
<circle cx="100" cy="100" r="86" fill="none" stroke="${ACCENT}" stroke-width="2" opacity=".7"/>
<g transform="translate(100 96) scale(.42) translate(-200 -255)">${garment('tee', CREAM)}</g>
<path d="M60 154 Q100 172 140 154" fill="none" stroke="${ACCENT}" stroke-width="4" stroke-linecap="round" stroke-dasharray="1 9"/>
</svg>
`;

const points = [
  'Sellers, commissions and payouts',
  '5 online gateways plus Cash on Delivery',
  'AI chatbot, dark mode and installable app',
  'Node.js, Express and MongoDB'
];
const bullets = points.map((t, i) => {
  const y = 470 + i * 62;
  return `<circle cx="112" cy="${y - 10}" r="9" fill="${ACCENT}"/><text x="140" y="${y}" font-size="34" fill="${LIGHT}">${t}</text>`;
}).join('\n');

const preview = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="800" viewBox="0 0 1600 800" role="img" aria-label="Threadly marketplace preview">
<rect width="1600" height="800" fill="${INK}"/>
<g transform="translate(940 100)">${heroInner}</g>
<g font-family="Georgia, 'Times New Roman', serif" fill="#ffffff">
<text x="100" y="200" font-size="30" fill="${GOLD_LIGHT}" font-family="system-ui, 'Segoe UI', Arial, sans-serif" font-weight="700" letter-spacing="3">NODE.JS CLOTHING MARKETPLACE</text>
<text x="96" y="320" font-size="128" font-weight="700">Threadly</text>
<text x="100" y="396" font-size="40" fill="${LIGHT}" font-family="system-ui, 'Segoe UI', Arial, sans-serif">Many sellers. One cart. One checkout.</text>
</g>
<g font-family="system-ui, 'Segoe UI', Arial, sans-serif">
${bullets}
</g>
</svg>
`;

// The link-preview picture (public/img/og-default.png is the PNG export of this file).
const logoInner = fs.readFileSync(path.join(root, 'public', 'img', 'logo.svg'), 'utf8');
const logoBody = logoInner.slice(logoInner.indexOf('</title>') + '</title>'.length, logoInner.lastIndexOf('</svg>')).trim();
const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="Threadly">
<rect width="1200" height="630" fill="${INK}"/>
<g transform="translate(74 166) scale(.44)">${logoBody}</g>
<g font-family="Georgia, 'Times New Roman', serif">
<text x="70" y="345" font-size="88" font-weight="700" fill="${CREAM}">Threadly</text>
<text x="70" y="410" font-size="32" fill="#f6d365">Clothing from independent sellers, delivered</text>
<text x="70" y="452" font-size="32" fill="#f6d365">to your door.</text>
</g>
<g transform="translate(640 -30) scale(.98)">${heroInner}</g>
</svg>
`;

fs.writeFileSync(path.join(outDir, 'icon-200x200.svg'), icon);
fs.writeFileSync(path.join(outDir, 'og-1200x630.svg'), og);
fs.writeFileSync(path.join(outDir, 'preview-1600x800.svg'), preview);
console.log('Wrote store-assets/icon-200x200.svg, preview-1600x800.svg and og-1200x630.svg');
console.log('Export them to PNG (ImageMagick 7) from inside store-assets/:');
console.log('  magick -background none -density 300 icon-200x200.svg -resize 200x200 icon-200x200.png');
console.log('  magick -background none -density 300 preview-1600x800.svg -resize 1600x800 preview-1600x800.png');
console.log('Link preview (save over public/img/og-default.png):');
console.log('  magick -background none -density 144 og-1200x630.svg -resize 1200x630 og-default.png');
