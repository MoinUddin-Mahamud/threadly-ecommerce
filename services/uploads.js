'use strict';

// Where uploaded product pictures are kept.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Product = require('../models/Product');
const { parseDataUri } = require('./images');

const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const UPLOAD_URL = /^\/uploads\/[0-9a-f]{32}\.(png|jpg|webp|gif)$/;
const UPLOAD_FILE = /^[0-9a-f]{32}\.(png|jpg|webp|gif)$/;

const storageMode = (env = process.env) => (String(env.UPLOAD_STORAGE || '').trim().toLowerCase() === 'database' ? 'database' : 'disk');
const uploadDir = (env = process.env) => path.resolve(env.UPLOAD_DIR ? String(env.UPLOAD_DIR) : path.join(__dirname, '..', 'uploads'));

let warned = false;
function warnOnce(message) { if (!warned) { warned = true; console.warn(message); } }

// Makes sure the upload folder exists and can be written to. Returns true when pictures can be
// stored on disk.
function ensureUploadDir(env = process.env) {
  if (storageMode(env) !== 'disk') return false;
  const dir = uploadDir(env);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (err) {
    warnOnce(`Uploads: cannot write to ${dir} (${err.code || err.message}). New pictures are kept in the database instead. Fix UPLOAD_DIR or set UPLOAD_STORAGE=database.`);
    return false;
  }
}

// Turns an image value that passed cleanImageInput into what is stored with the product: a data:
// upload becomes a file address (disk mode), anything else is returned unchanged.
async function storeImageValue(value, env = process.env) {
  if (typeof value !== 'string' || !value.startsWith('data:image/')) return value;
  if (storageMode(env) !== 'disk') return value;
  const parsed = parseDataUri(value);
  if (!parsed) return value;
  try {
    if (!ensureUploadDir(env)) return value;
    const name = `${crypto.randomBytes(16).toString('hex')}.${EXTENSIONS[parsed.type]}`;
    await fs.promises.writeFile(path.join(uploadDir(env), name), parsed.buffer, { flag: 'wx', mode: 0o644 });
    return `/uploads/${name}`;
  } catch (err) {
    warnOnce(`Uploads: writing a picture failed (${err.code || err.message}). It was kept in the database instead.`);
    return value;
  }
}

// Deletes the picture files in `urls` that no product refers to any more. Best effort: a problem
// is logged and never stops the request that called it.
async function removeUnusedUploads(urls, env = process.env) {
  const candidates = [...new Set((urls || []).filter((u) => typeof u === 'string' && UPLOAD_URL.test(u)))];
  for (const url of candidates) {
    try {
      if (await Product.exists({ $or: [{ imageUrl: url }, { images: url }] })) continue;
      await fs.promises.unlink(path.join(uploadDir(env), path.basename(url)));
    } catch (err) {
      if (!err || err.code !== 'ENOENT') console.error('Uploads: could not remove a picture file:', err && err.message);
    }
  }
}

// Stores every upload in a gallery list.
async function storeGallery(values, env = process.env) {
  const out = [];
  for (const v of values) {
    const stored = await storeImageValue(v, env);
    if (typeof stored === 'string' && stored.startsWith('data:')) {
      throw new Error('The extra pictures could not be saved: the upload folder is not writable. Check UPLOAD_DIR.');
    }
    out.push(stored);
  }
  return out;
}

// Stores the pictures of one product save: `data.imageUrl` (when present) and, when the list was
// sent, `data.images`.
async function applyPictures(data, gallery, env = process.env) {
  if (typeof data.imageUrl === 'string') data.imageUrl = await storeImageValue(data.imageUrl, env);
  if (gallery && gallery.provided) data.images = await storeGallery(gallery.values, env);
  return data;
}

// Deletes picture files that no product refers to and that are older than `maxAgeMs` (default one
// day): pictures that were uploaded in a product form which was never saved.
async function sweepOrphanUploads(maxAgeMs = 24 * 60 * 60 * 1000, env = process.env) {
  if (storageMode(env) !== 'disk') return 0;
  const dir = uploadDir(env);
  let names;
  try { names = (await fs.promises.readdir(dir)).filter((n) => UPLOAD_FILE.test(n)); } catch (err) { return 0; }
  if (!names.length) return 0;
  const used = new Set();
  const products = await Product.find({ $or: [{ imageUrl: /^\/uploads\// }, { images: /^\/uploads\// }] }).select('imageUrl images').lean();
  for (const p of products) picturesOf(p).forEach((u) => used.add(path.basename(u)));
  let removed = 0;
  for (const name of names) {
    if (used.has(name)) continue;
    try {
      const file = path.join(dir, name);
      const stat = await fs.promises.stat(file);
      if (Date.now() - stat.mtimeMs < maxAgeMs) continue;
      await fs.promises.unlink(file);
      removed += 1;
    } catch (err) { /* already gone */ }
  }
  return removed;
}

const MAX_PICTURES_PER_VENDOR = 300;

// Picture files a seller holds: those their products use, plus uploads from the last day that no
// product uses yet (they cannot be tied to a seller, so every seller is charged for them). Pass
// no vendorId for the store's own products.
async function storedPictureCount(vendorId, env = process.env) {
  const mine = await Product.find({ vendorId: vendorId || null, $or: [{ imageUrl: /^\/uploads\// }, { images: /^\/uploads\// }] }).select('imageUrl images').lean();
  const used = new Set();
  for (const p of mine) picturesOf(p).filter((u) => UPLOAD_URL.test(u)).forEach((u) => used.add(path.basename(u)));

  const dir = uploadDir(env);
  let names;
  try { names = (await fs.promises.readdir(dir)).filter((n) => UPLOAD_FILE.test(n) && !used.has(n)); } catch (err) { return used.size; }
  const recent = [];
  for (const name of names) {
    try {
      const stat = await fs.promises.stat(path.join(dir, name));
      if (Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000) recent.push(name);
    } catch (err) { /* already gone */ }
  }
  if (!recent.length) return used.size;
  const urls = recent.map((n) => `/uploads/${n}`);
  const taken = await Product.find({ $or: [{ imageUrl: { $in: urls } }, { images: { $in: urls } }] }).select('imageUrl images').lean();
  const takenNames = new Set();
  for (const p of taken) picturesOf(p).forEach((u) => takenNames.add(path.basename(u)));
  return used.size + recent.filter((n) => !takenNames.has(n)).length;
}

// The picture addresses a product record refers to (main picture first).
const picturesOf = (p) => [p && p.imageUrl, ...((p && Array.isArray(p.images)) ? p.images : [])].filter((u) => typeof u === 'string' && u);

module.exports = { MAX_PICTURES_PER_VENDOR, storedPictureCount, UPLOAD_URL, UPLOAD_FILE, storageMode, uploadDir, ensureUploadDir, storeImageValue, storeGallery, applyPictures, removeUnusedUploads, sweepOrphanUploads, picturesOf };
