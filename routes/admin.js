const express = require('express');
const sameOrigin = require('../middleware/sameOrigin');
const loginGuard = require('../services/loginGuard');
const { envAdminConfigured, adminEnvState } = require('../services/adminEnv');
const bcrypt = require('bcrypt');
const { passwordProblem } = require('../services/passwordRules');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const Product = require('../models/Product');
const Order = require('../models/Order');
const Admin = require('../models/Admin');
const Role = require('../models/Role');
const Coupon = require('../models/Coupon');
const AuditLog = require('../models/AuditLog');
const { logAudit } = require('../services/auditService');
const { toMinor, fromMinor, minorUnit } = require('../services/money');
const {
  ACTIONS, RESOURCES, ALL_PERMISSIONS, SUPER_ROLE, DEFAULT_ROLES,
  isValidPermission, effectiveRoleNames, resolveAccess
} = require('../services/permissions');
const { sendStatusUpdate } = require('../services/emailService');
const { cancelOrderAndRestock, reopenCancelledOrder } = require('../services/orderService');
const { parsePreviousStock } = require('../services/stock');
const { cleanSizeStock, sizeStockTotal } = require('../services/sizes');
const { planStockChange, applyStockChange, savePictures } = require('../services/productUpdate');
const { canonicalCategory, CATEGORY_MESSAGE } = require('../services/categories');
const { validateCouponInput, couponStatus } = require('../services/coupons');
const { allowedNextStatuses, canTransition } = require('../services/orderStatus');
const Review = require('../models/Review');
const reviewService = require('../services/reviews');
const { cleanImageInput, cleanImageList, publicProduct, listImageStage } = require('../services/images');
const { storageMode, storeImageValue, applyPictures, removeUnusedUploads, picturesOf, storedPictureCount, MAX_PICTURES_PER_VENDOR, UPLOAD_URL } = require('../services/uploads');
const twoFactor = require('../services/twoFactor');
const AdminTwoFactor = require('../models/AdminTwoFactor');
const productRules = require('../services/productRules');
const marketplace = require('../services/marketplace');
const { plainName } = require('../services/plainText');

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

const { REVENUE_FILTER } = marketplace;

const router = express.Router();

// Every admin write must come from this site.
router.use(sameOrigin);

const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;

if (adminEnvState({ ADMIN_USERNAME, ADMIN_PASSWORD_HASH }).state === 'absent') {
  console.warn(
    'No admin is set in .env. Open /setup in a browser to create the owner account, or run:\n' +
    '    node scripts/hash-password.js yourPassword  (then set ADMIN_USERNAME and ADMIN_PASSWORD_HASH)\n' +
    '    npm run create-admin <username> <password> owner'
  );
}

// 5 failed attempts per 15 minutes per IP, then locked out.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true, // Only count failed/errored requests
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts. Try again in 15 minutes.' }
});

// Admin sessions also end after 1 hour of inactivity (rolling).
const ADMIN_IDLE_MS = 60 * 60 * 1000; // 1 hour, refreshed on every authenticated request

function clearAdminSession(req) {
  if (!req.session) return;
  delete req.session.isAdmin;
  delete req.session.username;
  delete req.session.csrfToken;
  delete req.session.adminLastSeen;
  delete req.session.role;
  delete req.session.source;
}

function isAdminSession(req) {
  if (!req.session || !req.session.isAdmin) return false;
  if (Date.now() - (req.session.adminLastSeen || 0) > ADMIN_IDLE_MS) {
    clearAdminSession(req);
    return false;
  }
  req.session.adminLastSeen = Date.now();
  return true;
}

function requireAuth(req, res, next) {
  if (isAdminSession(req)) {
    return next();
  }
  return res.status(401).json({ message: 'Unauthorized. Please login.' });
}

// Works out what the logged-in admin may do.
async function getAccessContext(req) {
  if (req._access) return req._access;
  let ctx;
  if (req.session.source !== 'staff') {
    ctx = { isSuper: true, permissions: new Set(ALL_PERMISSIONS), roles: [SUPER_ROLE] };
  } else {
    const account = await findStaffAccount(req.session.username);
    if (!account) return null;
    const roles = effectiveRoleNames(account);
    const docs = await Role.find({ name: { $in: roles } });
    ctx = { ...resolveAccess(roles, docs), roles };
  }
  req._access = ctx;
  return ctx;
}

function accessDenied(res, status, message) {
  return res.status(status).json({ message });
}

// Guard for a single permission such as 'product.edit'.
function requirePermission(permission) {
  return async (req, res, next) => {
    try {
      const ctx = await getAccessContext(req);
      if (!ctx) { clearAdminSession(req); return accessDenied(res, 401, 'Unauthorized. Please login.'); }
      if (ctx.isSuper || ctx.permissions.has(permission)) return next();
      return accessDenied(res, 403, 'You do not have permission to do this.');
    } catch (err) {
      console.error('Permission check error:', err);
      return accessDenied(res, 500, 'Could not verify permissions.');
    }
  };
}

// Like requirePermission, for an action that either of two permissions allows.
function requireAnyPermission(permissions) {
  return async (req, res, next) => {
    try {
      const ctx = await getAccessContext(req);
      if (!ctx) { clearAdminSession(req); return accessDenied(res, 401, 'Unauthorized. Please login.'); }
      if (ctx.isSuper || permissions.some((p) => ctx.permissions.has(p))) return next();
      return accessDenied(res, 403, 'You do not have permission to do this.');
    } catch (err) {
      console.error('Permission check error:', err);
      return accessDenied(res, 500, 'Could not verify permissions.');
    }
  };
}

// Guard for managing roles and admin accounts: the Admin role only.
async function requireSuper(req, res, next) {
  try {
    const ctx = await getAccessContext(req);
    if (!ctx) { clearAdminSession(req); return accessDenied(res, 401, 'Unauthorized. Please login.'); }
    if (ctx.isSuper) return next();
    return accessDenied(res, 403, 'Only an Admin can do this.');
  } catch (err) {
    console.error('Permission check error:', err);
    return accessDenied(res, 500, 'Could not verify permissions.');
  }
}

// Looks up an extra admin account by username. Returns null if none / on error.
async function findStaffAccount(username) {
  if (typeof username !== 'string' || !username.trim()) return null;
  try {
    return await Admin.findOne({ username: username.trim().toLowerCase(), active: true });
  } catch (err) {
    console.error('Admin lookup error:', err.message);
    return null;
  }
}

// Session-stored token: fetched from /admin/csrf-token after login, sent as X-CSRF-Token on every
// write.

function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Compares the two tokens in constant time. The lengths are checked first because
// crypto.timingSafeEqual throws when they differ.
function csrfTokenMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  if (!csrfTokenMatches(req.headers['x-csrf-token'], req.session.csrfToken)) {
    return res.status(403).json({ message: 'Invalid or missing CSRF token.' });
  }
  next();
}

router.get('/csrf-token', requireAuth, (req, res) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = generateCsrfToken();
  }
  res.json({ csrfToken: req.session.csrfToken });
});

