const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, resetData, OWNER, STAFF } = require('./helpers');

const VALID_ID = '64b7f0c2a1b2c3d4e5f60718';

async function login(account) {
  const agent = request.agent(app);
  const res = await agent.post('/admin/login').send(account);
  assert.equal(res.status, 200, `login should succeed for ${account.username}`);
  return { agent, csrf: res.body.csrfToken };
}
const owner = () => login(OWNER);

// helpers for owner actions
const post = (o, url, body) => o.agent.post(url).set('X-CSRF-Token', o.csrf).send(body);
const put = (o, url, body) => o.agent.put(url).set('X-CSRF-Token', o.csrf).send(body);
const del = (o, url) => o.agent.delete(url).set('X-CSRF-Token', o.csrf);

// Creates a role with the given permissions and an account that has only that role.
async function makeUserWithRole(o, roleName, permissions, username, password = 'UserPass1234') {
  assert.equal((await post(o, '/admin/roles', { name: roleName })).status, 201);
  assert.equal((await put(o, `/admin/roles/${encodeURIComponent(roleName)}/permissions`, { permissions })).status, 200);
  assert.equal((await post(o, '/admin/staff', { username, password, roles: [roleName] })).status, 201);
  return { username, password };
}

test('the permission matrix catalog is served to the Admin', async () => {
  resetData();
  const o = await owner();
  const res = await o.agent.get('/admin/permissions/catalog');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.actions, ['view', 'details', 'create', 'edit', 'delete']);
  assert.deepEqual(res.body.resources.map((r) => r.key), ['product', 'order', 'coupon', 'audit', 'vendor']);
});

test('role list starts with the built-in Admin and Staff roles', async () => {
  resetData();
  const o = await owner();
  const res = await o.agent.get('/admin/roles');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.map((r) => r.name), ['Admin', 'Staff']);
  assert.equal(res.body[0].isSuper, true);
  assert.equal(res.body[0].isSystem, true);
  assert.ok(res.body[1].permissions.includes('product.edit'));
  assert.ok(!res.body[1].permissions.includes('product.delete'));
});

test('creating a role validates the name, blocks duplicates, and needs a CSRF token', async () => {
  resetData();
  const o = await owner();
  assert.equal((await post(o, '/admin/roles', { name: 'Manager' })).status, 201);
  assert.equal((await post(o, '/admin/roles', { name: 'manager' })).status, 400);   // same name, different case
  assert.equal((await post(o, '/admin/roles', { name: 'admin' })).status, 400);     // built-in name
  assert.equal((await post(o, '/admin/roles', { name: '1bad' })).status, 400);
  assert.equal((await post(o, '/admin/roles', { name: '<script>' })).status, 400);
  assert.equal((await o.agent.post('/admin/roles').send({ name: 'NoCsrf' })).status, 403);

  const list = await o.agent.get('/admin/roles');
  const manager = list.body.find((r) => r.name === 'Manager');
  assert.deepEqual(manager.permissions, []);
  assert.equal(manager.isSystem, false);
});

test('saving permissions validates the list and protects the Admin role', async () => {
  resetData();
  const o = await owner();
  await post(o, '/admin/roles', { name: 'Manager' });

  assert.equal((await put(o, '/admin/roles/Manager/permissions', { permissions: ['order.view', 'product.edit', 'order.view'] })).status, 200);
  const saved = (await o.agent.get('/admin/roles')).body.find((r) => r.name === 'Manager');
  assert.deepEqual(saved.permissions.sort(), ['order.view', 'product.edit']);   // duplicate removed

  assert.equal((await put(o, '/admin/roles/Manager/permissions', { permissions: ['order.delete'] })).status, 400);   // not applicable
  assert.equal((await put(o, '/admin/roles/Manager/permissions', { permissions: ['hack.all'] })).status, 400);
  assert.equal((await put(o, '/admin/roles/Manager/permissions', { permissions: 'order.view' })).status, 400);
  assert.equal((await put(o, '/admin/roles/Admin/permissions', { permissions: [] })).status, 400);
  assert.equal((await put(o, '/admin/roles/Ghost/permissions', { permissions: [] })).status, 404);
});

test('a custom role grants exactly the permissions it was given', async () => {
  resetData();
  const o = await owner();
  const user = await makeUserWithRole(o, 'Order Viewer', ['order.view', 'order.details'], 'oscar');
  const u = await login(user);

  const status = await u.agent.get('/admin/auth/status');
  assert.equal(status.body.isSuper, false);
  assert.deepEqual(status.body.permissions.sort(), ['order.details', 'order.view']);

  // allowed
  assert.equal((await u.agent.get('/admin/orders')).status, 200);
  assert.equal((await u.agent.get(`/admin/orders/${VALID_ID}`)).status, 200);
  // everything else is refused
  assert.equal((await u.agent.get('/admin/products')).status, 403);
  const csrf = { 'X-CSRF-Token': u.csrf };
  assert.equal((await u.agent.put(`/admin/orders/${VALID_ID}/status`).set(csrf).send({ status: 'SHIPPED' })).status, 403);
  assert.equal((await u.agent.post('/admin/products').set(csrf).send({ title: 'x', price: 1 })).status, 403);
  assert.equal((await u.agent.put(`/admin/products/${VALID_ID}`).set(csrf).send({ price: 1 })).status, 403);
  assert.equal((await u.agent.delete(`/admin/products/${VALID_ID}`).set(csrf)).status, 403);
  // and cannot manage roles or accounts
  assert.equal((await u.agent.get('/admin/roles')).status, 403);
  assert.equal((await u.agent.get('/admin/staff')).status, 403);
  assert.equal((await u.agent.post('/admin/roles').set(csrf).send({ name: 'Sneaky' })).status, 403);
});

