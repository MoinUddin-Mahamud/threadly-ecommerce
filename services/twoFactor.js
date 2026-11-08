'use strict';

// Optional two-factor login for admin accounts.

const crypto = require('crypto');
const AdminTwoFactor = require('../models/AdminTwoFactor');
const totp = require('./totp');

const MAX_FAILED = 10;                 // wrong codes in a row before the account is paused
const LOCK_MINUTES = 15;

const featureEnabled = (env = process.env) => String(env.ADMIN_2FA_ENABLED || '').trim().toLowerCase() === 'true';
const keyFor = (source, username) => `${source === 'staff' ? 'staff' : 'env'}:${String(username || '').trim().toLowerCase()}`;

// The confirmed 2FA record for an account, or null when it has none.
async function findActive(key) {
  const doc = await AdminTwoFactor.findOne({ key, enabled: true });
  return doc || null;
}

// The secret is stored as "enc:v1:" + base64(iv, tag, ciphertext). A base32 secret never starts like
// that, so older plaintext secrets are told apart and keep working.
const PREFIX = 'enc:v1:';
const isEncrypted = (stored) => typeof stored === 'string' && stored.startsWith(PREFIX);

// The key comes from TWO_FACTOR_ENCRYPTION_KEY when it is set, otherwise from SESSION_SECRET.
function secretKey() {
  const ikm = String(process.env.TWO_FACTOR_ENCRYPTION_KEY || process.env.SESSION_SECRET || '');
  if (!ikm) throw new Error('TWO_FACTOR_ENCRYPTION_KEY or SESSION_SECRET is needed to protect two-factor secrets.');
  return Buffer.from(crypto.hkdfSync('sha256', ikm, 'threadly-2fa', 'two-factor secret', 32));
}

function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

function decryptSecret(stored) {
  if (!isEncrypted(stored)) return stored;
  const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

const modified = (r) => !!r && (r.modifiedCount || r.nModified || 0) > 0;

// Checks what the admin typed at login. Resolves to { ok: true } or { ok: false, message }.
async function verifyLogin(doc, input) {
  const now = new Date();
  const locked = { ok: false, message: 'Too many wrong codes. Try again in a few minutes.' };

  const value = typeof input === 'string' ? input.trim() : '';
  if (!value) {
    return { ok: false, message: 'Enter the 6-digit code from your authenticator app.' };
  }

  // Take a place. Refused while the account is paused.
  const taken = await AdminTwoFactor.findOneAndUpdate(
    { _id: doc._id, $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
    { $inc: { failedAttempts: 1 } },
    { returnDocument: 'after' }
  );
  if (!taken) return locked;

  if ((taken.failedAttempts || 0) > MAX_FAILED) {
    // Too many tries since the last success: pause the account and start counting again afterwards.
    await AdminTwoFactor.updateOne(
      { _id: doc._id, failedAttempts: { $gt: MAX_FAILED } },
      { $set: { lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60 * 1000), failedAttempts: 0 } }
    );
    return locked;
  }

  let accepted = false;
  // Use the secret and last-used step as they are NOW (the document read before may be stale).
  const fresh = taken;

  let secret;
  try { secret = decryptSecret(fresh.secret); } catch (e) {
    return { ok: false, message: 'The two-factor secret cannot be read. Ask the owner to reset it with scripts/reset-2fa.js.' };
  }

  if (/^\d{3}\s?\d{3}$/.test(value)) {
    const step = totp.verifyTotp(secret, value, { nowMs: now.getTime(), lastStep: fresh.lastStep || 0 });
    if (step !== null) {
      // Conditional update: two requests with the same code cannot both pass.
      accepted = modified(await AdminTwoFactor.updateOne({ _id: doc._id, lastStep: { $lt: step } }, { $set: { lastStep: step } }));
    }
  } else if (totp.isBackupCodeShape(value)) {
    const hash = totp.hashBackupCode(value);
    if ((fresh.backupCodeHashes || []).includes(hash)) {
      accepted = modified(await AdminTwoFactor.updateOne({ _id: doc._id, backupCodeHashes: hash }, { $pull: { backupCodeHashes: hash } }));
    }
  }

  if (accepted) {
    const reset = { failedAttempts: 0, lockedUntil: null };
    if (!isEncrypted(fresh.secret)) reset.secret = encryptSecret(secret);
    await AdminTwoFactor.updateOne({ _id: doc._id }, { $set: reset });
    return { ok: true };
  }
  return { ok: false, message: 'That code is not correct.' };
}

module.exports = { featureEnabled, keyFor, findActive, verifyLogin, encryptSecret, decryptSecret, isEncrypted, MAX_FAILED };