// Placeholder hash so bcrypt always runs, even when only MongoDB admins exist.
const NO_ENV_ADMIN_HASH = bcrypt.hashSync('no-env-admin', 4);

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};

  // The .env admin is optional once an owner account exists in MongoDB (created by /setup).
  const envAdmin = envAdminConfigured({ ADMIN_USERNAME, ADMIN_PASSWORD_HASH });
  if (!envAdmin && !(await Admin.findOne({}))) {
    return res.status(500).json({ success: false, message: 'Server misconfiguration. Contact administrator.' });
  }

  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password are required.' });
  }

  // A locked account refuses attempts, even with the right password, until the lock ends.
  const wait = loginGuard.lockedFor('admin', username);
  if (wait) {
    res.set('Retry-After', String(wait));
    return res.status(429).json({ success: false, message: 'Too many failed attempts for this account. Try again in a few minutes.' });
  }

  try {
    // Compare the username in constant time (digests have equal length, so
    // timingSafeEqual accepts them) to avoid leaking how much of it matched.
    const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
    // The .env username only counts when the .env admin is valid. Otherwise a template value such as
    // "admin" would match and the password would be checked against the dummy hash below.
    const envNameMatch = crypto.timingSafeEqual(sha(username), sha(ADMIN_USERNAME || ''));
    const usernameMatch = envAdmin && envNameMatch;
    let hashToCheck = envAdmin ? ADMIN_PASSWORD_HASH : NO_ENV_ADMIN_HASH;
    let role = 'owner';
    let source = 'env';
    let sessionUsername = username;
    let accountFound = usernameMatch;

    // Not the .env admin? Check the extra admin accounts stored in MongoDB.
    if (!usernameMatch) {
      const account = await findStaffAccount(username);
      if (account) {
        accountFound = true;
        hashToCheck = account.passwordHash;
        role = effectiveRoleNames(account).includes(SUPER_ROLE) ? 'owner' : 'staff';
        source = 'staff';
        sessionUsername = account.username;
      }
    }

    // Always run bcrypt.compare even on username mismatch to prevent timing oracle
    const passwordMatch = await bcrypt.compare(String(password), hashToCheck);

    if (!accountFound || !passwordMatch) {
      loginGuard.recordFailure('admin', username);
      logAudit({ actor: username.slice(0, 64), action: 'LOGIN_FAILED', targetType: 'Admin', ip: req.ip });
      // One message for both cases, so it does not reveal whether the username exists
      return res.status(401).json({ success: false, message: 'Invalid username or password.' });
    }

    // Optional two-factor login (ADMIN_2FA_ENABLED=true). Only accounts that
    // finished the setup are asked for a code; everyone else logs in as before.
    if (twoFactor.featureEnabled()) {
      const factor = await twoFactor.findActive(twoFactor.keyFor(source, sessionUsername));
      if (factor) {
        const check = await twoFactor.verifyLogin(factor, (req.body || {}).otp);
        if (!check.ok) {
          logAudit({ actor: sessionUsername, action: 'LOGIN_FAILED', targetType: 'Admin', targetId: sessionUsername, ip: req.ip });
          return res.status(401).json({ success: false, twoFactorRequired: true, message: check.message });
        }
      }
    }

    loginGuard.recordSuccess('admin', username);

    // Regenerate session on login to prevent session fixation attacks
    req.session.regenerate((err) => {
      if (err) {
        console.error('Session regeneration error:', err);
        return res.status(500).json({ success: false, message: 'Login failed. Try again.' });
      }
      req.session.isAdmin = true;
      req.session.adminLastSeen = Date.now();
      req.session.username = sessionUsername;
      req.session.role = role;
      req.session.source = source;
      req.session.csrfToken = generateCsrfToken(); // Issue fresh CSRF token
      logAudit({ actor: sessionUsername, action: 'LOGIN', targetType: 'Admin', targetId: sessionUsername, ip: req.ip });
      res.json({ success: true, message: 'Login successful', csrfToken: req.session.csrfToken, role });
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Login failed. Try again.' });
  }
});

router.post('/logout', requireAuth, requireCsrf, (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Logout failed.' });
    }
    res.clearCookie('connect.sid');
    res.json({ success: true, message: 'Logged out successfully.' });
  });
});

router.get('/auth/status', async (req, res) => {
  if (!isAdminSession(req)) return res.json({ isAuthenticated: false });
  try {
    const ctx = await getAccessContext(req);
    if (!ctx) { clearAdminSession(req); return res.json({ isAuthenticated: false }); }
    res.json({
      isAuthenticated: true,
      username: req.session.username,
      role: ctx.isSuper ? 'owner' : 'staff',   // kept for compatibility
      isSuper: ctx.isSuper,
      roles: ctx.roles,
      permissions: Array.from(ctx.permissions)
    });
  } catch (err) {
    console.error('Auth status error:', err);
    res.status(500).json({ isAuthenticated: false });
  }
});

// Ends the current admin session on demand. Harmless if not signed in.
router.post('/auth/reset', (req, res) => {
  clearAdminSession(req);
  res.json({ success: true });
});

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const ROLE_NAME_RE = /^[A-Za-z][A-Za-z0-9 _-]{1,29}$/;

// Makes sure the built-in roles exist in the database so they can be listed.
async function ensureDefaultRoles() {
  for (const [name, def] of Object.entries(DEFAULT_ROLES)) {
    await Role.updateOne(
      { name },
      { $setOnInsert: { name, isSystem: true, permissions: def.permissions } },
      { upsert: true }
    );
  }
}

function roleToJson(doc) {
  const isSuper = doc.name === SUPER_ROLE;
  return {
    name: doc.name,
    isSystem: !!doc.isSystem || !!DEFAULT_ROLES[doc.name],
    isSuper,
    permissions: isSuper ? ALL_PERMISSIONS.slice() : Array.from(doc.permissions || []).filter(isValidPermission)
  };
}

async function roleExists(name) {
  if (DEFAULT_ROLES[name]) return true;
  return !!(await Role.findOne({ name }));
}

// What the permission matrix on the Roles page is built from.
router.get('/permissions/catalog', requireAuth, requireSuper, (req, res) => {
  res.json({ actions: ACTIONS, resources: RESOURCES });
});

router.get('/roles', requireAuth, requireSuper, async (req, res) => {
  try {
    await ensureDefaultRoles();
    const roles = (await Role.find()).map(roleToJson);
    roles.sort((a, b) => (Number(b.isSuper) - Number(a.isSuper)) || (Number(b.isSystem) - Number(a.isSystem)) || a.name.localeCompare(b.name));
    res.json(roles);
  } catch (err) {
    console.error('Error listing roles:', err);
    res.status(500).json({ message: 'Failed to load roles.' });
  }
});

router.post('/roles', requireAuth, requireCsrf, requireSuper, async (req, res) => {
  try {
    const name = String((req.body || {}).name || '').trim().replace(/\s+/g, ' ');
    if (!ROLE_NAME_RE.test(name)) {
      return res.status(400).json({ message: 'Role name must be 2-30 characters: start with a letter, then letters, numbers, spaces, _ or -' });
    }
    await ensureDefaultRoles();
    const existing = await Role.find();
    if (existing.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
      return res.status(400).json({ message: 'A role with that name already exists.' });
    }
    await Role.create({ name, isSystem: false, permissions: [] });
    logAudit({
      actor: req.session.username,
      action: 'CREATE_ROLE',
      targetId: name,
      targetType: 'Role',
      after: { name, isSystem: false, permissions: [] },
      ip: req.ip
    });
    res.status(201).json({ message: 'Role created.', role: { name, isSystem: false, isSuper: false, permissions: [] } });
  } catch (err) {
    if (err && err.code === 11000) return res.status(400).json({ message: 'A role with that name already exists.' });
    console.error('Error creating role:', err);
    res.status(500).json({ message: 'Failed to create role.' });
  }
});