test('changing a role takes effect immediately for people already logged in', async () => {
  resetData();
  const o = await owner();
  const user = await makeUserWithRole(o, 'Order Viewer', ['order.view'], 'oscar');
  const u = await login(user);

  assert.equal((await u.agent.get('/admin/products')).status, 403);
  await put(o, '/admin/roles/Order%20Viewer/permissions', { permissions: ['order.view', 'product.view'] });
  assert.equal((await u.agent.get('/admin/products')).status, 200);
  await put(o, '/admin/roles/Order%20Viewer/permissions', { permissions: ['product.view'] });
  assert.equal((await u.agent.get('/admin/orders')).status, 403);
});

test('adding, listing and removing roles for a user', async () => {
  resetData();
  const o = await owner();
  await post(o, '/admin/roles', { name: 'Packer' });
  await put(o, '/admin/roles/Packer/permissions', { permissions: ['order.view', 'order.edit'] });

  // "helper" is an older account with no roles list: it counts as Staff
  const before = await o.agent.get('/admin/staff/helper/roles');
  assert.deepEqual(before.body.roles, ['Staff']);

  assert.equal((await post(o, '/admin/staff/helper/roles', { role: 'Packer' })).status, 200);
  const after = await o.agent.get('/admin/staff/helper/roles');
  assert.deepEqual(after.body.roles, ['Staff', 'Packer']);
  assert.ok(after.body.permissions.includes('order.edit'));

  assert.equal((await post(o, '/admin/staff/helper/roles', { role: 'Packer' })).status, 400);   // already has it
  assert.equal((await post(o, '/admin/staff/helper/roles', { role: 'Ghost' })).status, 404);
  assert.equal((await post(o, '/admin/staff/nobody/roles', { role: 'Packer' })).status, 404);

  assert.equal((await del(o, '/admin/staff/helper/roles/Packer')).status, 200);
  assert.deepEqual((await o.agent.get('/admin/staff/helper/roles')).body.roles, ['Staff']);
  assert.equal((await del(o, '/admin/staff/helper/roles/Packer')).status, 400);   // no longer has it
});

test('a user with every role removed has no access at all', async () => {
  resetData();
  const o = await owner();
  const helper = await login(STAFF);
  assert.equal((await helper.agent.get('/admin/orders')).status, 200);   // Staff role works

  assert.equal((await del(o, '/admin/staff/helper/roles/Staff')).status, 200);
  assert.equal((await helper.agent.get('/admin/orders')).status, 403);
  assert.equal((await helper.agent.get('/admin/products')).status, 403);
  const status = await helper.agent.get('/admin/auth/status');
  assert.deepEqual(status.body.permissions, []);
});

test('granting the Admin role makes a user a full admin', async () => {
  resetData();
  const o = await owner();
  const helper = await login(STAFF);
  assert.equal((await helper.agent.get('/admin/roles')).status, 403);

  await post(o, '/admin/staff/helper/roles', { role: 'Admin' });
  assert.equal((await helper.agent.get('/admin/roles')).status, 200);
  assert.equal((await helper.agent.delete(`/admin/products/${VALID_ID}`).set('X-CSRF-Token', helper.csrf)).status, 200);   // can now delete products
});

test('removing an account signs them out immediately', async () => {
  resetData();
  const o = await owner();
  const user = await makeUserWithRole(o, 'Order Viewer', ['order.view'], 'oscar');
  const u = await login(user);
  assert.equal((await u.agent.get('/admin/orders')).status, 200);

  assert.equal((await del(o, '/admin/staff/oscar')).status, 200);
  assert.equal((await u.agent.get('/admin/orders')).status, 401);
  assert.equal((await u.agent.get('/admin/auth/status')).body.isAuthenticated, false);
});

test('deleting a role removes it from everyone; built-in roles cannot be deleted', async () => {
  resetData();
  const o = await owner();
  await makeUserWithRole(o, 'Temp', ['order.view'], 'tina');

  assert.equal((await del(o, '/admin/roles/Admin')).status, 400);
  assert.equal((await del(o, '/admin/roles/Staff')).status, 400);
  assert.equal((await del(o, '/admin/roles/Ghost')).status, 404);

  assert.equal((await del(o, '/admin/roles/Temp')).status, 200);
  assert.deepEqual((await o.agent.get('/admin/staff/tina/roles')).body.roles, []);
  const names = (await o.agent.get('/admin/roles')).body.map((r) => r.name);
  assert.ok(!names.includes('Temp'));
});

