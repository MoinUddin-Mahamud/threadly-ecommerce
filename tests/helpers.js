// Shared setup for the test suite. No database is needed: sessions use the
// in-memory store (NODE_ENV=test) and the Admin / Role / Product / Order
// models are replaced with small in-memory fakes.
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');

// No database is connected in the tests.
mongoose.set('bufferTimeoutMS', 500);

process.env.NODE_ENV = 'test';
process.env.CURRENCY_CODE = 'XXX';   // ISO code for "no currency": tests never touch a real gateway
// Tests must never use the developer's real mail account from .env: blank values stop dotenv from
// loading them.
for (const key of [
  'EMAIL_HOST', 'EMAIL_PORT', 'EMAIL_USER', 'EMAIL_PASS', 'EMAIL_FROM', 'EMAIL_SECURE',
  // The same goes for payment keys: tests must never reach a real gateway account.
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
  'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_IS_LIVE',
  'FLUTTERWAVE_SECRET_KEY', 'FLUTTERWAVE_WEBHOOK_HASH', 'MOLLIE_API_KEY'
]) process.env[key] = '';
process.env.SESSION_SECRET = 'test-session-secret';
// Tests place many Cash on Delivery orders from one address; the real default (5 an hour) would stop them.
process.env.COD_ORDER_RATE_LIMIT_MAX = '100';
process.env.ADMIN_USERNAME = 'owner_admin';
// A configured card gateway, so order tests reach the gateway code.
process.env.SSLCOMMERZ_STORE_ID = 'test_store';
process.env.SSLCOMMERZ_STORE_PASSWORD = 'test_store_password';
process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync('OwnerPass123', 4);

const Admin = require('../models/Admin');
const Role = require('../models/Role');
const Product = require('../models/Product');
const AdminTwoFactor = require('../models/AdminTwoFactor');
const Order = require('../models/Order');

const clone = (o) => JSON.parse(JSON.stringify(o));

// Does a stored document match a Mongo-style filter? Supports plain equality,
// {$in: [...]} and matching a value inside an array field (e.g. { roles: 'X' }).
function matches(doc, filter) {
  return Object.entries(filter || {}).every(([key, cond]) => {
    const value = doc[key];
    if (cond && typeof cond === 'object' && Array.isArray(cond.$in)) {
      return Array.isArray(value) ? value.some((v) => cond.$in.includes(v)) : cond.$in.includes(value);
    }
    if (Array.isArray(value)) return value.includes(cond);
    return value === cond;
  });
}

let admins = [];
let roles = [];

function applyUpdate(doc, update) {
  Object.assign(doc, (update && update.$set) || {});
  Object.entries((update && update.$pull) || {}).forEach(([k, v]) => {
    if (Array.isArray(doc[k])) doc[k] = doc[k].filter((x) => x !== v);
  });
}

Admin.findOne = async (q) => admins.find((d) => matches(d, q)) || null;
Admin.find = async () => admins.slice();
Admin.create = async (data) => {
  if (admins.some((d) => d.username === data.username)) { const e = new Error('dup'); e.code = 11000; throw e; }
  const doc = { createdAt: new Date(), active: true, ...clone(data) };
  admins.push(doc);
  return doc;
};
Admin.updateOne = async (q, update) => { const d = admins.find((x) => matches(x, q)); if (d) applyUpdate(d, update); return {}; };
Admin.updateMany = async (q, update) => { admins.filter((x) => matches(x, q)).forEach((d) => applyUpdate(d, update)); return {}; };
Admin.findOneAndDelete = async (q) => {
  const i = admins.findIndex((d) => matches(d, q));
  return i === -1 ? null : admins.splice(i, 1)[0];
};

Role.find = async (q) => roles.filter((d) => matches(d, q));
Role.findOne = async (q) => roles.find((d) => matches(d, q)) || null;
Role.create = async (data) => { const doc = clone(data); roles.push(doc); return doc; };
Role.updateOne = async (q, update, opts) => {
  const d = roles.find((x) => matches(x, q));
  if (d) applyUpdate(d, update);
  else if (opts && opts.upsert) roles.push(clone((update && update.$setOnInsert) || q));
  return {};
};
Role.deleteOne = async (q) => { roles = roles.filter((d) => !matches(d, q)); return {}; };

// Data endpoints return canned data quickly instead of waiting on a database.
Product.find = () => ({ sort: async () => [{ title: 'Test shirt' }] });
// The admin product list reads the database through an aggregation (no pictures in memory).
Product.aggregate = async () => [{ title: 'Test shirt' }];
Product.findByIdAndDelete = async () => ({ title: 'Test shirt' });
// Deleting a staff account also removes its two-factor record.
AdminTwoFactor.deleteOne = async () => ({ deletedCount: 0 });
Order.find = () => ({ sort: () => ({ skip: () => ({ limit: async () => [] }) }) });
Order.countDocuments = async () => 0;
Order.findById = async () => ({ _id: '64b7f0c2a1b2c3d4e5f60718', customerName: 'Test' });

const AuditLog = require('../models/AuditLog');
AuditLog.create = async () => ({});
AuditLog.find = () => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => [] }) }) }) });
AuditLog.countDocuments = async () => 0;

function resetData() {
  roles = [];
  admins = [{
    username: 'helper', role: 'staff', active: true, createdAt: new Date(),
    passwordHash: bcrypt.hashSync('StaffPass123', 4)   // legacy account: no `roles` field
  }];
}
resetData();

async function addAccount(username, password, roleNames) {
  return Admin.create({ username, passwordHash: bcrypt.hashSync(password, 4), roles: roleNames, role: 'staff' });
}

const { app, server } = require('../server');

module.exports = {
  app, server, resetData, addAccount,
  OWNER: { username: 'owner_admin', password: 'OwnerPass123' },
  STAFF: { username: 'helper', password: 'StaffPass123' }
};