router.put('/roles/:name/permissions', requireAuth, requireCsrf, requireSuper, async (req, res) => {
  try {
    const name = String(req.params.name);
    if (name === SUPER_ROLE) {
      return res.status(400).json({ message: 'The Admin role always has full access and cannot be changed.' });
    }
    const requested = (req.body || {}).permissions;
    if (!Array.isArray(requested) || !requested.every(isValidPermission)) {
      return res.status(400).json({ message: 'Invalid permission list.' });
    }
    await ensureDefaultRoles();
    if (!(await Role.findOne({ name }))) return res.status(404).json({ message: 'Role not found.' });

    const permissions = Array.from(new Set(requested));
    await Role.updateOne({ name }, { $set: { permissions } });
    logAudit({
      actor: req.session.username,
      action: 'UPDATE_ROLE_PERMISSIONS',
      targetId: name,
      targetType: 'Role',
      after: { permissions },
      ip: req.ip
    });
    res.json({ message: 'Permissions saved.', role: { name, permissions } });
  } catch (err) {
    console.error('Error saving permissions:', err);
    res.status(500).json({ message: 'Failed to save permissions.' });
  }
});

router.delete('/roles/:name', requireAuth, requireCsrf, requireSuper, async (req, res) => {
  try {
    const name = String(req.params.name);
    if (DEFAULT_ROLES[name]) return res.status(400).json({ message: 'Built-in roles cannot be deleted.' });
    const role = await Role.findOne({ name });
    if (!role) return res.status(404).json({ message: 'Role not found.' });

    await Role.deleteOne({ name });
    await Admin.updateMany({ roles: name }, { $pull: { roles: name } });
    logAudit({
      actor: req.session.username,
      action: 'DELETE_ROLE',
      targetId: name,
      targetType: 'Role',
      ip: req.ip
    });
    res.json({ message: 'Role deleted.' });
  } catch (err) {
    console.error('Error deleting role:', err);
    res.status(500).json({ message: 'Failed to delete role.' });
  }
});

router.get('/staff', requireAuth, requireSuper, async (req, res) => {
  try {
    const accounts = await Admin.find();
    accounts.sort((a, b) => a.username.localeCompare(b.username));
    res.json(accounts.map((a) => ({
      username: a.username,
      roles: effectiveRoleNames(a),
      active: a.active !== false,
      createdAt: a.createdAt
    })));
  } catch (err) {
    console.error('Error listing admin accounts:', err);
    res.status(500).json({ message: 'Failed to load admin accounts.' });
  }
});

router.post('/staff', requireAuth, requireCsrf, requireSuper, async (req, res) => {
  try {
    const body = req.body || {};
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');

    // Accept the new `roles: [...]` list, or the older `role: 'owner'|'staff'`
    let roles;
    if (Array.isArray(body.roles)) roles = Array.from(new Set(body.roles.map(String)));
    else if (body.role === 'owner') roles = [SUPER_ROLE];
    else roles = ['Staff'];

    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ message: 'Username must be 3-32 characters: letters, numbers, . _ -' });
    }
    if (envAdminConfigured({ ADMIN_USERNAME, ADMIN_PASSWORD_HASH }) && username === String(ADMIN_USERNAME).toLowerCase()) {
      return res.status(400).json({ message: 'That username is reserved.' });
    }
    const weakPassword = passwordProblem(password);
    if (weakPassword) {
      return res.status(400).json({ message: weakPassword });
    }
    for (const r of roles) {
      if (!(await roleExists(r))) return res.status(400).json({ message: `Role "${r}" does not exist.` });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const account = await Admin.create({
      username, passwordHash, roles,
      role: roles.includes(SUPER_ROLE) ? 'owner' : 'staff'
    });
    logAudit({
      actor: req.session.username,
      action: 'CREATE_STAFF',
      targetId: account.username,
      targetType: 'Admin',
      after: { roles },
      ip: req.ip
    });
    res.status(201).json({ message: 'Admin account created.', account: { username: account.username, roles } });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(400).json({ message: 'An admin with that username already exists.' });
    }
    console.error('Error creating admin account:', err);
    res.status(500).json({ message: 'Failed to create admin account.' });
  }
});

// Owners are the Admin-role accounts in MongoDB plus the .env admin when it is valid.
async function isLastOwner(account) {
  if (account.active === false || !effectiveRoleNames(account).includes(SUPER_ROLE)) return false;
  const others = (await Admin.find()).filter((a) => a.username !== account.username && a.active !== false && effectiveRoleNames(a).includes(SUPER_ROLE));
  return others.length === 0 && !envAdminConfigured({ ADMIN_USERNAME, ADMIN_PASSWORD_HASH });
}

router.delete('/staff/:username', requireAuth, requireCsrf, requireSuper, async (req, res) => {
  try {
    const username = String(req.params.username).toLowerCase();
    const target = await Admin.findOne({ username });
    if (!target) return res.status(404).json({ message: 'Admin account not found.' });
    if (req.session.source === 'staff' && String(req.session.username).toLowerCase() === username) {
      return res.status(409).json({ message: 'You cannot delete your own account.' });
    }
    if (await isLastOwner(target)) return res.status(409).json({ message: 'The last owner account cannot be deleted.' });
    const removed = await Admin.findOneAndDelete({ username });
    // Its two-factor secret and backup codes go with it, so a later account with the same
    // username does not inherit them.
    if (removed) await AdminTwoFactor.deleteOne({ key: twoFactor.keyFor('staff', removed.username) });
    if (!removed) return res.status(404).json({ message: 'Admin account not found.' });
    logAudit({
      actor: req.session.username,
      action: 'DELETE_STAFF',
      targetId: removed.username,
      targetType: 'Admin',
      ip: req.ip
    });
    res.json({ message: 'Admin account deleted.' });
  } catch (err) {
    console.error('Error deleting admin account:', err);
    res.status(500).json({ message: 'Failed to delete admin account.' });
  }
});

async function findAccountOr404(req, res) {
  const account = await Admin.findOne({ username: String(req.params.username).toLowerCase() });
  if (!account) res.status(404).json({ message: 'Admin account not found.' });
  return account;
}

async function saveRoles(account, roles) {
  await Admin.updateOne(
    { username: account.username },
    { $set: { roles, role: roles.includes(SUPER_ROLE) ? 'owner' : 'staff' } }
  );
}

router.get('/staff/:username/roles', requireAuth, requireSuper, async (req, res) => {
  try {
    const account = await findAccountOr404(req, res);
    if (!account) return;
    const roles = effectiveRoleNames(account);
    const access = resolveAccess(roles, await Role.find({ name: { $in: roles } }));
    res.json({ username: account.username, roles, isSuper: access.isSuper, permissions: Array.from(access.permissions) });
  } catch (err) {
    console.error('Error loading account roles:', err);
    res.status(500).json({ message: 'Failed to load roles for this user.' });
  }
});

router.post('/staff/:username/roles', requireAuth, requireCsrf, requireSuper, async (req, res) => {
  try {
    const account = await findAccountOr404(req, res);
    if (!account) return;
    const roleName = String((req.body || {}).role || '');
    if (!(await roleExists(roleName))) return res.status(404).json({ message: 'Role not found.' });

    const current = effectiveRoleNames(account);
    if (current.includes(roleName)) return res.status(400).json({ message: 'This user already has that role.' });
    const roles = [...current, roleName];
    await saveRoles(account, roles);
    logAudit({
      actor: req.session.username,
      action: 'ADD_STAFF_ROLE',
      targetId: account.username,
      targetType: 'Admin',
      after: { roles },
      ip: req.ip
    });
    res.json({ message: `Role "${roleName}" added.`, roles });
  } catch (err) {
    console.error('Error adding role to account:', err);
    res.status(500).json({ message: 'Failed to add role.' });
  }
});

