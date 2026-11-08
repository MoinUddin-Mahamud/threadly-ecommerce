// A small in-memory fake for the database, shared by the marketplace and review-fix tests.
// It understands just the query shapes the app uses ($in, $ne, $nin, $lt, $gt, $elemMatch,
// dotted paths into arrays, sort / skip / limit) so tests exercise the real route and service code.
const Vendor = require('../models/Vendor');
const Product = require('../models/Product');
const Order = require('../models/Order');
const User = require('../models/User');
const Payout = require('../models/Payout');
const AdminTwoFactor = require('../models/AdminTwoFactor');

const quiet = [console, 'error', () => {}];

async function withStubs(stubs, fn) {
  const saved = stubs.map(([t, n]) => [t, n, t[n]]);
  stubs.forEach(([t, n, impl]) => { t[n] = impl; });
  try { await fn(); } finally { saved.forEach(([t, n, o]) => { t[n] = o; }); }
}
async function withEnv(vars, fn) {
  const saved = Object.keys(vars).map((k) => [k, process.env[k]]);
  Object.entries(vars).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  try { await fn(); } finally { saved.forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; }); }
}

let counter = 0;
const oid = () => (++counter).toString(16).padStart(24, '0');
const get = (d, path) => path.split('.').reduce((a, k) => (Array.isArray(a) ? a.flatMap((x) => (x ? x[k] : undefined)) : (a == null ? undefined : a[k])), d);
function matches(doc, f) {
  return Object.entries(f || {}).every(([k, c]) => {
    const raw = get(doc, k);
    const vals = Array.isArray(raw) ? raw : [raw];
    if (c && typeof c === 'object' && !Array.isArray(c) && !(c instanceof Date)) {
      if ('$in' in c) return vals.some((x) => c.$in.map(String).includes(String(x)));
      if ('$ne' in c) return c.$ne === null ? vals.some((x) => x != null) : !vals.some((x) => String(x) === String(c.$ne));
      if ('$nin' in c) return !vals.some((x) => c.$nin.includes(x));
      if ('$lt' in c) return vals.some((x) => String(x) < String(c.$lt));
      if ('$gt' in c) return vals.some((x) => String(x) > String(c.$gt));
      if ('$elemMatch' in c) return (Array.isArray(doc[k]) ? doc[k] : []).some((e) => matches(e, c.$elemMatch));
    }
    if (c === null) return vals.every((x) => x == null);
    return vals.some((x) => String(x) === String(c));
  });
}
const wrap = (o) => Object.defineProperty(o, 'toObject', { value() { const { ...c } = o; return c; }, enumerable: false });
const cmp = (x, y) => {
  const u = x instanceof Date ? x.getTime() : x; const v = y instanceof Date ? y.getTime() : y;
  return typeof u === 'number' && typeof v === 'number' ? u - v : (String(u) < String(v) ? -1 : String(u) > String(v) ? 1 : 0);
};
function chain(rows) {
  let list = rows;
  const c = {
    select: () => c, lean: () => c,
    sort: (spec) => { const [k, dir] = Object.entries(spec || {})[0] || []; if (k && Array.isArray(list)) list = [...list].sort((p, q) => cmp(get(p, k), get(q, k)) * (dir < 0 ? -1 : 1)); return c; },
    skip: (n) => { if (Array.isArray(list)) list = list.slice(n); return c; },
    limit: (n) => { if (Array.isArray(list)) list = list.slice(0, n); return c; },
    then: (res, rej) => Promise.resolve(list).then(res, rej)
  };
  return c;
}
function newWorld() { return { users: [], vendors: [], products: [], orders: [], payouts: [], lastPipeline: null }; }
function stubsFor(w) {
  const table = (rows) => ({
    find: (f) => chain(rows.filter((d) => matches(d, f))),
    findOne: (f) => chain(rows.find((d) => matches(d, f)) || null),
    findById: (id) => chain(rows.find((d) => String(d._id) === String(id)) || null),
    exists: async (f) => (rows.find((d) => matches(d, f)) ? { _id: 1 } : null),
    countDocuments: async (f) => rows.filter((d) => matches(d, f)).length
  });
  const upd = (rows) => async (f, u) => {
    const d = rows.find((x) => matches(x, f)); if (!d) return { modifiedCount: 0 };
    Object.entries((u && u.$set) || {}).forEach(([k, v]) => {
      const m = k.match(/^(\w+)\.\$\.(\w+)$/);
      if (m) { const el = d[m[1]].find((e) => matches(e, f[m[1]].$elemMatch)); if (el) el[m[2]] = v; } else d[k] = v;
    });
    return { modifiedCount: 1 };
  };
  const V = table(w.vendors), P = table(w.products), O = table(w.orders), U = table(w.users), Y = table(w.payouts);
  return [
    quiet,
    [console, 'log', () => {}],
    [Vendor, 'find', V.find], [Vendor, 'findOne', V.findOne], [Vendor, 'findById', V.findById], [Vendor, 'exists', V.exists],
    [Vendor, 'create', async (d) => {
      if (w.vendors.some((v) => v.slug === d.slug)) throw Object.assign(new Error('dup'), { code: 11000 });
      const v = wrap({ _id: oid(), createdAt: new Date(), approvedAt: null, description: '', phone: '', ...d }); w.vendors.push(v); return v;
    }],
    [Vendor, 'updateOne', upd(w.vendors)],
    [Vendor, 'deleteOne', async (f) => { const i = w.vendors.findIndex((d) => matches(d, f)); if (i > -1) w.vendors.splice(i, 1); return {}; }],
    [User, 'findOne', async () => null],
    [User, 'create', async (d) => { const u = wrap({ _id: oid(), vendorId: null, wishlist: [], ...d }); w.users.push(u); return u; }],
    [User, 'find', U.find], [User, 'findById', U.findById], [User, 'updateOne', upd(w.users)],
    [Product, 'aggregate', async (pipeline) => {
      w.lastPipeline = pipeline;
      let rows = [...w.products];
      for (const st of pipeline) {
        if (st.$match !== undefined) rows = rows.filter((r) => matches(r, st.$match));
        else if (st.$skip !== undefined) rows = rows.slice(st.$skip);
        else if (st.$limit !== undefined) rows = rows.slice(0, st.$limit);
        else if (st.$addFields && st.$addFields.imageUrl) rows = rows.map((r) => ({ ...r, imageUrl: String(r.imageUrl || '').startsWith('data:image/') ? 'data:image/uploaded' : r.imageUrl }));
      }
      return rows.map((r) => ({ ...r }));
    }],
    [Product, 'find', P.find], [Product, 'findOne', P.findOne], [Product, 'findById', P.findById], [Product, 'countDocuments', P.countDocuments],
    [Product, 'create', async (d) => { const p = wrap({ _id: oid(), createdAt: new Date(), updatedAt: new Date(), ...d }); w.products.push(p); return p; }],
    [Product, 'findOneAndUpdate', async (f, data) => { const p = w.products.find((d) => matches(d, f)); if (!p) return null; Object.assign(p, data); return p; }],
    [Product, 'findOneAndDelete', async (f) => { const i = w.products.findIndex((d) => matches(d, f)); return i > -1 ? w.products.splice(i, 1)[0] : null; }],
    [Order, 'find', O.find], [Order, 'findOne', O.findOne], [Order, 'findById', O.findById], [Order, 'countDocuments', O.countDocuments], [Order, 'updateOne', upd(w.orders)],
    [Order, 'findOneAndUpdate', async (f, u) => {
      const o = w.orders.find((d) => matches(d, f)); if (!o) return null;
      Object.entries((u && u.$set) || {}).forEach(([k, v]) => { const m = k.match(/^(\w+)\.\$\.(\w+)$/); if (m) { const el = o[m[1]].find((e) => matches(e, f[m[1]].$elemMatch)); if (el) el[m[2]] = v; } else o[k] = v; });
      Object.keys((u && u.$unset) || {}).forEach((k) => { delete o[k]; });
      return o;
    }],
    [Payout, 'find', Y.find],
    [Payout, 'create', async (d) => {
      if (d.lineKeys.some((k) => w.payouts.some((p) => p.lineKeys.includes(k)))) throw Object.assign(new Error('dup'), { code: 11000 });
      const p = wrap({ _id: oid(), createdAt: new Date(), ...d }); w.payouts.push(p); return p;
    }]
  ];
}

