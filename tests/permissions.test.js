const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ALL_PERMISSIONS, SUPER_ROLE, DEFAULT_ROLES, isValidPermission, effectiveRoleNames, resolveAccess
} = require('../services/permissions');

test('the permission catalog only lists actions that exist in the app', () => {
  assert.ok(ALL_PERMISSIONS.includes('product.delete'));
  assert.ok(ALL_PERMISSIONS.includes('order.details'));
  // Orders are made by customers and never deleted; products have no separate details page
  assert.ok(!ALL_PERMISSIONS.includes('order.create'));
  assert.ok(!ALL_PERMISSIONS.includes('order.delete'));
  assert.ok(!ALL_PERMISSIONS.includes('product.details'));
  assert.equal(isValidPermission('product.edit'), true);
  assert.equal(isValidPermission('order.delete'), false);
  assert.equal(isValidPermission('nonsense'), false);
  assert.equal(isValidPermission(42), false);
});

test('legacy accounts map to the matching role names', () => {
  assert.deepEqual(effectiveRoleNames({ role: 'owner' }), [SUPER_ROLE]);
  assert.deepEqual(effectiveRoleNames({ role: 'staff' }), ['Staff']);
  assert.deepEqual(effectiveRoleNames({ role: 'staff', roles: ['A', 'B'] }), ['A', 'B']);
  assert.deepEqual(effectiveRoleNames({ role: 'owner', roles: [] }), []); // explicit "no roles" wins
});

test('the Admin role gets every permission', () => {
  const access = resolveAccess([SUPER_ROLE], []);
  assert.equal(access.isSuper, true);
  assert.equal(access.permissions.size, ALL_PERMISSIONS.length);
});

test('the built-in Staff role works even before it exists in the database', () => {
  const { isSuper, permissions } = resolveAccess(['Staff'], []);
  assert.equal(isSuper, false);
  assert.ok(permissions.has('product.edit'));
  assert.ok(permissions.has('order.edit'));
  assert.ok(!permissions.has('product.delete'));
});

test('a saved role in the database overrides the built-in defaults', () => {
  const { permissions } = resolveAccess(['Staff'], [{ name: 'Staff', permissions: ['order.view'] }]);
  assert.deepEqual(Array.from(permissions), ['order.view']);
});

test('permissions from several roles are combined', () => {
  const docs = [
    { name: 'Viewer', permissions: ['product.view'] },
    { name: 'Packer', permissions: ['order.view', 'order.edit'] }
  ];
  const { permissions } = resolveAccess(['Viewer', 'Packer'], docs);
  assert.deepEqual(Array.from(permissions).sort(), ['order.edit', 'order.view', 'product.view']);
});

test('deleted roles and invalid permission strings grant nothing', () => {
  const docs = [{ name: 'Odd', permissions: ['product.view', 'order.delete', 'hack.everything'] }];
  const { permissions } = resolveAccess(['Odd', 'GhostRole'], docs);
  assert.deepEqual(Array.from(permissions), ['product.view']);
});

test('default role definitions are valid', () => {
  assert.ok(DEFAULT_ROLES.Staff.permissions.every(isValidPermission));
  assert.deepEqual(DEFAULT_ROLES.Admin.permissions, ALL_PERMISSIONS);
});