router.delete('/staff/:username/roles/:role', requireAuth, requireCsrf, requireSuper, async (req, res) => {
  try {
    const account = await findAccountOr404(req, res);
    if (!account) return;
    const roleName = String(req.params.role);

    const current = effectiveRoleNames(account);
    if (!current.includes(roleName)) return res.status(400).json({ message: 'This user does not have that role.' });
    if (roleName === SUPER_ROLE && (await isLastOwner(account))) {
      return res.status(409).json({ message: 'The last owner account cannot lose the Admin role.' });
    }
    const roles = current.filter((r) => r !== roleName);
    await saveRoles(account, roles);
    logAudit({
      actor: req.session.username,
      action: 'REMOVE_STAFF_ROLE',
      targetId: account.username,
      targetType: 'Admin',
      after: { roles },
      ip: req.ip
    });
    res.json({ message: `Role "${roleName}" removed.`, roles });
  } catch (err) {
    console.error('Error removing role from account:', err);
    res.status(500).json({ message: 'Failed to remove role.' });
  }
});

function sanitizeString(str, maxLength = 500) {
  if (typeof str !== 'string') return '';
  return str.trim().substring(0, maxLength);
}

// Product titles are plain text: "<", ">" and control characters are removed (see
// services/plainText.js).
function sanitizeTitle(str, maxLength = 200) {
  return sanitizeString(plainName(typeof str === 'string' ? str : ''), maxLength);
}


// Stores one picture as a file and answers with its address, so the product form sends only
// addresses and a product with several pictures needs no huge request.
router.post('/upload-image', requireAuth, requireCsrf, requireAnyPermission(['product.create', 'product.edit']), async (req, res) => {
  try {
    if (storageMode() !== 'disk') return res.status(400).json({ message: 'Picture files are switched off (UPLOAD_STORAGE=database).' });
    const image = cleanImageInput((req.body || {}).data);
    if (!image.ok || !String(image.value || '').startsWith('data:')) {
      return res.status(400).json({ message: image.ok ? 'Send the picture as an upload.' : image.message });
    }
    if (await storedPictureCount(null) >= MAX_PICTURES_PER_VENDOR) {
      return res.status(429).json({ message: `The store can keep at most ${MAX_PICTURES_PER_VENDOR} pictures of its own products. Remove pictures you no longer use.` });
    }
    const url = await storeImageValue(image.value);
    if (!UPLOAD_URL.test(url)) return res.status(500).json({ message: 'The picture could not be saved: check that the upload folder is writable (UPLOAD_DIR).' });
    res.status(201).json({ url });
  } catch (err) {
    console.error('Upload picture error:', err.message);
    res.status(500).json({ message: 'Could not save the picture.' });
  }
});

router.post('/products', requireAuth, requireCsrf, requirePermission('product.create'), async (req, res) => {
  try {
    const { title, description, price, stock, imageUrl, category } = req.body || {};

    if (!title || typeof title !== 'string' || sanitizeTitle(title).length < 2) {
      return res.status(400).json({ message: 'Product title is required (min 2 characters).' });
    }

    // Optional stock per size, e.g. { S: 4, M: 0, L: 7 }. The total stock is then the sum of the sizes.
    const sizes = cleanSizeStock((req.body || {}).sizeStock);
    if (!sizes.ok) return res.status(400).json({ message: sizes.message });

    const priceRule = productRules.parsePrice(price);
    if (!priceRule.ok) return res.status(400).json({ message: priceRule.message });

    const stockNum = sizes.value ? sizeStockTotal(sizes.value) : productRules.parseWholeStock(stock);
    if (stockNum === null || stockNum === undefined || isNaN(stockNum)) {
      return res.status(400).json({ message: 'Stock must be a whole number.' });
    }
    if (stockNum < 0 || stockNum > 100_000) {
      return res.status(400).json({ message: 'Stock must be between 0 and 100,000.' });
    }

    const image = cleanImageInput(imageUrl);
    if (!image.ok) return res.status(400).json({ message: image.message });
    const gallery = cleanImageList((req.body || {}).images, { allowUploads: storageMode() === 'disk' });
    if (!gallery.ok) return res.status(400).json({ message: gallery.message });
    const pictures = await applyPictures({ imageUrl: image.keep ? '' : image.value }, gallery);   // uploads become files
    const finalImageUrl = pictures.imageUrl;

    const categoryName = canonicalCategory(category);
    if (!categoryName) return res.status(400).json({ message: CATEGORY_MESSAGE });

    const product = await Product.create({
      title: sanitizeTitle(title),
      description: sanitizeString(description || '', 1000),
      price: priceRule.value,
      stock: Math.floor(stockNum),
      ...(sizes.value ? { sizeStock: sizes.value } : {}),
      imageUrl: finalImageUrl,
      ...(pictures.images && pictures.images.length ? { images: pictures.images } : {}),
      category: categoryName
    });

    logAudit({
      actor: req.session.username,
      action: 'CREATE_PRODUCT',
      targetId: product._id,
      targetType: 'Product',
      after: product,
      ip: req.ip
    });

    req.app.get('io').emit('productUpdate');
    res.status(201).json(publicProduct(product));
  } catch (err) {
    console.error('Error creating product:', err);
    if (err.name === 'ValidationError') {
      return res.status(400).json({ message: 'Validation error: ' + Object.values(err.errors).map(e => e.message).join(', ') });
    }
    res.status(500).json({ message: 'Failed to create product.' });
  }
});

router.get('/products', requireAuth, requirePermission('product.view'), async (req, res) => {
  try {
    // Uploaded pictures are replaced by a short marker in the database itself, so this list
    // does not load every picture into memory (see listImageStage).
    // At most 2000 products per answer (?limit= and ?skip= page through more); the X-Has-More
    // header says whether more follow. The answer stays a plain array.
    const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit, 10) || 2000));
    const skip = Math.max(0, parseInt(req.query.skip, 10) || 0);
    // One extra row is read to learn whether more follow.
    const rows = await Product.aggregate([{ $sort: { createdAt: -1, _id: -1 } }, { $skip: skip }, { $limit: limit + 1 }, listImageStage()]);
    const products = rows.slice(0, limit);
    res.set('X-Has-More', String(rows.length > limit));
    res.json(products.map(publicProduct));
  } catch (err) {
    console.error('Error fetching products:', err);
    res.status(500).json({ message: 'Failed to fetch products.' });
  }
});

// What an account with order.view but WITHOUT order.details may see in the order list: what
// was ordered, the money and the status, but no customer name, e-mail, phone, address or
// payment reference (and so not the duplicate-reference flag either).
const HIDDEN_TEXT = 'Hidden (needs the order details permission)';
function redactOrderForList(o) {
  return {
    _id: o._id, status: o.status, createdAt: o.createdAt, paidAt: o.paidAt,
    paymentGateway: o.paymentGateway, paymentIssue: o.paymentIssue,
    subtotalAmount: o.subtotalAmount, discountAmount: o.discountAmount, shippingAmount: o.shippingAmount,
    totalAmount: o.totalAmount, couponCode: o.couponCode,
    items: (o.items || []).map((i) => ({ title: i.title, quantity: i.quantity, size: i.size, price: i.price })),
    allowedStatuses: o.allowedStatuses, countsAsRevenue: o.countsAsRevenue,
    customerName: HIDDEN_TEXT, customerEmail: '', detailsHidden: true
  };
}