const seedVendor = (w, over = {}) => { const v = wrap({ _id: oid(), name: 'Urban Loom', slug: 'urban-loom', status: 'approved', commissionPercent: 10, description: '', phone: '', ownerUserId: null, approvedAt: new Date(), createdAt: new Date(), ...over }); w.vendors.push(v); return v; };
const seedProduct = (w, vendor, over = {}) => { const p = wrap({ _id: oid(), title: 'Tee', price: 500, stock: 10, category: 'Men', imageUrl: '', vendorId: vendor ? vendor._id : null, createdAt: new Date(), updatedAt: new Date(), ...over }); w.products.push(p); return p; };
// In-memory fake for the two-factor collection (atomic $inc, $or, conditional updates).
function fakeTwoFactorStore() {
  const docs = [];
  const match = (d, f) => Object.entries(f).every(([k, c]) => {
    if (k === '$or') return c.some((alt) => match(d, alt));
    if (c && typeof c === 'object' && !(c instanceof Date) && !Array.isArray(c)) {
      if ('$lt' in c) return d[k] < c.$lt;
      if ('$lte' in c) return d[k] <= c.$lte;
      if ('$gt' in c) return d[k] > c.$gt;
    }
    if (c === null) return d[k] === null || d[k] === undefined;
    if (Array.isArray(d[k])) return d[k].includes(c);
    return d[k] === c;
  });
  const apply = (d, u) => {
    Object.assign(d, (u && u.$set) || {});
    Object.entries((u && u.$inc) || {}).forEach(([k, v]) => { d[k] = (d[k] || 0) + v; });   // atomic: no await between read and write
    Object.entries((u && u.$pull) || {}).forEach(([k, v]) => { d[k] = d[k].filter((x) => x !== v); });
  };
  const fake = [
    [AdminTwoFactor, 'findOne', async (f) => docs.find((d) => match(d, f)) || null],
    [AdminTwoFactor, 'findOneAndUpdate', async (f, u) => { const d = docs.find((x) => match(x, f)); if (!d) return null; apply(d, u); return { ...d, backupCodeHashes: [...(d.backupCodeHashes || [])] }; }],   // a snapshot, like the real database
    [AdminTwoFactor, 'updateOne', async (f, u, opts) => {
      let d = docs.find((x) => match(x, f));
      if (!d && opts && opts.upsert) { d = { _id: `tf${docs.length}`, key: f.key, enabled: false, lastStep: 0, backupCodeHashes: [], failedAttempts: 0, lockedUntil: null }; docs.push(d); }
      if (!d) return { modifiedCount: 0 };
      apply(d, u);
      return { modifiedCount: 1 };
    }],
    [AdminTwoFactor, 'deleteOne', async (f) => { const i = docs.findIndex((d) => match(d, f)); if (i !== -1) docs.splice(i, 1); return {}; }]
  ];
  fake.docs = docs;
  return fake;
}


module.exports = { quiet, withStubs, withEnv, oid, get, matches, wrap, chain, newWorld, stubsFor, seedVendor, seedProduct, fakeTwoFactorStore };