test('the built-in Staff role can be edited but keeps working as a role', async () => {
  resetData();
  const o = await owner();
  await o.agent.get('/admin/roles');   // makes sure defaults exist
  assert.equal((await put(o, '/admin/roles/Staff/permissions', { permissions: ['order.view'] })).status, 200);

  const helper = await login(STAFF);
  assert.equal((await helper.agent.get('/admin/orders')).status, 200);
  assert.equal((await helper.agent.get('/admin/products')).status, 403);
});

test('creating an account checks that the chosen roles exist', async () => {
  resetData();
  const o = await owner();
  assert.equal((await post(o, '/admin/staff', { username: 'zed', password: 'LongEnough123', roles: ['Ghost'] })).status, 400);
  const ok = await post(o, '/admin/staff', { username: 'zed', password: 'LongEnough123', roles: ['Staff'] });
  assert.equal(ok.status, 201);
  assert.equal((await post(o, '/admin/staff', { username: 'zed', password: 'LongEnough123' })).status, 400);   // duplicate

  const list = await o.agent.get('/admin/staff');
  const zed = list.body.find((a) => a.username === 'zed');
  assert.deepEqual(zed.roles, ['Staff']);
  assert.equal(zed.passwordHash, undefined);   // hashes are never sent to the browser
});

test('Staff accounts cannot reach the role and account screens', async () => {
  resetData();
  const helper = await login(STAFF);
  const csrf = { 'X-CSRF-Token': helper.csrf };
  assert.equal((await helper.agent.get('/admin/roles')).status, 403);
  assert.equal((await helper.agent.get('/admin/permissions/catalog')).status, 403);
  assert.equal((await helper.agent.post('/admin/staff/helper/roles').set(csrf).send({ role: 'Admin' })).status, 403);   // no self-promotion
  assert.equal((await helper.agent.put('/admin/roles/Staff/permissions').set(csrf).send({ permissions: [] })).status, 403);
});

// routes/admin.js reads the .env admin once, so these cases load a copy without a valid .env admin.
function appWithoutEnvAdmin() {
  const saved = { ADMIN_USERNAME: process.env.ADMIN_USERNAME, ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH };
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD_HASH = 'replace-with-output-of-scripts/hash-password.js';
  for (const k of Object.keys(require.cache)) if (/[\\/](routes[\\/]admin|server)\.js$/.test(k)) delete require.cache[k];
  const fresh = require('../server').app;
  return { fresh, restore() { Object.entries(saved).forEach(([k, v]) => { process.env[k] = v; }); } };
}

test('an owner cannot delete their own account', async () => {
  resetData();
  const { addAccount } = require('./helpers');
  await addAccount('boss', 'BossPass1234', ['Admin']);
  await addAccount('boss2', 'BossPass1234', ['Admin']);
  const { fresh, restore } = appWithoutEnvAdmin();
  try {
    const agent = request.agent(fresh);
    const res = await agent.post('/admin/login').send({ username: 'boss', password: 'BossPass1234' });
    assert.equal(res.status, 200);
    const own = await agent.delete('/admin/staff/boss').set('X-CSRF-Token', res.body.csrfToken);
    assert.equal(own.status, 409);
    const other = await agent.delete('/admin/staff/boss2').set('X-CSRF-Token', res.body.csrfToken);
    assert.equal(other.status, 200);
  } finally { restore(); }
});

test('the last Admin role cannot be removed when no .env admin exists', async () => {
  resetData();
  const { addAccount } = require('./helpers');
  await addAccount('boss', 'BossPass1234', ['Admin']);
  const { fresh, restore } = appWithoutEnvAdmin();
  try {
    const agent = request.agent(fresh);
    const res = await agent.post('/admin/login').send({ username: 'boss', password: 'BossPass1234' });
    const removal = await agent.delete('/admin/staff/boss/roles/Admin').set('X-CSRF-Token', res.body.csrfToken);
    assert.equal(removal.status, 409);
    assert.match(removal.body.message, /last owner/);
  } finally { restore(); }
});

test('the Admin role can be removed from one of several owners', async () => {
  resetData();
  const { addAccount } = require('./helpers');
  await addAccount('boss', 'BossPass1234', ['Admin']);
  await addAccount('boss2', 'BossPass1234', ['Admin']);
  const { fresh, restore } = appWithoutEnvAdmin();
  try {
    const agent = request.agent(fresh);
    const res = await agent.post('/admin/login').send({ username: 'boss', password: 'BossPass1234' });
    const removal = await agent.delete('/admin/staff/boss2/roles/Admin').set('X-CSRF-Token', res.body.csrfToken);
    assert.equal(removal.status, 200);
  } finally { restore(); }
});

test('a valid .env admin counts as an owner when the last database owner loses the Admin role', async () => {
  resetData();
  const { addAccount } = require('./helpers');
  await addAccount('boss', 'BossPass1234', ['Admin']);
  const o = await owner();
  const res = await del(o, '/admin/staff/boss/roles/Admin');
  assert.equal(res.status, 200);
});
