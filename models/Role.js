const mongoose = require('mongoose');

// A named set of permissions ("product.edit", "order.view", ...) that can be
// assigned to admin accounts. "Admin" and "Staff" are built-in (isSystem) and
// cannot be deleted; "Admin" always has full access.
const roleSchema = new mongoose.Schema(
  {
    name:        { type: String, required: true, unique: true, trim: true },
    isSystem:    { type: Boolean, default: false },
    permissions: { type: [String], default: [] }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Role', roleSchema);
