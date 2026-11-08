require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const Product = require('../models/Product');
const Vendor = require('../models/Vendor');
const Order = require('../models/Order');
const Payout = require('../models/Payout');
const { VENDORS, PRODUCTS } = require('./catalog');

const uri = process.env.MONGODB_URI;
const dbName = process.env.DB_NAME || 'ecommerce';

// Only adds demo shops and products that are missing; existing data is left alone. `npm run seed` does that. `npm run seed -- --reset --yes`
// first deletes the store's own products and the demo shops' products, then seeds them again.
const args = process.argv.slice(2);
const reset = args.includes('--reset');
const confirmed = args.includes('--yes');
const withShops = !args.includes('--no-shops');   // --no-shops: only the store's own products

(async () => {
  try {
    if (reset && !confirmed) {
      console.error("--reset deletes the store's own products and the demo shops' products (real sellers' products are kept). Add --yes to confirm:");
      console.error('  npm run seed -- --reset --yes');
      process.exit(1);
    }
    await mongoose.connect(uri, { dbName });
    console.log(`Connected to "${dbName}". Seeding...`);

    // Shops first, so each product can point at its shop.
    const shopIds = {};
    let shopsAdded = 0;
    async function ensureShops() {
      for (const v of VENDORS) {
        let doc = await Vendor.findOne({ slug: v.slug });
        if (!doc) {
          doc = await Vendor.create({ ...v, status: 'approved', approvedAt: new Date() });
          shopsAdded++;
        }
        shopIds[v.slug] = doc._id;
      }
    }
    if (withShops) await ensureShops();
    const catalog = PRODUCTS.filter((p) => !p.vendor || withShops);
    const key = (title, vendorId) => `${title}\u0000${vendorId ? String(vendorId) : ''}`;

    let toInsert = catalog;
    if (reset) {
      // Only the store's own products and the demo shops' products go. A real seller's shop and
      // products stay.
      const demoSlugs = VENDORS.map((v) => v.slug);
      const demoShops = await Vendor.find({ slug: { $in: demoSlugs }, ownerUserId: null }).select('_id').lean();
      const demoIds = demoShops.map((v) => v._id);
      const { deletedCount } = await Product.deleteMany({ $or: [{ vendorId: null }, { vendorId: { $in: demoIds } }] });
      console.log(`Reset: ${deletedCount} product(s) deleted (the store's own and the demo shops'). Sellers' products were left alone.`);
      if (demoIds.length) {
        // A demo shop that orders or payouts already point at is KEPT (its sales and earnings
        // records need it); deleting it would leave those money records pointing at nothing.
        const deletable = [];
        for (const id of demoIds) {
          const used = (await Order.exists({ 'items.vendorId': id })) || (await Payout.exists({ vendorId: id }));
          if (!used) deletable.push(id);
        }
        const gone = await Vendor.deleteMany({ _id: { $in: deletable } });
        console.log(`Reset: ${gone.deletedCount} demo shop(s) deleted, ${demoIds.length - deletable.length} kept because orders or payouts refer to them.`);
        for (const slug of Object.keys(shopIds)) delete shopIds[slug];
        if (withShops) await ensureShops();
      }
    } else {
      // Same title in the same shop (or both the store's own) counts as already present.
      const existing = new Set((await Product.find({}, 'title vendorId').lean()).map((p) => key(p.title, p.vendorId)));
      toInsert = catalog.filter((p) => !existing.has(key(p.title, p.vendor ? shopIds[p.vendor] : null)));
      console.log(`${catalog.length - toInsert.length} demo product(s) already present, left untouched.`);
    }
    if (toInsert.length) {
      // Demo stock is kept per size (accessories have one size), so the size feature is visible
      // straight away. The total `stock` stays the sum of the sizes.
      const demoSizes = (p, i) => {
        if (p.category === 'Accessories') return { OneSize: p.stock };
        const keys = ['S', 'M', 'L', 'XL'];
        const out = {}; let left = p.stock;
        keys.forEach((k, n) => { const part = n === keys.length - 1 ? left : Math.floor(p.stock / keys.length); out[k] = part; left -= part; });
        if (i % 7 === 3 && p.stock >= 8) { out.XL += out.S; out.S = 0; }   // S sold out, same total
        return out;
      };
      await Product.insertMany(toInsert.map((p, i) => ({
        title: p.title, description: p.description, price: p.price,
        imageUrl: `/img/products/${p.slug}.svg`, stock: p.stock, sizeStock: demoSizes(p, i), category: p.category,
        vendorId: p.vendor ? shopIds[p.vendor] : null
      })));
    }
    console.log(`Seeding complete. ${shopsAdded} shop(s) and ${toInsert.length} product(s) added.`);
    for (const c of ['Men', 'Women', 'Kids', 'Accessories']) console.log(`- ${c}: ${catalog.filter((p) => p.category === c).length} products`);
    if (withShops) {
      console.log('Turn the marketplace on with MULTIVENDOR_ENABLED=true in .env, then restart.');
      console.log('WARNING: the demo shops are APPROVED and have no owner. On a live marketplace delete or suspend them in the admin panel');
      console.log('(Vendors), or run the seed with --no-shops, so nobody earns commission or gets paid out for demo products.');
    }
    process.exit(0);
  } catch (err) {
    console.error('Seeding failed:', err.message);
    process.exit(1);
  }
})();
