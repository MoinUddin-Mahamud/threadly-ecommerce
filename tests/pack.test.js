// Tests for scripts/pack.js: what the release zip leaves out and that the zip it writes is valid.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { isExcluded, listFiles, buildZip, crc32, pack } = require('../scripts/pack');

// Reads a zip back through its central directory.
function readZip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'end of central directory');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(off + 26);
    const lelen = buf.readUInt16LE(off + 28);
    const raw = buf.slice(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    assert.equal(data.length, size, `${name}: size`);
    assert.equal(crc32(data), crc, `${name}: crc`);
    out[name] = data.toString('utf8');
    p += 46 + nlen + elen + clen;
  }
  return out;
}

test('the release zip leaves out secrets, uploads, store pictures, dependencies and zip files', () => {
  for (const rel of ['.env', '.env.local', '.env.production', 'uploads/a.png', 'store-assets/preview-1600x800.png',
    'store-assets/icon-200x200.svg', 'node_modules/express/index.js', 'coverage/lcov.info', 'dist/x.js', 'threadly.zip',
    'old/backup.zip', '.git/config', 'server.log', 'public/.DS_Store']) {
    assert.equal(isExcluded(rel), true, `${rel} is left out`);
  }
  for (const rel of ['.env.example', 'README.md', 'docs/index.html', 'routes/api.js', 'public/uploads-help.html', 'public/img/products/a.svg', '.dockerignore', '.gitignore']) {
    assert.equal(isExcluded(rel), false, `${rel} is kept`);
  }
});

test('the zip is valid, keeps one top-level folder, and holds exactly the allowed files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-'));
  try {
    const files = { 'package.json': '{"name":"x"}', '.env': 'SECRET=1', '.env.example': 'A=1', 'uploads/p.png': 'bin',
      'node_modules/m/i.js': 'x', 'store-assets/a.png': 'x', 'routes/api.js': 'module.exports = 1;\n'.repeat(200), 'public/ünï.txt': 'unicode name', 'old.zip': 'z' };
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    assert.deepEqual(listFiles(dir), ['.env.example', 'package.json', 'public/ünï.txt', 'routes/api.js']);
    const out = path.join(dir, 'out.zip');
    const { count } = pack(dir, out);
    assert.equal(count, 4);
    const zip = readZip(fs.readFileSync(out));
    assert.deepEqual(Object.keys(zip).sort(), ['threadly/.env.example', 'threadly/package.json', 'threadly/public/ünï.txt', 'threadly/routes/api.js']);
    assert.ok(Object.keys(zip).every((n) => n.startsWith('threadly/')), 'one top-level folder');
    assert.equal(zip['threadly/routes/api.js'], files['routes/api.js']);
    assert.equal(zip['threadly/public/ünï.txt'], 'unicode name');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('buildZip handles an empty file and data that does not compress', () => {
  const noise = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 97 + 13) % 251));
  const zip = readZip(buildZip([{ name: 'a/empty.txt', data: Buffer.alloc(0) }, { name: 'a/noise.bin', data: noise }]));
  assert.equal(zip['a/empty.txt'], '');
  assert.equal(Buffer.from(zip['a/noise.bin'], 'utf8').length > 0, true);
});

test('npm run pack is defined', () => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).scripts.pack, 'node scripts/pack.js');
});
