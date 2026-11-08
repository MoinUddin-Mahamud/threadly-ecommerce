// Turn off two-factor login for an admin who lost both their phone and their backup codes.
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const AdminTwoFactor = require('../models/AdminTwoFactor');
const { keyFor } = require('../services/twoFactor');

async function main() {
  const [rawUser, kind] = process.argv.slice(2);
  const username = String(rawUser || '').trim();
  if (!username) {
    console.error('Usage: node scripts/reset-2fa.js <username> [staff]');
    process.exit(1);
  }
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is missing in .env');
    process.exit(1);
  }
  const key = keyFor(kind === 'staff' ? 'staff' : 'env', username);
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.DB_NAME || 'ecommerce' });
  const result = await AdminTwoFactor.deleteOne({ key });
  console.log(result.deletedCount
    ? `Two-factor login turned off for "${username}". They can log in with just their password.`
    : `No two-factor setup was found for "${username}" (${kind === 'staff' ? 'staff account' : 'the admin from .env'}).`);
  await mongoose.disconnect();
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
