'use strict';

// Moves product pictures that are stored inside the database into picture files in UPLOAD_DIR.

require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const Product = require('../models/Product');
const { parseDataUri } = require('../services/images');
const { storageMode, uploadDir, ensureUploadDir, storeImageValue, UPLOAD_URL } = require('../services/uploads');

const apply = process.argv.includes('--apply');

(async () => {
  try {
    if (storageMode() !== 'disk') throw new Error('UPLOAD_STORAGE is "database": there is nothing to move to. Remove it or set UPLOAD_STORAGE=disk first.');
    if (apply && !ensureUploadDir()) throw new Error(`The folder ${uploadDir()} cannot be written to.`);
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is missing in .env');
    await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.DB_NAME || 'ecommerce' });
    const ids = await Product.find({ imageUrl: /^data:image\// }).select('_id').lean();
    console.log(`${ids.length} product(s) keep their picture inside the database.`);
    let moved = 0, skipped = 0;
    for (const { _id } of ids) {
      const p = await Product.findById(_id).select('title imageUrl').lean();   // one at a time: pictures are large
      if (!p || !parseDataUri(p.imageUrl)) { skipped += 1; console.log(`- "${p && p.title}": not a valid picture, left as it is.`); continue; }
      if (!apply) { moved += 1; console.log(`- "${p.title}": would be moved to a file.`); continue; }
      const url = await storeImageValue(p.imageUrl);
      if (!UPLOAD_URL.test(url)) { skipped += 1; console.log(`- "${p.title}": could not be written, left as it is.`); continue; }
      // Only change the product if it still has the same picture (it may have been edited meanwhile).
      const res = await Product.updateOne({ _id, imageUrl: p.imageUrl }, { $set: { imageUrl: url } });
      if (res.modifiedCount === 1) { moved += 1; console.log(`- "${p.title}": moved to ${url}`); } else { skipped += 1; console.log(`- "${p.title}": changed meanwhile, left as it is.`); }
    }
    console.log(apply ? `Done: ${moved} moved, ${skipped} left as they were.` : `Nothing was changed. Run again with --apply to move ${moved} picture(s).`);
    await mongoose.disconnect();
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
})();
