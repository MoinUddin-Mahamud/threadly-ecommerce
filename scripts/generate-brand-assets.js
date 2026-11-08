// Draws the logo and the homepage artwork (public/img/logo.svg, hero.svg). node
// scripts/generate-brand-assets.js Replace those two files with your own brand artwork whenever
// you like.
const fs = require('fs');
const path = require('path');
const { garment } = require('./lib/garments');

const INK = '#0f1f3d', ACCENT = '#e0a92e', CREAM = '#f6f1e4';
const out = (name, svg) => fs.writeFileSync(path.join(__dirname, '..', 'public', 'img', name), svg);

out('logo.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="Logo">
<title>Logo</title>
<circle cx="100" cy="100" r="98" fill="${INK}"/>
<circle cx="100" cy="100" r="90" fill="none" stroke="${ACCENT}" stroke-width="2" opacity=".7"/>
<g transform="translate(100 96) scale(.4) translate(-200 -255)">${garment('tee', CREAM)}</g>
<path d="M62 152 Q100 170 138 152" fill="none" stroke="${ACCENT}" stroke-width="4" stroke-linecap="round" stroke-dasharray="1 9"/>
</svg>
`);

out('hero.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 600" role="img" aria-label="A hoodie, a dress and a pair of jeans">
<title>A hoodie, a dress and a pair of jeans</title>
<circle cx="320" cy="300" r="268" fill="#ebe5d2"/>
<circle cx="450" cy="190" r="120" fill="#a3b18a" opacity=".35"/>
<circle cx="170" cy="440" r="90" fill="${ACCENT}" opacity=".18"/>
<g transform="translate(-14 70) rotate(-7 200 250) scale(.78)">${garment('hoodie', ACCENT)}</g>
<g transform="translate(330 78) rotate(7 200 250) scale(.76)">${garment('jeans', '#2f4b7c')}</g>
<g transform="translate(150 22) scale(.93)">${garment('dress', '#8fb8de')}</g>
</svg>
`);
console.log('Wrote public/img/logo.svg and public/img/hero.svg');
