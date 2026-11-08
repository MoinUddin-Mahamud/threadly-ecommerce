// Checks SESSION_SECRET. Sessions (and the admin login) are only as safe as
// this value, so in production the server refuses to start with a missing,
// short, predictable or copied-from-the-example secret.

const MIN_LENGTH = 32;

// The placeholder in .env.example, the built-in development fallback in
// server.js, and the usual "change me" style values.
const PLACEHOLDER = /^(replace|change)[-_ ]?(this|me)|change[-_ ]?in[-_ ]?production|^your[-_ ](secret|key)/i;

// Returns a short description of what is wrong with the secret, or null if it is fine.
function sessionSecretProblem(secret) {
  if (typeof secret !== 'string' || secret.trim() === '') return 'is missing';
  const value = secret.trim();
  if (PLACEHOLDER.test(value)) return 'is still the placeholder from .env.example';
  if (value.length < MIN_LENGTH) return `is too short (use at least ${MIN_LENGTH} characters)`;
  if (new Set(value).size < 8) return 'is too predictable (use a long random value)';
  return null;
}

module.exports = { sessionSecretProblem, MIN_LENGTH };
