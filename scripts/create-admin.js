// Create (or reset the password of) an extra admin account.
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const Admin = require('../models/Admin');
const Role = require('../models/Role');
const { SUPER_ROLE, DEFAULT_ROLES } = require('../services/permissions');
const { passwordProblem } = require('../services/passwordRules');

async function main() {
  const [rawUser, rawPassword, rawRole] = process.argv.slice(2);
  const password = rawPassword === '-' ? process.env.CREATE_ADMIN_PASSWORD : rawPassword;
  const username = String(rawUser || '').trim().toLowerCase();

  let roleName = 'Staff';
  if (rawRole === 'owner') roleName = SUPER_ROLE;
  else if (rawRole === 'staff' || !rawRole) roleName = 'Staff';
  else roleName = String(rawRole).trim();

  const weak = passwordProblem(password);
  if (!/^[a-z0-9._-]{3,32}$/.test(username) || weak) {
    console.error('Usage: node scripts/create-admin.js <username> <password> [owner|staff|<role name>]');
    console.error('Username: 3-32 chars (letters, numbers, . _ -). Password: 8+ characters, at most 72 bytes.');
    if (weak) console.error(weak);
    process.exit(1);
  }
  if (process.env.ADMIN_USERNAME && username === process.env.ADMIN_USERNAME.toLowerCase()) {
    console.error('That username is reserved for the admin defined in .env.');
    process.exit(1);
  }
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is missing in .env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.DB_NAME || 'ecommerce' });

  if (!DEFAULT_ROLES[roleName] && !(await Role.findOne({ name: roleName }))) {
    console.error(`Role "${roleName}" does not exist. Create it in the admin panel first (Roles & Access), or use owner / staff.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await Admin.findOneAndUpdate(
    { username },
    { username, passwordHash, roles: [roleName], role: roleName === SUPER_ROLE ? 'owner' : 'staff', active: true },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );
  console.log(`Admin "${username}" saved with role "${roleName}".`);
  await mongoose.disconnect();
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
