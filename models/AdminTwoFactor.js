const mongoose = require('mongoose');

// Two-factor login settings for one admin account (see services/twoFactor.js).
// Used only when ADMIN_2FA_ENABLED=true. `key` is "env:<username>" for the admin
// defined in .env and "staff:<username>" for accounts created in the panel.
const adminTwoFactorSchema = new mongoose.Schema(
  {
    key:              { type: String, required: true, unique: true },
    secret:           { type: String, required: true },          // base32 TOTP secret, encrypted (see services/twoFactor.js)
    enabled:          { type: Boolean, default: false },          // false while the setup is not confirmed yet
    lastStep:         { type: Number, default: 0 },               // newest 30-second step already used (replay guard)
    backupCodeHashes: { type: [String], default: [] },            // SHA-256 of the unused backup codes
    failedAttempts:   { type: Number, default: 0 },
    lockedUntil:      { type: Date, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('AdminTwoFactor', adminTwoFactorSchema);