router.put('/products/:id', requireAuth, requireCsrf, requirePermission('product.edit'), async (req, res) => {
  try {
    if (!OBJECT_ID.test(req.params.id)) {
      return res.status(400).json({ message: 'Invalid product ID format.' });
    }
    const { title, description, price, stock, imageUrl, category } = req.body || {};
    const updateData = {};
    // The stock the edit form was loaded with.
    const previousStock = parsePreviousStock((req.body || {}).previousStock);
    let stockDelta = 0;

    // Stock per size (optional). `sizeStock` is what the form saved, `previousSizeStock` what it
    // was loaded with.
    const sizes = cleanSizeStock((req.body || {}).sizeStock);
    if (!sizes.ok) return res.status(400).json({ message: sizes.message });

    if (title !== undefined) {
      if (typeof title !== 'string' || sanitizeTitle(title).length < 2) {
        return res.status(400).json({ message: 'Product title must be at least 2 characters.' });
      }
      updateData.title = sanitizeTitle(title);
    }

    if (description !== undefined) updateData.description = sanitizeString(description, 1000);

    if (price !== undefined) {
      const priceRule = productRules.parsePrice(price);
      if (!priceRule.ok) return res.status(400).json({ message: priceRule.message });
      updateData.price = priceRule.value;
    }

    if (stock !== undefined && !sizes.provided) {
      const s = productRules.parseWholeStock(stock);
      if (s === null || s > 100_000) {
        return res.status(400).json({ message: 'Stock must be between 0 and 100,000.' });
      }
      // Without the stock the form was loaded with, saving would overwrite units that orders took
      // meanwhile.
      if (previousStock === null) return res.status(400).json({ message: 'Reload the product before saving its stock (previousStock is required).' });
      stockDelta = s - previousStock;
    }

    const plan = await planStockChange({
      findCurrent: () => Product.findById(req.params.id).select('sizeStock stock'),
      body: req.body || {}, sizes, stockDelta, reload: 'its sizes'
    });
    if (plan.error) return res.status(plan.error.status).json({ message: plan.error.message });

    const gallery = cleanImageList((req.body || {}).images, { allowUploads: storageMode() === 'disk' });
    if (!gallery.ok) return res.status(400).json({ message: gallery.message });
    if (imageUrl !== undefined) {
      const image = cleanImageInput(imageUrl);
      if (!image.ok) return res.status(400).json({ message: image.message });
      // The edit form sends back the short address an uploaded picture is shown
      // under; that means "leave the picture as it is".
      if (!image.keep) updateData.imageUrl = image.value;
    }

    if (category !== undefined) {
      const categoryName = canonicalCategory(category);
      if (categoryName) {
        updateData.category = categoryName;
      } else {
        // A product created before the category list existed may still carry an old value (e.g. "General").
        // Saving the form with that same value is allowed; choosing a new category is not.
        const current = await Product.findById(req.params.id).select('category').lean();
        if (!current || String(current.category) !== String(category).trim()) {
          return res.status(400).json({ message: CATEGORY_MESSAGE });
        }
      }
    }

    const picturesBefore = await savePictures(updateData, gallery, () => Product.findById(req.params.id).select('imageUrl images').lean());

    let product = await Product.findByIdAndUpdate(req.params.id, updateData, { returnDocument: 'after', runValidators: true });
    if (!product) return res.status(404).json({ message: 'Product not found.' });
    product = await applyStockChange(product, plan);
    if (plan.sizeChange) {
      updateData.stock = product.stock;   // what the audit log records
      updateData.sizeStock = product.sizeStock || null;
    } else if (plan.stockDelta) {
      updateData.stock = product.stock;
    }

    logAudit({
      actor: req.session.username,
      action: 'UPDATE_PRODUCT',
      targetId: product._id,
      targetType: 'Product',
      after: updateData,
      ip: req.ip
    });

    if (picturesBefore.length) await removeUnusedUploads(picturesBefore);   // pictures that were replaced or removed
    req.app.get('io').emit('productUpdate');
    res.json(publicProduct(product));
  } catch (err) {
    console.error('Error updating product:', err);
    if (err.name === 'ValidationError') {
      return res.status(400).json({ message: 'Validation error: ' + Object.values(err.errors).map(e => e.message).join(', ') });
    }
    res.status(500).json({ message: 'Failed to update product.' });
  }
});

// Needs the product.view permission to read and product.edit to hide or delete a review.
router.get('/reviews', requireAuth, requirePermission('product.view'), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 20;
    const filter = req.query.hidden === 'true' ? { hidden: true } : {};
    const [list, total] = await Promise.all([
      Review.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Review.countDocuments(filter)
    ]);
    const titles = new Map();
    for (const p of await Product.find({ _id: { $in: list.map((r) => r.productId) } }).select('title').lean()) titles.set(String(p._id), p.title);
    res.json({
      reviews: list.map((r) => ({
        _id: r._id, productId: r.productId, productTitle: titles.get(String(r.productId)) || '(deleted product)',
        authorName: r.authorName, rating: r.rating, text: r.text, hidden: !!r.hidden, createdAt: r.createdAt
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (err) {
    console.error('Admin reviews error:', err.message);
    res.status(500).json({ message: 'Failed to fetch reviews.' });
  }
});

router.put('/reviews/:id', requireAuth, requireCsrf, requirePermission('product.edit'), async (req, res) => {
  try {
    if (!/^[0-9a-fA-F]{24}$/.test(req.params.id)) return res.status(400).json({ message: 'Invalid review ID.' });
    const hidden = (req.body || {}).hidden;
    if (typeof hidden !== 'boolean') return res.status(400).json({ message: 'hidden must be true or false.' });
    const review = await Review.findByIdAndUpdate(req.params.id, { $set: { hidden } }, { returnDocument: 'after' });
    if (!review) return res.status(404).json({ message: 'Review not found.' });
    await reviewService.refreshRating(review.productId);
    logAudit({ actor: req.session.username, action: hidden ? 'HIDE_REVIEW' : 'SHOW_REVIEW', targetId: review._id, targetType: 'Review', ip: req.ip });
    req.app.get('io').emit('productUpdate');
    res.json({ message: hidden ? 'Review hidden.' : 'Review shown.', hidden });
  } catch (err) {
    console.error('Admin review update error:', err.message);
    res.status(500).json({ message: 'Failed to update the review.' });
  }
});

router.delete('/reviews/:id', requireAuth, requireCsrf, requirePermission('product.edit'), async (req, res) => {
  try {
    if (!/^[0-9a-fA-F]{24}$/.test(req.params.id)) return res.status(400).json({ message: 'Invalid review ID.' });
    const review = await Review.findByIdAndDelete(req.params.id);
    if (!review) return res.status(404).json({ message: 'Review not found.' });
    await reviewService.refreshRating(review.productId);
    logAudit({ actor: req.session.username, action: 'DELETE_REVIEW', targetId: review._id, targetType: 'Review', before: review, ip: req.ip });
    req.app.get('io').emit('productUpdate');
    res.json({ message: 'Review deleted.' });
  } catch (err) {
    console.error('Admin review delete error:', err.message);
    res.status(500).json({ message: 'Failed to delete the review.' });
  }
});

router.delete('/products/:id', requireAuth, requireCsrf, requirePermission('product.delete'), async (req, res) => {
  try {
    if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ message: 'Invalid product ID format.' });
    }
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found.' });

    logAudit({
      actor: req.session.username,
      action: 'DELETE_PRODUCT',
      targetId: product._id,
      targetType: 'Product',
      before: product,
      ip: req.ip
    });

    await removeUnusedUploads(picturesOf(product));   // the product's picture files, unless another product uses them
    try { await Review.deleteMany({ productId: product._id }); } catch (e) { /* the product is gone either way */ }
    req.app.get('io').emit('productUpdate');
    res.json({ message: 'Product deleted successfully.' });
  } catch (err) {
    console.error('Error deleting product:', err);
    res.status(500).json({ message: 'Failed to delete product.' });
  }
});


const ORDER_STATUSES = ['PENDING', 'PLACED', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'];

router.get('/orders', requireAuth, requirePermission('order.view'), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const skip = (page - 1) * limit;

    // Optional filter by status (ignored when it is not a known status).
    const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : '';
    const filter = ORDER_STATUSES.includes(status) ? { status } : {};

    const [orders, total, ctx] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Order.countDocuments(filter),
      getAccessContext(req)
    ]);
    // Opening a single order needs order.details; the list must not hand out the same
    // personal data to an account that only has order.view.
    const mayOpenOrders = !!ctx && (ctx.isSuper || ctx.permissions.has('order.details'));

    res.json({
      orders: orders.map((o) => {
        const json = typeof o.toObject === 'function' ? o.toObject() : { ...o };
        // What the admin may do next, so the page never offers an illegal change.
        json.allowedStatuses = allowedNextStatuses(json);
        json.countsAsRevenue = !!json.paidAt && json.status !== 'CANCELLED';
        return mayOpenOrders ? json : redactOrderForList(json);
      }),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('Error fetching orders:', err);
    res.status(500).json({ message: 'Failed to fetch orders.' });
  }
});

