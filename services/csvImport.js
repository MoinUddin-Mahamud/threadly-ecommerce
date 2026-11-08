'use strict';

// Bulk product import from a CSV file (admin panel to Products to Import CSV).

const { cleanImageInput } = require('./images');
const { canonicalCategory, CATEGORY_MESSAGE } = require('./categories');
const { parsePrice } = require('./productRules');
const { plainName } = require('./plainText');
const { cleanSizeStock, sizeStockTotal } = require('./sizes');

const MAX_ROWS = 500;
const MAX_CSV_CHARS = 1000000;
const MODES = ['create', 'update', 'upsert'];

const COLUMN_ALIASES = {
  title: ['title', 'name', 'productname', 'producttitle', 'product'],
  description: ['description', 'desc'],
  price: ['price', 'regularprice'],
  stock: ['stock', 'quantity', 'qty', 'inventory'],
  sizes: ['sizes', 'sizestock', 'stockbysize', 'stockpersize'],
  category: ['category'],
  imageUrl: ['imageurl', 'image', 'imagelink', 'picture']
};

function detectDelimiter(text) {
  let firstLine = '';
  let inQuotes = false;
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    if ((ch === '\n' || ch === '\r') && !inQuotes) break;
    firstLine += ch;
  }
  let best = ',';
  let bestCount = 0;
  for (const d of [',', ';', '\t']) {
    const count = firstLine.split(d).length - 1;
    if (count > bestCount) { best = d; bestCount = count; }
  }
  return best;
}

// Returns an array of rows, each an array of cell strings
function parseCsv(input) {
  let text = String(input || '');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);   // BOM that Excel adds
  const delimiter = detectDelimiter(text);
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  let quotedCell = false;

  const endCell = () => { row.push(cell); cell = ''; quotedCell = false; };
  const endRow = () => {
    endCell();
    // skip completely empty lines
    if (!(row.length === 1 && row[0].trim() === '' )) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else { inQuotes = false; }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === '' && !quotedCell) {
      inQuotes = true;
      quotedCell = true;
    } else if (ch === delimiter) {
      endCell();
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      endRow();
    } else if (ch === '\n') {
      endRow();
    } else {
      cell += ch;
    }
  }
  if (inQuotes) { const e = new Error('A quoted value is never closed.'); e.csv = true; throw e; }
  if (cell !== '' || row.length) endRow();
  return rows;
}

const headerKey = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Reads the CSV text. Resolves to { ok: true, columns, rows: [{ line, cells: {field: text} }] } or
// { ok: false, message }.
function readProductCsv(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, message: 'The CSV file is empty.' };
  if (text.length > MAX_CSV_CHARS) return { ok: false, message: 'The CSV file is too large (max 1 MB).' };

  let table;
  try { table = parseCsv(text); } catch (err) {
    return { ok: false, message: err.csv ? err.message : 'The CSV file could not be read.' };
  }
  if (table.length < 2) return { ok: false, message: 'The CSV needs a header row and at least one product row.' };

  const header = table[0].map(headerKey);
  const columnIndex = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const idx = header.findIndex((h) => aliases.includes(h));
    if (idx !== -1) columnIndex[field] = idx;
  }
  if (columnIndex.title === undefined) {
    return { ok: false, message: 'The first row must contain a "title" column.' };
  }
  const dataRows = table.slice(1);
  if (dataRows.length > MAX_ROWS) return { ok: false, message: `Too many rows (max ${MAX_ROWS} per import).` };

  const rows = dataRows.map((cells, i) => {
    const out = {};
    for (const [field, idx] of Object.entries(columnIndex)) out[field] = (cells[idx] || '').trim();
    return { line: i + 2, cells: out };   // line 1 is the header
  });
  return { ok: true, columns: Object.keys(columnIndex), rows };
}

// A text cell that starts with a formula character is read as a formula when someone later opens
// an export in Excel or Sheets. "=", "@", tabs and leading white space are always removed. A leading
// "+" or "-" is kept only when the rest is plain words and numbers ("-20% Sale Tee"); with a bracket,
// "|", "!" or similar after it, it could be a formula such as -2+3+cmd|'/C calc'!A0, so it is removed.
const PLAIN_SIGNED = /^[+\-][\p{L}\p{N}\s%.,&/+\-]*$/u;
function safeText(v) {
  let text = String(v || '');
  for (;;) {
    text = text.replace(/^[\s=@]+/, '');
    if (/^[+\-]/.test(text) && !PLAIN_SIGNED.test(text)) text = text.slice(1);
    else return text;
  }
}

