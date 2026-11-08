const bcrypt = require('bcrypt');
const { passwordProblem } = require('../services/passwordRules');

const SALT_ROUNDS = 12;
const plainPassword = process.argv[2];

if (!plainPassword) {
  console.error('Usage: node scripts/hash-password.js yourPassword');
  process.exit(1);
}

const weak = passwordProblem(plainPassword);
if (weak) {
  console.error(weak);
  process.exit(1);
}

(async () => {
  const hash = await bcrypt.hash(plainPassword, SALT_ROUNDS);
  console.log('\nPassword hashed successfully.\n');
  console.log('Add this line to your .env file (keep the single quotes):\n');
  console.log(`ADMIN_PASSWORD_HASH='${hash}'`);
  console.log('\nThe single quotes matter: a hash is full of $ signs, and Docker Compose would');
  console.log('otherwise treat them as variables and corrupt the hash. They are harmless');
  console.log('when you run the app without Docker.');
  console.log('\nRemove ADMIN_PASSWORD from .env once you add ADMIN_PASSWORD_HASH.\n');
})();