// Everything the dashboard cards show, counted by the database instead of in the page.
router.get('/stats', requireAuth, requirePermission('order.view'), async (req, res) => {
  try {
    const [byStatus, revenue, productCount, lowStock, outOfStock] = await Promise.all([
      Order.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      Order.aggregate([
        { $match: REVENUE_FILTER },
        { $group: { _id: null, minor: { $sum: { $round: [{ $multiply: ['$totalAmount', minorUnit()] }, 0] } }, count: { $sum: 1 } } }
      ]),
      Product.countDocuments({}),
      Product.countDocuments({ stock: { $gt: 0, $lt: 5 } }),
      Product.countDocuments({ stock: { $lte: 0 } })
    ]);
    const orderCounts = {};
    let totalOrders = 0;
    for (const row of byStatus) { orderCounts[row._id] = row.count; totalOrders += row.count; }
    const rev = revenue[0];
    const totalRevenueMinor = rev ? Math.round(rev.minor) : 0;

    // Marketplace money split (multivendor mode only), computed with the same per-line rounding as
    // payouts.
    const split = marketplace.enabled() ? await marketplace.revenueBreakdown() : null;

    res.json({
      totalOrders,
      orderCounts,
      totalRevenue: fromMinor(totalRevenueMinor),
      paidOrderCount: rev ? rev.count : 0,
      productCount,
      lowStock,
      outOfStock,
      ...(split ? split : {})
    });
  } catch (err) {
    console.error('Error computing stats:', err);
    res.status(500).json({ message: 'Failed to load dashboard numbers.' });
  }
});

router.get('/orders/:id', requireAuth, requirePermission('order.details'), async (req, res) => {
  try {
    if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ message: 'Invalid order ID format.' });
    }
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found.' });
    res.json(order);
  } catch (err) {
    console.error('Error fetching order:', err);
    res.status(500).json({ message: 'Failed to fetch order.' });
  }
});

router.put('/orders/:id/status', requireAuth, requireCsrf, requirePermission('order.edit'), async (req, res) => {
  try {
    if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ message: 'Invalid order ID format.' });
    }

    const { status } = req.body || {};
    const validStatuses = ['PLACED', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'];

    if (typeof status !== 'string' || !validStatuses.includes(status.toUpperCase())) {
      return res.status(400).json({ message: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }

    const newStatus = status.toUpperCase();
    const existing = await Order.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Order not found.' });

    // Only legal steps: PLACED, CONFIRMED, SHIPPED, DELIVERED (in that order), a cancel
    // from any live status, and a reopen of a cancelled order. An unpaid online
    // (PENDING) order is confirmed by its payment, never by hand.
    if (!canTransition(existing, newStatus)) {
      const allowed = allowedNextStatuses(existing);
      return res.status(409).json({
        message: allowed.length
          ? `An order that is ${existing.status} can only be changed to: ${allowed.join(', ')}.`
          : `An order that is ${existing.status} cannot be changed.`,
        allowedStatuses: allowed
      });
    }
    if (existing.status === 'CANCELLED' && existing.refundedAt) {
      return res.status(409).json({ message: 'This order was refunded, so it cannot be reopened. Ask the customer to place a new order.' });
    }

    // Stock follows the status: cancelling an unshipped order restocks it once; reopening takes
    // the stock again (refused if short); cancelling a shipped or delivered order leaves stock
    // alone.
    let order = null;
    let stockChanged = false;

    if (newStatus === 'CANCELLED') {
      order = await cancelOrderAndRestock(existing._id);
      stockChanged = !!order;
      if (!order) {
        // SHIPPED / DELIVERED: no stock to return, still a real cancellation.
        order = await Order.findOneAndUpdate(
          { _id: existing._id, status: existing.status },
          { status: 'CANCELLED' },
          { returnDocument: 'after', runValidators: true }
        );
        if (!order) return res.status(409).json({ message: 'This order was changed by someone else. Reload and try again.' });
      }
      // A paid order (online, cash received, verified transfer) needs a refund whatever it was
      // cancelled from.
      if ((existing.paidAt || existing.paymentIssue === 'PAYMENT_UNCONFIRMED') && !order.refundedAt) {
        order = await Order.findOneAndUpdate(
          { _id: order._id },
          { $set: { paymentIssue: 'REFUND_DUE' } },
          { returnDocument: 'after' }
        ) || order;
      }
    } else if (existing.status === 'CANCELLED') {
      const outcome = await reopenCancelledOrder(existing._id, newStatus);
      if (outcome.result === 'no_stock') {
        return res.status(409).json({ message: `Cannot reopen this order: not enough stock for "${outcome.title}".` });
      }
      if (outcome.result === 'coupon_unavailable') {
        return res.status(409).json({ message: 'Cannot reopen this order: its coupon has no uses left. Raise the coupon\'s usage limit first.' });
      }
      if (outcome.result === 'changed') {
        return res.status(409).json({ message: 'This order was changed by someone else. Reload and try again.' });
      }
      if (outcome.result === 'not_found') return res.status(404).json({ message: 'Order not found.' });
      if (outcome.result === 'reopened') {
        order = outcome.order;
        stockChanged = existing.stockReleased === true;
      }
    } else {
      // A manual-payment order is confirmed after the transfer was checked, so confirming it is
      // also the moment it counts as paid.
      const set = { status: newStatus };
      if (newStatus === 'CONFIRMED' && !existing.paidAt && (existing.paymentGateway === 'manual' || existing.paymentIssue === 'PAYMENT_UNCONFIRMED')) set.paidAt = new Date();
      const updateDoc = { $set: set };
      if (newStatus === 'CONFIRMED' && existing.paymentIssue === 'PAYMENT_UNCONFIRMED') {
        updateDoc.$unset = { paymentIssue: 1 };
      }
      order = await Order.findOneAndUpdate(
        { _id: existing._id, status: existing.status },
        updateDoc,
        { returnDocument: 'after', runValidators: true }
      );
      if (!order) return res.status(409).json({ message: 'This order was changed by someone else. Reload and try again.' });
    }

    if (!order) return res.status(404).json({ message: 'Order not found.' });

    if (['SHIPPED', 'DELIVERED'].includes(order.status) && order.fulfillment && order.fulfillment.length > 0) {
      // One conditional write per vendor entry, so a vendor's own change made at the same moment
      // is never overwritten.
      for (const f of order.fulfillment) {
        if (f.status === 'DELIVERED' || f.status === order.status) continue;
        await Order.updateOne(
          { _id: order._id, fulfillment: { $elemMatch: { vendorId: f.vendorId, status: f.status } } },
          { $set: { 'fulfillment.$.status': order.status, 'fulfillment.$.updatedAt': new Date() } }
        );
      }
    } else if (existing.status === 'CANCELLED' && order.fulfillment && order.fulfillment.length > 0) {
      // A reopened marketplace order: if every seller had already shipped / delivered, the order
      // status follows them again.
      const derived = marketplace.derivedStatus(order);
      if (derived && derived !== order.status) {
        const moved = await Order.findOneAndUpdate({ _id: order._id, status: order.status }, { $set: { status: derived } }, { returnDocument: 'after' });
        if (moved) order = moved;
      }
    }
    logAudit({
      actor: req.session.username,
      action: 'UPDATE_ORDER_STATUS',
      targetId: order._id,
      targetType: 'Order',
      before: { status: existing.status },
      after: { status: order.status },
      ip: req.ip
    });

    if (['CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'].includes(newStatus)) {
      Promise.resolve(sendStatusUpdate(order)).catch((err) => console.error("Status email failed:", err.message));
    }

    if (stockChanged) req.app.get('io').emit('productUpdate');
    req.app.get('io').emit('orderUpdate');
    res.json(order);
  } catch (err) {
    console.error('Error updating order status:', err);
    res.status(500).json({ message: 'Failed to update order status.' });
  }
});

