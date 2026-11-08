'use strict';

// Time-based one-time passwords (RFC 6238) for admin two-factor login. Works with Google
// Authenticator, Microsoft Authenticator, Authy, 1Password...

const crypto = require('crypto');

const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  const clean = String(text || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) throw new Error('Not a valid base32 secret.');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// A fresh 160-bit secret, as base32 text (what the QR code / manual entry carries).
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretBase32, counter) {
  const key = base32Decode(secretBase32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

const stepOf = (nowMs) => Math.floor(nowMs / 1000 / STEP_SECONDS);

function totpAt(secretBase32, nowMs = Date.now()) {
  return hotp(secretBase32, stepOf(nowMs));
}

// Checks a 6-digit code. One step either side of "now" is accepted (phone and server clocks are
// never perfectly equal).
function verifyTotp(secretBase32, token, { nowMs = Date.now(), lastStep = 0, window = 1 } = {}) {
  const code = String(token === undefined || token === null ? '' : token).replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return null;
  const current = stepOf(nowMs);
  let found = null;
  for (let step = current - window; step <= current + window; step++) {
    if (step <= lastStep) continue;
    const expected = hotp(secretBase32, step);
    // Compare every candidate in constant time; keep going so timing does not
    // reveal which step matched.
    const same = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code));
    if (same && found === null) found = step;
  }
  return found;
}

// The address an authenticator app turns into a QR code.
function otpauthUrl(secretBase32, account, issuer) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// Backup codes: for when the phone is lost. Each works once.
// 64 random bits each, shown to the admin once; only a SHA-256 hash is stored.
function normalizeBackupCode(value) {
  return String(value || '').toLowerCase().replace(/[\s-]/g, '');
}
const isBackupCodeShape = (value) => /^[0-9a-f]{16}$/.test(normalizeBackupCode(value));
const hashBackupCode = (value) => crypto.createHash('sha256').update(normalizeBackupCode(value)).digest('hex');

function generateBackupCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const hex = crypto.randomBytes(8).toString('hex');
    codes.push(hex.match(/.{4}/g).join('-'));
  }
  return codes;
}

module.exports = {
  STEP_SECONDS, base32Encode, base32Decode, generateSecret, hotp, totpAt, verifyTotp, otpauthUrl,
  generateBackupCodes, hashBackupCode, isBackupCodeShape, normalizeBackupCode
};
