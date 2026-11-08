'use strict';
const { adminHashProblem, BCRYPT_HASH } = require('../config/envCheck');

// The .env template ships "ADMIN_USERNAME=admin" and a placeholder hash. Those are not a real admin.
const PLACEHOLDER = /^(your[-_ ]|replace[-_ ]|changeme|xxx)/i;
const unquote = (v) => String(v || '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
const present = (v) => String(v || '').trim() !== '';

// absent: nothing set, or still the template text (setup may open).
// valid: a usable username and a clean bcrypt hash (setup closed, the .env admin can log in).
// malformed: something was set but cannot work, e.g. quotes kept around the hash or a hash cut
//   short by Docker Compose. Setup stays closed so a typo never hands the shop to a stranger.
function adminEnvState(env = process.env) {
  const hash = env.ADMIN_PASSWORD_HASH;
  if (!present(hash) || PLACEHOLDER.test(unquote(hash))) return { state: 'absent', problem: null };
  const user = env.ADMIN_USERNAME;
  if (BCRYPT_HASH.test(String(hash).trim()) && present(user) && !PLACEHOLDER.test(String(user).trim())) {
    return { state: 'valid', problem: null };
  }
  if (BCRYPT_HASH.test(String(hash).trim())) {
    return { state: 'malformed', problem: 'is set but ADMIN_USERNAME is empty or still the template value. Set ADMIN_USERNAME to the admin name' };
  }
  return { state: 'malformed', problem: adminHashProblem(String(hash)) };
}

function envAdminConfigured(env = process.env) {
  return adminEnvState(env).state === 'valid';
}

// The one start-up warning for a malformed .env admin, or null when there is nothing to say.
function adminEnvWarning(env = process.env) {
  const { state, problem } = adminEnvState(env);
  if (state !== 'malformed') return null;
  return `ADMIN_PASSWORD_HASH ${problem}. The .env admin cannot log in and /setup stays closed until this is fixed. Admins created in the database can still log in.`;
}

module.exports = { adminEnvState, envAdminConfigured, adminEnvWarning };