// Records that the courier handed over the cash for a Cash on Delivery order.
// Only a COD order that has been DELIVERED can be marked paid, and only once:
// the update is one conditional write, so a double click cannot succeed twice.
router.put('/orders/:id/cod-paid', requireAuth, requireCsrf, requirePermission('order.edit'), async (req, res) => {
  try {
    if (!/^[0-9a-fA-F]{24}$/.test(req.params.id)) {
      return res.status(400).json({ message: 'Invalid order ID format.' });
    }
    const existing = await Order.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Order not found.' });
    if (existing.paymentGateway !== 'cod') {
      return res.status(400).json({ message: 'Only Cash on Delivery orders can be marked as paid here.' });
    }
    if (existing.paidAt) return res.status(409).json({ message: 'This order is already marked as paid.' });
    if (existing.status !== 'DELIVERED') {
      return res.status(409).json({ message: 'Mark the order as DELIVERED first. Cash is received when it is delivered.' });
    }

    const order = await Order.findOneAndUpdate(
      { _id: existing._id, paymentGateway: 'cod', status: 'DELIVERED', paidAt: null },
      { $set: { paidAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!order) {
      return res.status(409).json({ message: 'This order was changed by someone else. Reload and try again.' });
    }

    logAudit({
      actor: req.session.username,
      action: 'MARK_COD_PAID',
      targetId: order._id,
      targetType: 'Order',
      ip: req.ip
    });

    req.app.get('io').emit('orderUpdate');
    res.json(order);
  } catch (err) {
    console.error('Error marking order as paid:', err);
    res.status(500).json({ message: 'Failed to mark the order as paid.' });
  }
});

// Rules are re-checked in services/coupons.js. usedCount is never set here (see
// services/couponService.js).

function couponToJson(c) {
  return {
    _id: c._id,
    code: c.code,
    type: c.type,
    value: c.value,
    minOrderAmount: c.minOrderAmount == null ? null : c.minOrderAmount,
    maxDiscount: c.maxDiscount == null ? null : c.maxDiscount,
    usageLimit: c.usageLimit == null ? null : c.usageLimit,
    perCustomerLimit: c.perCustomerLimit == null ? null : c.perCustomerLimit,
    usedCount: c.usedCount || 0,
    startsAt: c.startsAt || null,
    endsAt: c.endsAt || null,
    active: c.active !== false,
    status: couponStatus(c),
    createdAt: c.createdAt
  };
}

router.get('/coupons', requireAuth, requirePermission('coupon.view'), async (req, res) => {
  try {
    const coupons = await Coupon.find().sort({ createdAt: -1 }).limit(500);
    res.json(coupons.map(couponToJson));
  } catch (err) {
    console.error('Error fetching coupons:', err);
    res.status(500).json({ message: 'Failed to fetch coupons.' });
  }
});

router.post('/coupons', requireAuth, requireCsrf, requirePermission('coupon.create'), async (req, res) => {
  try {
    const checked = validateCouponInput(req.body);
    if (!checked.ok) return res.status(400).json({ message: checked.message });

    const coupon = await Coupon.create({ ...checked.value, usedCount: 0 });
    logAudit({
      actor: req.session.username,
      action: 'CREATE_COUPON',
      targetId: coupon._id,
      targetType: 'Coupon',
      after: checked.value,
      ip: req.ip
    });
    res.status(201).json(couponToJson(coupon));
  } catch (err) {
    if (err && err.code === 11000) return res.status(400).json({ message: 'A coupon with that code already exists.' });
    console.error('Error creating coupon:', err);
    res.status(500).json({ message: 'Failed to create coupon.' });
  }
});

// Edit a coupon, or switch it on / off by sending only { active: true|false }.
router.put('/coupons/:id', requireAuth, requireCsrf, requirePermission('coupon.edit'), async (req, res) => {
  try {
    if (!/^[0-9a-fA-F]{24}$/.test(req.params.id)) {
      return res.status(400).json({ message: 'Invalid coupon ID format.' });
    }
    const existing = await Coupon.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Coupon not found.' });

    const checked = validateCouponInput(req.body, existing);
    if (!checked.ok) return res.status(400).json({ message: checked.message });

    // The usage limit can not drop below the uses that already happened, even
    // if an order used the coupon after the form was opened.
    const filter = { _id: existing._id };
    if (checked.value.usageLimit != null) filter.usedCount = { $lte: checked.value.usageLimit };

    const changes = { ...checked.value };
    delete changes.code;   // the code never changes
    const coupon = await Coupon.findOneAndUpdate(filter, { $set: changes }, { returnDocument: 'after', runValidators: true });
    if (!coupon) {
      return res.status(409).json({ message: 'This coupon was used while you were editing it. Reload and try again.' });
    }
    logAudit({
      actor: req.session.username,
      action: 'UPDATE_COUPON',
      targetId: coupon._id,
      targetType: 'Coupon',
      after: changes,
      ip: req.ip
    });
    res.json(couponToJson(coupon));
  } catch (err) {
    console.error('Error updating coupon:', err);
    res.status(500).json({ message: 'Failed to update coupon.' });
  }
});

router.delete('/coupons/:id', requireAuth, requireCsrf, requirePermission('coupon.delete'), async (req, res) => {
  try {
    if (!/^[0-9a-fA-F]{24}$/.test(req.params.id)) {
      return res.status(400).json({ message: 'Invalid coupon ID format.' });
    }
    const coupon = await Coupon.findByIdAndDelete(req.params.id);
    if (!coupon) return res.status(404).json({ message: 'Coupon not found.' });
    logAudit({
      actor: req.session.username,
      action: 'DELETE_COUPON',
      targetId: coupon._id,
      targetType: 'Coupon',
      before: coupon,
      ip: req.ip
    });
    res.json({ message: 'Coupon deleted successfully.' });
  } catch (err) {
    console.error('Error deleting coupon:', err);
    res.status(500).json({ message: 'Failed to delete coupon.' });
  }
});

// Staff confirm after verifying the customer (for example by phone).
router.put('/orders/:id/confirm', requireAuth, requireCsrf, requirePermission('order.edit'), async (req, res) => {
  try {
    if (!/^[0-9a-fA-F]{24}$/.test(req.params.id)) {
      return res.status(400).json({ message: 'Invalid order ID format.' });
    }
    const existing = await Order.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Order not found.' });
    // PLACED = cash / manual orders. PENDING is allowed only when the gateway flagged the payment
    // for review.
    const reviewable = existing.status === 'PENDING' && existing.paymentIssue === 'PAYMENT_UNCONFIRMED';
    if (existing.status !== 'PLACED' && !reviewable) {
      return res.status(409).json({ message: `Order is ${existing.status}. Only PLACED orders, or payments flagged for review, can be confirmed.` });
    }
    // Confirming a manual-payment order means the transfer was checked, so the
    // order counts as paid from now on.
    const set = { status: 'CONFIRMED' };
    if (!existing.paidAt && (existing.paymentGateway === 'manual' || reviewable)) set.paidAt = new Date();
    const updateDoc = { $set: set };
    if (existing.paymentIssue === 'PAYMENT_UNCONFIRMED') updateDoc.$unset = { paymentIssue: 1 };
    const order = await Order.findOneAndUpdate(
      { _id: existing._id, status: existing.status },
      updateDoc,
      { returnDocument: 'after' }
    );
    if (!order) {
      return res.status(409).json({ message: 'Order was changed by someone else. Reload and try again.' });
    }
    logAudit({
      actor: req.session.username,
      action: 'CONFIRM_ORDER',
      targetId: order._id,
      targetType: 'Order',
      before: { status: existing.status },
      after:  { status: 'CONFIRMED' },
      ip: req.ip
    });
    Promise.resolve(sendStatusUpdate(order)).catch((err) => console.error("Status email failed:", err.message));
    req.app.get('io').emit('orderUpdate');
    res.json(order);
  } catch (err) {
    console.error('Error confirming order:', err);
    res.status(500).json({ message: 'Failed to confirm order.' });
  }
});

// Records that the merchant has returned the money. Works once per order.
router.put('/orders/:id/mark-refunded', requireAuth, requireCsrf, requirePermission('order.edit'), async (req, res) => {
  try {
    if (!/^[0-9a-fA-F]{24}$/.test(req.params.id)) {
      return res.status(400).json({ message: 'Invalid order ID format.' });
    }
    const awaiting = await Order.findOne({ _id: req.params.id, refundedAt: null, paymentIssue: { $in: ['REFUND_DUE', 'PAID_AFTER_CANCEL'] } });
    if (!awaiting) {
      return res.status(409).json({ message: 'This order is not awaiting a refund, or it was already processed.' });
    }
    // What was refunded: the full order total unless an amount is given (a partial refund). It can
    // never be more than the customer paid.
    const { amount: refundAmountRaw, note: refundNoteRaw } = req.body || {};
    let refundedAmount = awaiting.totalAmount;
    if (refundAmountRaw !== undefined && refundAmountRaw !== null && refundAmountRaw !== '') {
      let minor = NaN;
      try { minor = toMinor(refundAmountRaw); } catch (e) { /* invalid below */ }
      if (!Number.isFinite(minor) || minor <= 0 || minor > toMinor(awaiting.totalAmount)) {
        return res.status(400).json({ message: `The refund must be more than 0 and at most the order total (${awaiting.totalAmount}).` });
      }
      refundedAmount = fromMinor(minor);
    }
    const refundNote = typeof refundNoteRaw === 'string' ? sanitizeString(refundNoteRaw, 200) : '';
    // Atomic: only succeeds once, only on orders actually awaiting a refund.
    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, refundedAt: null, paymentIssue: { $in: ['REFUND_DUE', 'PAID_AFTER_CANCEL'] } },
      { $unset: { paymentIssue: 1 }, $set: { refundedAt: new Date(), refundedAmount, ...(refundNote ? { refundNote } : {}) } },
      { returnDocument: 'after' }
    );
    if (!order) {
      return res.status(409).json({ message: 'This order is not awaiting a refund, or it was already processed.' });
    }
    logAudit({
      actor: req.session.username,
      action: 'MARK_REFUNDED',
      targetId: order._id,
      targetType: 'Order',
      after: { refundedAmount, ...(refundNote ? { refundNote } : {}) },
      ip: req.ip
    });
    req.app.get('io').emit('orderUpdate');
    res.json(order);
  } catch (err) {
    console.error('Error marking refund:', err);
    res.status(500).json({ message: 'Failed to mark refund.' });
  }
});

