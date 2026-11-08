const mongoose = require('mongoose');

// One document with a fixed _id. Whoever inserts it first may create the owner account.
const setupLockSchema = new mongoose.Schema(
  {
    _id: { type: String },
    createdAt: { type: Date, default: Date.now }
  },
  { versionKey: false }
);

module.exports = mongoose.model('SetupLock', setupLockSchema);
