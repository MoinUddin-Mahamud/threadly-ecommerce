const mongoose = require('mongoose');

// Extra admin accounts. The admin in .env (ADMIN_USERNAME / ADMIN_PASSWORD_HASH) still works and
// is always an owner.
const adminSchema = new mongoose.Schema(
  {
    username:     { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
    // Older field ('owner' | 'staff'). Only used for accounts that
    // have no `roles` array yet; new writes keep it in sync for compatibility.
    role:         { type: String, enum: ['owner', 'staff'], default: 'staff' },
    // Names of assigned roles (see models/Role.js). `undefined` means "legacy
    // account, derive from `role`"; an empty array means "no permissions".
    roles:        { type: [String], default: undefined },
    active:       { type: Boolean, default: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Admin', adminSchema);