// Server-side total over all orders: paid and not cancelled (see REVENUE_FILTER).
router.get('/revenue', requireAuth, requirePermission('order.view'), async (req, res) => {
  try {
    const [result] = await Order.aggregate([
      { $match: REVENUE_FILTER },
      { $group: {
        _id: null,
        totalRevenue: { $sum: { $round: [{ $multiply: ['$totalAmount', minorUnit()] }, 0] } },  // sum in whole minor units
        orderCount: { $sum: 1 }
      }}
    ]);
    const totalRevenueMinor = result ? result.totalRevenue : 0;

    const split = marketplace.enabled() ? await marketplace.revenueBreakdown() : null;

    res.json({
      totalRevenue: fromMinor(totalRevenueMinor),
      orderCount: result ? result.orderCount : 0,
      ...(split ? split : {})
    });
  } catch (err) {
    console.error('Error computing revenue:', err);
    res.status(500).json({ message: 'Failed to compute revenue.' });
  }
});

router.get('/audit-log', requireAuth, requirePermission('audit.view'), async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const skip  = (page - 1) * limit;

    const filter = {};
    // Repeated query parameters arrive as arrays; only plain text is a filter.
    const text = (v) => (typeof v === 'string' && v ? v : null);
    if (text(req.query.action))     filter.action = text(req.query.action).toUpperCase();
    if (text(req.query.targetType)) filter.targetType = text(req.query.targetType);
    if (text(req.query.actor))      filter.actor = text(req.query.actor);

    const [entries, total] = await Promise.all([
      AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AuditLog.countDocuments(filter)
    ]);

    res.json({
      entries,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (err) {
    console.error('Error fetching audit log:', err);
    res.status(500).json({ message: 'Failed to fetch audit log.' });
  }
});

// Checks the signed-in admin's own password again (used before a sensitive
// change such as turning two-factor login off).
async function verifyOwnPassword(req, password) {
  if (typeof password !== 'string' || !password) return false;
  let hash = ADMIN_PASSWORD_HASH;
  if (req.session.source === 'staff') {
    const account = await findStaffAccount(req.session.username);
    if (!account) return false;
    hash = account.passwordHash;
  }
  if (typeof hash !== 'string' || !hash) return false;
  return bcrypt.compare(password, hash);
}

require('./adminExtras')(router, { requireAuth, requireCsrf, requirePermission, getAccessContext, verifyOwnPassword });

module.exports = router;
