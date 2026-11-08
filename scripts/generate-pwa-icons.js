// Draws the app icons used when the store is installed on a phone (public/img/icon-192.png,
// icon-512.png). node scripts/generate-pwa-icons.js Plain PNG files made with Node only (no extra
// packages).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const INK = [0x0f, 0x1f, 0x3d], ACCENT = [0xe0, 0xa9, 0x2e], CREAM = [0xf6, 0xf1, 0xe4];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// A full-bleed dark square with a cream disc, an accent ring and a small "T" cut into the disc.
function png(size) {
  const rows = [];
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - c, dy = y + 0.5 - c;
      const r = Math.sqrt(dx * dx + dy * dy) / (size / 2);   // 0 centre ... 1 edge
      let col = INK;
      if (r < 0.62) col = CREAM;
      else if (r < 0.68) col = ACCENT;
      // the letter T inside the disc
      const u = dx / (size / 2), v = dy / (size / 2);
      const bar = Math.abs(u) < 0.26 && v > -0.3 && v < -0.17;
      const stem = Math.abs(u) < 0.065 && v >= -0.17 && v < 0.3;
      if (r < 0.62 && (bar || stem)) col = INK;
      row[1 + x * 3] = col[0]; row[2 + x * 3] = col[1]; row[3 + x * 3] = col[2];
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;   // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })), chunk('IEND', Buffer.alloc(0))
  ]);
}

for (const size of [192, 512]) {
  fs.writeFileSync(path.join(__dirname, '..', 'public', 'img', `icon-${size}.png`), png(size));
}
console.log('Wrote public/img/icon-192.png and public/img/icon-512.png');
