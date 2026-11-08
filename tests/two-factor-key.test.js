// The two-factor secret key can come from TWO_FACTOR_ENCRYPTION_KEY; without it SESSION_SECRET is used.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret';
const twoFactor = require('../services/twoFactor');

function withKey(value, fn) {
  const saved = process.env.TWO_FACTOR_ENCRYPTION_KEY;
  if (value === undefined) delete process.env.TWO_FACTOR_ENCRYPTION_KEY; else process.env.TWO_FACTOR_ENCRYPTION_KEY = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.TWO_FACTOR_ENCRYPTION_KEY; else process.env.TWO_FACTOR_ENCRYPTION_KEY = saved;
  }
}

test('a secret encrypted with TWO_FACTOR_ENCRYPTION_KEY needs that key to be read', () => {
  const stored = withKey('k'.repeat(32), () => twoFactor.encryptSecret('JBSWY3DPEHPK3PXP'));
  assert.ok(twoFactor.isEncrypted(stored));
  assert.ok(!stored.includes('JBSWY3DPEHPK3PXP'));
  assert.equal(withKey('k'.repeat(32), () => twoFactor.decryptSecret(stored)), 'JBSWY3DPEHPK3PXP');
  assert.throws(() => withKey(undefined, () => twoFactor.decryptSecret(stored)), 'the SESSION_SECRET key is a different one');
});

test('without the extra key the secret follows SESSION_SECRET', () => {
  const stored = withKey(undefined, () => twoFactor.encryptSecret('ABCDEFGH'));
  assert.equal(withKey(undefined, () => twoFactor.decryptSecret(stored)), 'ABCDEFGH');
  assert.equal(twoFactor.decryptSecret('PLAINBASE32'), 'PLAINBASE32', 'an older plain secret is returned as it is');
});
