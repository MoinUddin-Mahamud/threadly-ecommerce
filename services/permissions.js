const ACTIONS = ['view', 'details', 'create', 'edit', 'delete'];

const RESOURCES = [
  {
    key: 'product',
    name: 'Product',
    description: 'Products and stock',
    // view = product list, edit = edit details / quick price+stock save
    actions: { view: true, details: false, create: true, edit: true, delete: true }
  },
  {
    key: 'order',
    name: 'Order',
    description: 'Customer orders',
    // details = open a single order / invoice, edit = change order status.
    // Orders are created by customers at checkout and are never deleted here.
    actions: { view: true, details: true, create: false, edit: true, delete: false }
  },
  {
    key: 'coupon',
    name: 'Coupon',
    description: 'Discount codes',
    // view = coupon list, create = new coupons, edit = change a coupon and
    // switch it on or off, delete = remove a coupon
    actions: { view: true, details: false, create: true, edit: true, delete: true }
  },
  {
    key: 'audit',
    name: 'Audit Log',
    description: 'Audit log entries',
    actions: { view: true, details: false, create: false, edit: false, delete: false }
  },
  {
    key: 'vendor',
    name: 'Vendor',
    description: 'Marketplace sellers, commissions and payouts',
    // view = vendor list and earnings, edit = approve / suspend, set the commission, record payouts
    actions: { view: true, details: false, create: false, edit: true, delete: false }
  }
];

const ALL_PERMISSIONS = RESOURCES.flatMap((r) =>
  ACTIONS.filter((a) => r.actions[a]).map((a) => `${r.key}.${a}`)
);

function isValidPermission(p) {
  return typeof p === 'string' && ALL_PERMISSIONS.includes(p);
}

// Full access; the only role that can manage roles and admin accounts.
const SUPER_ROLE = 'Admin';

const DEFAULT_ROLES = {
  Admin: { permissions: ALL_PERMISSIONS },
  Staff: {
    permissions: ['product.view', 'product.create', 'product.edit', 'order.view', 'order.details', 'order.edit', 'coupon.view', 'audit.view']
  }
};


// Accounts created before custom roles existed only have a legacy
// role: 'owner' | 'staff'. Map that to the equivalent role names.
function effectiveRoleNames(account) {
  if (account && Array.isArray(account.roles)) return account.roles.slice();
  return account && account.role === 'owner' ? [SUPER_ROLE] : ['Staff'];
}

// roleNames: the names on the account. roleDocs: matching Role documents from
// the database (may be missing built-ins, which then fall back to the defaults
// above). Names with no definition (e.g. a deleted role) grant nothing.
function resolveAccess(roleNames, roleDocs) {
  const docs = roleDocs || [];
  const permissions = new Set();
  let isSuper = false;

  for (const name of roleNames || []) {
    if (name === SUPER_ROLE) { isSuper = true; continue; }
    const doc = docs.find((d) => d.name === name);
    const list = doc
      ? Array.from(doc.permissions || [])
      : (DEFAULT_ROLES[name] ? DEFAULT_ROLES[name].permissions : null);
    if (!list) continue;
    list.forEach((p) => { if (isValidPermission(p)) permissions.add(p); });
  }

  if (isSuper) ALL_PERMISSIONS.forEach((p) => permissions.add(p));
  return { isSuper, permissions };
}

module.exports = {
  ACTIONS, RESOURCES, ALL_PERMISSIONS, SUPER_ROLE, DEFAULT_ROLES,
  isValidPermission, effectiveRoleNames, resolveAccess
};
