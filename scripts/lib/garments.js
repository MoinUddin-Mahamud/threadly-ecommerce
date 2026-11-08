'use strict';
// Original flat-style clothing illustrations, drawn in code (no stock art, no licensing
// questions).

const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
function parse(hex) { const h = hex.replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); }
function toHex(rgb) { return '#' + rgb.map((v) => clamp(v).toString(16).padStart(2, '0')).join(''); }
// amount > 0 lightens towards white, < 0 darkens towards black
function shade(hex, amount) {
  const target = amount >= 0 ? 255 : 0;
  return toHex(parse(hex).map((v) => v + (target - v) * Math.abs(amount)));
}
const luminance = (hex) => { const [r, g, b] = parse(hex); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };

const SHAPES = {
  tee: (c) => {
    const d = shade(c, -0.22);
    return `<path d="M138 92 L92 112 L52 182 L98 208 L124 176 L124 410 Q124 418 132 418 L268 418 Q276 418 276 410 L276 176 L302 208 L348 182 L308 112 L262 92 Q200 128 138 92 Z" fill="${c}"/>
<path d="M138 92 Q200 128 262 92 L254 90 Q200 116 146 90 Z" fill="${d}"/>
<path d="M124 176 L134 106 M276 176 L266 106" stroke="${d}" stroke-width="3" opacity=".35" fill="none"/>
<path d="M124 398 L276 398" stroke="${d}" stroke-width="3" opacity=".35"/>`;
  },
  sweater: (c) => {
    const d = shade(c, -0.2);
    return `<path d="M138 92 L96 106 L46 340 L92 352 L128 206 L128 414 Q128 422 136 422 L264 422 Q272 422 272 414 L272 206 L308 352 L354 340 L304 106 L262 92 Q200 128 138 92 Z" fill="${c}"/>
<path d="M46 340 L92 352 L98 323 L52 311 Z M354 340 L308 352 L302 323 L348 311 Z" fill="${d}"/>
<path d="M128 394 L272 394 L272 414 Q272 422 264 422 L136 422 Q128 422 128 414 Z" fill="${d}"/>
<path d="M146 92 Q200 136 254 92 L260 100 Q200 150 140 100 Z" fill="${d}"/>
<path d="M170 170 L170 380 M200 176 L200 384 M230 170 L230 380" stroke="${d}" stroke-width="2" opacity=".25"/>`;
  },
  hoodie: (c) => {
    const d = shade(c, -0.22); const dd = shade(c, -0.38);
    return `<path d="M142 96 Q150 20 200 20 Q250 20 258 96 Q200 132 142 96 Z" fill="${d}"/>
<path d="M138 96 L96 110 L46 340 L92 352 L128 206 L128 414 Q128 422 136 422 L264 422 Q272 422 272 414 L272 206 L308 352 L354 340 L304 110 L262 96 Q200 140 138 96 Z" fill="${c}"/>
<path d="M158 98 Q200 142 242 98 Q238 54 200 50 Q162 54 158 98 Z" fill="${dd}"/>
<path d="M46 340 L92 352 L98 323 L52 311 Z M354 340 L308 352 L302 323 L348 311 Z" fill="${d}"/>
<path d="M128 398 L272 398 L272 414 Q272 422 264 422 L136 422 Q128 422 128 414 Z" fill="${d}"/>
<path d="M150 322 L250 322 L264 394 L136 394 Z" fill="${d}" opacity=".7"/>
<path d="M184 128 L182 188 M216 128 L218 188" stroke="${shade(c, 0.6)}" stroke-width="4" stroke-linecap="round"/>`;
  },
  shirt: (c) => {
    const d = shade(c, -0.2); const l = shade(c, 0.35);
    return `<path d="M138 92 L92 112 L52 182 L98 208 L124 176 L124 410 Q124 418 132 418 L268 418 Q276 418 276 410 L276 176 L302 208 L348 182 L308 112 L262 92 Q200 128 138 92 Z" fill="${c}"/>
<path d="M146 90 L200 146 L168 156 L132 104 Z M254 90 L200 146 L232 156 L268 104 Z" fill="${l}" stroke="${d}" stroke-width="2"/>
<path d="M200 146 L200 418" stroke="${d}" stroke-width="3" opacity=".5"/>
<rect x="222" y="196" width="38" height="42" rx="3" fill="none" stroke="${d}" stroke-width="2.5" opacity=".6"/>
<g fill="${l}" stroke="${d}" stroke-width="1.5"><circle cx="200" cy="178" r="4.5"/><circle cx="200" cy="230" r="4.5"/><circle cx="200" cy="282" r="4.5"/><circle cx="200" cy="334" r="4.5"/><circle cx="200" cy="386" r="4.5"/></g>`;
  },
  dress: (c) => {
    const d = shade(c, -0.2); const l = shade(c, 0.3);
    return `<path d="M166 66 L184 66 L190 122 Q200 136 210 122 L216 66 L234 66 L244 186 L336 436 Q200 470 64 436 L156 186 Z" fill="${c}"/>
<path d="M156 178 L244 178 L247 198 L153 198 Z" fill="${d}"/>
<path d="M200 198 L200 452 M178 198 L132 446 M222 198 L268 446" stroke="${d}" stroke-width="2.5" opacity=".28" fill="none"/>
<path d="M92 430 Q200 462 308 430" stroke="${l}" stroke-width="3" opacity=".5" fill="none"/>`;
  },
  jeans: (c) => {
    const d = shade(c, -0.22); const l = shade(c, 0.38);
    return `<path d="M126 70 L274 70 L292 436 L212 436 L200 196 L188 436 L108 436 Z" fill="${c}"/>
<path d="M126 70 L274 70 L274 98 L126 98 Z" fill="${d}"/>
<path d="M200 98 L200 196 M200 150 Q214 150 214 128" stroke="${l}" stroke-width="2.5" fill="none" stroke-dasharray="6 4"/>
<path d="M134 100 Q146 150 178 118 M266 100 Q254 150 222 118" stroke="${l}" stroke-width="2.5" fill="none" stroke-dasharray="6 4"/>
<path d="M118 418 L190 418 M210 418 L282 418" stroke="${l}" stroke-width="2.5" stroke-dasharray="6 4"/>
<g fill="${d}"><rect x="146" y="64" width="9" height="22" rx="2"/><rect x="245" y="64" width="9" height="22" rx="2"/><rect x="195" y="64" width="10" height="22" rx="2"/></g>`;
  },
  joggers: (c) => {
    const d = shade(c, -0.24);
    return `<path d="M128 70 L272 70 L292 372 L264 440 L214 440 L200 190 L186 440 L136 440 L108 372 Z" fill="${c}"/>
<path d="M128 70 L272 70 L272 100 L128 100 Z" fill="${d}"/>
<path d="M136 418 L186 418 L186 444 L136 444 Z M214 418 L264 418 L264 444 L214 444 Z" fill="${d}"/>
<path d="M186 100 L184 150 M214 100 L216 150" stroke="${shade(c, 0.6)}" stroke-width="4" stroke-linecap="round"/>
<path d="M200 100 L200 190" stroke="${d}" stroke-width="2.5" opacity=".5"/>
<path d="M130 130 Q142 190 160 200 M270 130 Q258 190 240 200" stroke="${d}" stroke-width="2.5" fill="none" opacity=".5"/>`;
  },
  shorts: (c) => {
    const d = shade(c, -0.22); const l = shade(c, 0.38);
    return `<path d="M126 110 L274 110 L294 304 L212 304 L200 206 L188 304 L106 304 Z" fill="${c}"/>
<path d="M126 110 L274 110 L274 138 L126 138 Z" fill="${d}"/>
<path d="M200 138 L200 206" stroke="${l}" stroke-width="2.5" stroke-dasharray="6 4"/>
<path d="M134 140 Q146 186 176 156 M266 140 Q254 186 224 156" stroke="${l}" stroke-width="2.5" fill="none" stroke-dasharray="6 4"/>
<path d="M112 290 L184 290 M216 290 L288 290" stroke="${l}" stroke-width="2.5" stroke-dasharray="6 4"/>`;
  },
  skirt: (c) => {
    const d = shade(c, -0.2);
    return `<path d="M150 118 L250 118 L320 424 L80 424 Z" fill="${c}"/>
<path d="M148 110 L252 110 L254 140 L146 140 Z" fill="${d}"/>
<path d="M170 140 L128 424 M190 140 L168 424 M210 140 L232 424 M230 140 L272 424 M200 140 L200 424" stroke="${d}" stroke-width="2.5" opacity=".3" fill="none"/>
<path d="M86 408 L314 408" stroke="${d}" stroke-width="3" opacity=".3"/>`;
  },
  kurta: (c) => {
    const d = shade(c, -0.2); const l = shade(c, 0.45);
    return `<path d="M146 82 L98 100 L50 286 L96 298 L128 196 L128 452 Q128 460 136 460 L264 460 Q272 460 272 452 L272 196 L304 298 L350 286 L302 100 L254 82 Q200 116 146 82 Z" fill="${c}"/>
<path d="M150 84 Q200 120 250 84 L256 94 Q200 134 144 94 Z" fill="${d}"/>
<path d="M200 118 L200 262" stroke="${l}" stroke-width="10" opacity=".55"/>
<g fill="${d}"><circle cx="200" cy="146" r="4.5"/><circle cx="200" cy="184" r="4.5"/><circle cx="200" cy="222" r="4.5"/></g>
<g fill="${l}" opacity=".7"><path d="M200 270 l7 9 l-7 9 l-7 -9 Z M200 296 l5 6 l-5 6 l-5 -6 Z"/></g>
<path d="M128 446 L272 446" stroke="${l}" stroke-width="5" opacity=".5" stroke-dasharray="2 9" stroke-linecap="round"/>
<path d="M60 270 L96 280 M340 270 L304 280" stroke="${l}" stroke-width="4" opacity=".45" stroke-dasharray="2 8" stroke-linecap="round"/>`;
  },
  tote: (c) => {
    const d = shade(c, -0.22); const l = shade(c, 0.35);
    return `<path d="M148 206 Q148 70 200 70 Q252 70 252 206" fill="none" stroke="${d}" stroke-width="14" stroke-opacity="1" stroke-linecap="round"/>
<path d="M98 190 L302 190 L322 438 Q322 452 308 452 L92 452 Q78 452 78 438 Z" fill="${c}"/>
<path d="M98 190 L302 190 L305 232 L95 232 Z" fill="${d}" opacity=".5"/>
<rect x="164" y="288" width="72" height="72" rx="8" fill="none" stroke="${l}" stroke-width="3.5" stroke-opacity="1" opacity=".75"/>
<path d="M180 324 L220 324 M200 304 L200 344" stroke="${l}" stroke-width="3.5" stroke-opacity="1" stroke-linecap="round" opacity=".75"/>`;
  },
  cap: (c) => {
    const d = shade(c, -0.24); const l = shade(c, 0.4);
    return `<path d="M96 300 Q92 150 200 146 Q308 150 304 300 Z" fill="${c}"/>
<path d="M200 150 L200 300 M150 170 Q140 240 146 300 M250 170 Q260 240 254 300" stroke="${d}" stroke-width="2.5" stroke-opacity="1" opacity=".4" fill="none"/>
<path d="M88 300 L312 300 Q372 304 386 342 Q330 364 190 346 Q110 338 88 300 Z" fill="${d}"/>
<path d="M96 300 L304 300 L304 314 L96 314 Z" fill="${l}" opacity=".35"/>
<circle cx="200" cy="148" r="9" fill="${d}"/>`;
  },
  scarf: (c) => {
    const d = shade(c, -0.22); const l = shade(c, 0.4);
    return `<path d="M106 96 Q200 156 294 96 L302 152 Q200 214 98 152 Z" fill="${c}"/>
<path d="M164 176 L238 176 L268 432 L196 432 Z" fill="${c}"/>
<path d="M214 196 L262 184 L304 424 L252 432 Z" fill="${d}"/>
<path d="M176 290 L252 290 M180 320 L260 320 M184 350 L266 350" stroke="${l}" stroke-width="6" stroke-opacity="1" opacity=".55"/>
<path d="M200 432 L268 432 M252 432 L304 424" stroke="${l}" stroke-width="8" stroke-opacity="1" stroke-dasharray="2 7" stroke-linecap="round" opacity=".7"/>`;
  },
  belt: (c) => {
    const d = shade(c, -0.22); const l = shade(c, 0.3);
    return `<path d="M44 226 L356 226 Q364 226 364 234 L364 266 Q364 274 356 274 L44 274 Q36 274 36 266 L36 234 Q36 226 44 226 Z" fill="${c}"/>
<path d="M50 238 L350 238 M50 262 L350 262" stroke="${l}" stroke-width="2.5" stroke-opacity="1" stroke-dasharray="7 5" opacity=".7" fill="none"/>
<g fill="${d}"><circle cx="276" cy="250" r="5"/><circle cx="300" cy="250" r="5"/><circle cx="324" cy="250" r="5"/></g>
<rect x="146" y="206" width="84" height="88" rx="10" fill="none" stroke="#c9a24a" stroke-width="12" stroke-opacity="1"/>
<rect x="190" y="242" width="52" height="16" rx="4" fill="#c9a24a"/>`;
  }
};

