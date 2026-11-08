// Builds the zip you sell or deploy: threadly.zip, with one top-level folder named threadly.
// npm run pack   Plain Node (no extra packages), so it also works on Windows.
// Left out: node_modules, .git, .env (and every other .env.* except .env.example), uploads,
// store-assets, coverage, dist, logs, system files and any .zip file.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT_EXCLUDES = new Set(['.env', 'uploads', 'store-assets', 'dist']);
const ANY_DEPTH_EXCLUDES = new Set(['node_modules', '.git', 'coverage', '.DS_Store', 'Thumbs.db', 'npm-debug.log']);

// rel is the path from the project folder with forward slashes, for example "routes/api.js".
function isExcluded(rel) {
  const parts = rel.split('/');
  const name = parts[parts.length - 1];
  if (ROOT_EXCLUDES.has(parts[0])) return true;
  if (parts.some((p) => ANY_DEPTH_EXCLUDES.has(p))) return true;
  if (/\.zip$/i.test(name) || /\.log$/i.test(name)) return true;
  if (/^\.env($|\.)/.test(name) && name !== '.env.example') return true;
  return false;
}

function listFiles(root, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (isExcluded(r)) continue;
    if (entry.isDirectory()) out.push(...listFiles(root, r));
    else if (entry.isFile()) out.push(r);
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosTime(date) {
  const d = new Date(Math.max(date.getTime(), Date.UTC(1980, 0, 2)));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

// entries: [{ name, data: Buffer, mtime: Date }]. Returns the zip file as a Buffer.
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const deflated = zlib.deflateRawSync(e.data, { level: 9 });
    const stored = deflated.length >= e.data.length;
    const body = stored ? e.data : deflated;
    const method = stored ? 0 : 8;
    const { time, date } = dosTime(e.mtime || new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // names are UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);   // made on Unix, version 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((0o100644) << 16) >>> 0, 38);   // regular file, rw-r--r--
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

function pack(root, outPath) {
  const folder = 'threadly';
  const files = listFiles(root);
  const entries = files.map((rel) => ({
    name: `${folder}/${rel}`,
    data: fs.readFileSync(path.join(root, rel)),
    mtime: fs.statSync(path.join(root, rel)).mtime
  }));
  fs.writeFileSync(outPath, buildZip(entries));
  return { count: entries.length, outPath };
}

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const out = path.join(root, 'threadly.zip');
  if (fs.existsSync(out)) fs.unlinkSync(out);
  const { count } = pack(root, out);
  console.log(`Wrote ${path.basename(out)} (${count} files, one top-level folder). Check it with: npm ci && npm test`);
}

module.exports = { isExcluded, listFiles, buildZip, crc32, pack };
