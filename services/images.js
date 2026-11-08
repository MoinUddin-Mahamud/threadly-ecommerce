'use strict';

// Product images. An admin may paste an image address or upload a file. By default an upload is
// saved as a file in UPLOAD_DIR (see uploads.js); with UPLOAD_STORAGE=database it is kept in the
// database as a data: URI.

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;   // decoded size of one upload
const DATA_URI = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;
const SERVED_URL = /^\/api\/products\/[0-9a-fA-F]{24}\/image(\?.*)?$/;

// Quick check of the first bytes, so a text file renamed to .png is refused.
const SIGNATURES = {
  png:  (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  jpeg: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  jpg:  (b) => SIGNATURES.jpeg(b),
  gif:  (b) => b.length > 6 && b.slice(0, 3).toString('latin1') === 'GIF',
  webp: (b) => b.length > 12 && b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP'
};

// Parses a data: URI. Resolves to { type, buffer } or null when it is not a
// well-formed, supported image within the size limit.
function parseDataUri(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_IMAGE_BYTES * 1.4) + 64) return null;
  const m = DATA_URI.exec(value);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) return null;
  if (!SIGNATURES[kind](buffer)) return null;
  return { type: kind === 'jpg' ? 'image/jpeg' : `image/${kind}`, buffer };
}

// Cleans the imageUrl an admin sent.
function cleanImageInput(input) {
  if (input === undefined || input === null || input === '') return { ok: true, value: '' };
  if (typeof input !== 'string') return { ok: false, message: 'Image must be text (an address or an uploaded picture).' };
  const value = input.trim();
  if (SERVED_URL.test(value)) return { ok: true, value, keep: true };
  if (value.startsWith('data:')) {
    return parseDataUri(value)
      ? { ok: true, value }
      : { ok: false, message: 'Image must be a PNG, JPG, WebP or GIF picture of at most 2 MB.' };
  }
  if (value.length > 500) return { ok: false, message: 'Image address is too long.' };
  // https addresses, or a file of this site (/img/...). A path may not start with // or /\ and may
  // not contain a backslash: browsers read "/\host" like "//host" and would go to another site.
  const isUrl = /^https:\/\/[^\s<>"'\\]+$/i.test(value);
  if (!isUrl && !isLocalImagePath(value)) {
    return { ok: false, message: 'Image address must start with https:// or /.' };
  }
  return { ok: true, value };
}

const MAX_GALLERY_IMAGES = 5;   // extra pictures besides the main one (6 in all)

// Cleans the list of extra pictures an admin or seller sent.
function cleanImageList(input, { allowUploads = true } = {}) {
  if (input === undefined || input === null) return { ok: true, provided: false, values: [] };
  if (!Array.isArray(input)) return { ok: false, message: 'Pictures must be a list.' };
  if (input.length > MAX_GALLERY_IMAGES) return { ok: false, message: `At most ${MAX_GALLERY_IMAGES} extra pictures are allowed (${MAX_GALLERY_IMAGES + 1} in all).` };
  const values = [];
  for (const entry of input) {
    const image = cleanImageInput(entry);
    if (!image.ok) return image;
    if (!image.value || image.keep) continue;   // blanks and the "keep the stored picture" address mean nothing here
    if (image.value.startsWith('data:') && !allowUploads) {
      return { ok: false, message: 'Several pictures need UPLOAD_STORAGE=disk (picture files on disk). Use picture addresses instead.' };
    }
    if (!values.includes(image.value)) values.push(image.value);
  }
  return { ok: true, provided: true, values };
}

// A path on this site, such as /img/products/x.svg. Rejects //host, /\host, any backslash and
// anything with spaces, quotes or angle brackets.
function isLocalImagePath(value) {
  return typeof value === 'string' && value.length <= 500 && /^\/(?![\/\\])[^\s<>"'\\]*$/.test(value);
}

// A MongoDB aggregation stage for product LISTS: replaces an uploaded picture (a data
// address that can be megabytes) by a short marker, so lists never load the pictures into
// memory. publicProduct turns the marker into the normal /api/products/<id>/image address.
function listImageStage() {
  return {
    $addFields: {
      imageUrl: {
        $cond: [
          { $eq: [{ $substrCP: [{ $ifNull: ['$imageUrl', ''] }, 0, 11] }, 'data:image/'] },
          'data:image/uploaded',
          '$imageUrl'
        ]
      }
    }
  };
}

// What a product looks like in a list: an uploaded picture is replaced by a
// short, cacheable address, so lists stay small.
function publicProduct(product) {
  const p = typeof product.toObject === 'function' ? product.toObject() : { ...product };
  if (typeof p.imageUrl === 'string' && p.imageUrl.startsWith('data:image/')) {
    const v = p.updatedAt ? new Date(p.updatedAt).getTime() : 0;
    p.imageUrl = `/api/products/${p._id}/image?v=${v}`;
  }
  return p;
}

module.exports = { MAX_IMAGE_BYTES, MAX_GALLERY_IMAGES, cleanImageList, SERVED_URL, parseDataUri, cleanImageInput, isLocalImagePath, listImageStage, publicProduct };