// Younger children: the same shapes, drawn smaller on the board.
function garment(type, color, { kids = false } = {}) {
  const shape = SHAPES[type];
  if (!shape) throw new Error(`Unknown garment "${type}"`);
  // A faint outline keeps very light pieces (white, ivory) visible on their backdrop.
  const g = `<g stroke="#000" stroke-opacity=".14" stroke-width="2" stroke-linejoin="round">${shape(color)}</g>`;
  return kids ? `<g transform="translate(200 270) scale(.82) translate(-200 -270)">${g}</g>` : g;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A finished 400 x 500 product picture: soft backdrop plus the garment with a floor shadow.
function productSvg({ title, type, color, kids = false }) {
  const light = luminance(color) > 0.72;
  const bgA = light ? '#e9e3d9' : shade(color, 0.86);
  const bgB = light ? '#d9d1c4' : shade(color, 0.72);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bgA}"/><stop offset="1" stop-color="${bgB}"/></linearGradient></defs>
<rect width="400" height="500" fill="url(#bg)"/>
<circle cx="200" cy="250" r="168" fill="#ffffff" opacity=".38"/>
<ellipse cx="200" cy="474" rx="118" ry="11" fill="#000" opacity=".12"/>
${garment(type, color, { kids })}
</svg>
`;
}

module.exports = { SHAPES, garment, productSvg, shade, luminance, esc };
