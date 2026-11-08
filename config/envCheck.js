// Start-up checks for settings that are easy to get subtly wrong.

// A bcrypt hash is exactly 60 characters: $2b$ + 2-digit cost + $ + 53 characters.
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

// Returns what is wrong with ADMIN_PASSWORD_HASH, or null when it looks fine.
// The usual cause of a mangled hash is Docker Compose, which treats the $ signs
// in an unquoted .env value as variable references and silently drops text.
function adminHashProblem(hash) {
  if (typeof hash !== 'string' || hash.trim() === '') return 'is missing';
  // Docker Compose and .env files remove the quotes around a value; hosting
  // dashboards and `docker run --env-file` keep them as part of the value.
  const unquoted = hash.trim().replace(/^(['"])(.*)\1$/, '$2');
  if (unquoted !== hash.trim() && BCRYPT_HASH.test(unquoted)) {
    return (
      'has quote characters around it, and this environment keeps them as part of the value. ' +
      'Paste the hash without the surrounding quotes (the quotes are only for .env files read by Docker Compose)'
    );
  }
  if (!BCRYPT_HASH.test(hash.trim())) {
    return (
      'does not look like a bcrypt hash (it should start with $2b$12$ and be 60 characters long). ' +
      "If you run the app with Docker, wrap the value in single quotes in .env so the $ signs are kept: ADMIN_PASSWORD_HASH='$2b$...'. " +
      'Create a fresh one with: node scripts/hash-password.js "YourPassword"'
    );
  }
  return null;
}

module.exports = { adminHashProblem, BCRYPT_HASH };