// "S:5;M:3;L:2" to { S: 5, M: 3, L: 2 } (checked like the admin form). Resolves to { value } or {
// error }.
function parseSizesCell(text) {
  const obj = {};
  for (const part of String(text).split(/[;|,]/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^([^:=]+)[:=]\s*(\d+)$/.exec(part);
    if (!m) return { error: `Sizes "${String(text).slice(0, 40)}": write them like S:5;M:3;L:2.` };
    const name = m[1].trim().toLowerCase();
    if (Object.keys(obj).some((k) => k.toLowerCase() === name)) return { error: `Sizes: "${m[1].trim().slice(0, 20)}" is listed twice.` };
    obj[m[1].trim()] = m[2];
  }
  const checked = cleanSizeStock(obj);
  if (!checked.ok) return { error: `Sizes: ${checked.message}` };
  if (!checked.value) return { error: 'Sizes: list at least one size, like S:5;M:3.' };
  return { value: checked.value };
}

// Returns { values } with the cleaned fields that were filled in, or { error }.
function checkRow(cells) {
  const values = {};

  const title = plainName(safeText(cells.title));   // line breaks inside a title become spaces
  if (title.length < 2) return { error: 'Title is required (at least 2 characters).' };
  if (title.length > 200) return { error: 'Title is longer than 200 characters.' };
  values.title = title;

  if (cells.price !== undefined && cells.price !== '') {
    const price = parsePrice(cells.price);
    if (!price.ok) return { error: `Price "${cells.price.slice(0, 30)}": ${price.message}` };
    values.price = price.value;
  }
  if (cells.stock !== undefined && cells.stock !== '') {
    if (!/^\d+$/.test(cells.stock)) return { error: `Stock "${cells.stock.slice(0, 30)}" is not a whole number.` };
    const stock = Number(cells.stock);
    if (stock > 100000) return { error: 'Stock is above 100,000.' };
    values.stock = stock;
  }
  // Optional stock per size, written like "S:5;M:3;L:2" (also "S=5|M=3"). The total stock becomes
  // their sum.
  if (cells.sizes !== undefined && cells.sizes !== '') {
    const parsed = parseSizesCell(cells.sizes);
    if (parsed.error) return { error: parsed.error };
    values.sizeStock = parsed.value;
    values.stock = sizeStockTotal(parsed.value);
  }
  if (cells.category) {
    const category = canonicalCategory(cells.category);
    if (!category) return { error: `Category "${cells.category.slice(0, 30)}": ${CATEGORY_MESSAGE}` };
    values.category = category;
  }
  if (cells.description) {
    if (cells.description.length > 1000) return { error: 'Description is longer than 1000 characters.' };
    values.description = safeText(cells.description);
  }
  if (cells.imageUrl) {
    if (cells.imageUrl.startsWith('data:')) return { error: 'Image must be an address (http://, https:// or /path), not embedded data.' };
    const image = cleanImageInput(cells.imageUrl);
    if (!image.ok) return { error: image.message };
    if (image.value) values.imageUrl = image.value;
  }
  return { values };
}

// Decides what happens to every row. rows from readProductCsv existingTitles Map of lower-cased
// title to product id already in the store mode 'create' | 'update' | 'upsert' Resolves.
function planImport(rows, existingTitles, mode) {
  const results = [];
  const seen = new Map();   // lower-cased title, mapped to its line in this file

  for (const row of rows) {
    const checked = checkRow(row.cells);
    const title = (row.cells.title || '').slice(0, 200);
    if (checked.error) {
      results.push({ line: row.line, title, action: 'error', message: checked.error });
      continue;
    }
    const key = checked.values.title.toLowerCase();
    if (seen.has(key)) {
      results.push({ line: row.line, title, action: 'error', message: `Same title as line ${seen.get(key)} in this file.` });
      continue;
    }
    seen.set(key, row.line);

    const existingId = existingTitles.get(key);
    if (existingId) {
      if (mode === 'create') {
        results.push({ line: row.line, title, action: 'skip', message: 'Already in the store (create mode adds new products only).' });
        continue;
      }
      const changes = { ...checked.values };
      delete changes.title;   // the title is what matched the product, so it is not changed
      if (Object.keys(changes).length === 0) {
        results.push({ line: row.line, title, action: 'skip', message: 'Nothing to change (all other cells are empty).' });
        continue;
      }
      results.push({ line: row.line, title, action: 'update', id: String(existingId), values: changes });
    } else {
      if (mode === 'update') {
        results.push({ line: row.line, title, action: 'skip', message: 'No product with this title in the store (update mode changes existing products only).' });
        continue;
      }
      if (checked.values.price === undefined) {
        results.push({ line: row.line, title, action: 'error', message: 'Price is required for a new product.' });
        continue;
      }
      if (checked.values.category === undefined) {
        results.push({ line: row.line, title, action: 'error', message: `Category is required for a new product. ${CATEGORY_MESSAGE}` });
        continue;
      }
      results.push({
        line: row.line, title, action: 'create',
        values: { description: '', stock: 0, imageUrl: '', ...checked.values }
      });
    }
  }

  const counts = { create: 0, update: 0, skip: 0, error: 0 };
  results.forEach((r) => { counts[r.action]++; });
  return { results, counts };
}

// A small CSV the admin can download, fill in and upload.
const TEMPLATE_CSV =
  'title,price,stock,category,description,imageUrl\r\n' +
  '"Classic Cotton T-Shirt",799,40,Men,"Soft everyday cotton tee",/img/logo.svg\r\n' +
  '"Floral Summer Dress",2499.50,12,Women,"Light and breezy summer dress",\r\n';

module.exports = { parseSizesCell, safeText, MAX_ROWS, MAX_CSV_CHARS, MODES, parseCsv, readProductCsv, checkRow, planImport, TEMPLATE_CSV };
