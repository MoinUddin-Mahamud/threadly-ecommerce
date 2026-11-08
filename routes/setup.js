// First-run setup: creates the owner account from the browser. It works only while no admin exists.
// SETUP_TOKEN is required unless this is a plain local run (see tokenRequired).
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const Admin = require('../models/Admin');
const SetupLock = require('../models/SetupLock');
const sameOrigin = require('../middleware/sameOrigin');
const { SUPER_ROLE } = require('../services/permissions');
const { passwordProblem } = require('../services/passwordRules');
const { adminEnvState } = require('../services/adminEnv');

const LOCK_ID = 'owner';
const STALE_LOCK_MS = 5 * 60 * 1000;

const sha = (v) => crypto.createHash('sha256').update(String(v || '')).digest();

function isLocalBaseUrl(raw) {
  try {
    const host = new URL(String(raw || '').trim()).hostname;
    return host === 'localhost' || host === '127.0.0.1';
  } catch (e) { return false; }
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1)$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

// True only for a request that clearly comes straight from this machine: no proxy headers, a local
// Host header and a loopback socket address.
function requestIsLocal(req) {
  if (!req) return false;
  const h = req.headers || {};
  if (h['x-forwarded-for'] || h['forwarded'] || h['x-forwarded-host'] || h['x-real-ip']) return false;
  let host = String(h.host || '').toLowerCase();
  host = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.replace(/:\d+$/, '');
  if (!LOCAL_HOSTS.has(host)) return false;
  const addr = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  return LOOPBACK.test(addr);
}

// The token is optional only for a local run: not production, BASE_URL is localhost, no reverse
// proxy is configured, and (when a request is given) the request itself comes from this machine.
// A SETUP_TOKEN that is set is always checked.
function tokenRequired(env = process.env, req) {
  const proxied = Number(env.TRUST_PROXY || 0) > 0;
  const local = env.NODE_ENV !== 'production' && isLocalBaseUrl(env.BASE_URL) && !proxied &&
    (req === undefined || requestIsLocal(req));
  return !local || Boolean(env.SETUP_TOKEN);
}
const tokenUsable = (env = process.env) => String(env.SETUP_TOKEN || '').length >= 16;

async function setupNeeded() {
  if (adminEnvState(process.env).state !== 'absent') return false;
  return !(await Admin.findOne({}));
}

// Takes the claim, or returns false when another process holds it. A claim older than
// STALE_LOCK_MS belongs to a process that died before it could release it.
async function claimOwner() {
  const attempt = async () => {
    try { await SetupLock.create({ _id: LOCK_ID }); return true; }
    catch (e) { if (e && e.code === 11000) return false; throw e; }
  };
  if (await attempt()) return true;
  const gone = await SetupLock.deleteOne({ _id: LOCK_ID, createdAt: { $lt: new Date(Date.now() - STALE_LOCK_MS) } });
  return gone && gone.deletedCount ? attempt() : false;
}

function createSetupRouter() {
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
  const router = express.Router();
  let creating = false;

  router.get('/status', limiter, async (req, res) => {
    try {
      const required = tokenRequired(process.env, req);
      res.json({ needed: await setupNeeded(), tokenRequired: required, tokenMissing: required && !tokenUsable() });
    } catch (e) { res.status(500).json({ needed: false }); }
  });

  router.post('/', limiter, sameOrigin, async (req, res) => {
    const body = req.body || {};
    if (tokenRequired(process.env, req)) {
      if (!tokenUsable()) return res.status(503).json({ success: false, message: 'Set SETUP_TOKEN (16 or more characters) in the environment and restart.' });
      if (!crypto.timingSafeEqual(sha(body.setupToken), sha(process.env.SETUP_TOKEN))) {
        return res.status(403).json({ success: false, message: 'Wrong setup token.' });
      }
    }
    if (creating) return res.status(409).json({ success: false, message: 'Setup is already running. Try again in a moment.' });
    creating = true; // set before any await; only this request clears it
    try {
      if (!(await setupNeeded())) return res.status(404).json({ success: false, message: 'Setup is already complete.' });
      const username = String(body.username || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
        return res.status(400).json({ success: false, message: 'Username: 3-32 characters (letters, numbers, . _ -).' });
      }
      const problem = passwordProblem(body.password);
      if (problem) return res.status(400).json({ success: false, message: problem });
      const passwordHash = await bcrypt.hash(String(body.password), 12);

      if (!(await claimOwner())) return res.status(409).json({ success: false, message: 'Another owner was created first.' });
      try {
        await Admin.create({ username, passwordHash, roles: [SUPER_ROLE], role: 'owner', active: true });
      } catch (e) {
        await SetupLock.deleteOne({ _id: LOCK_ID }).catch(() => {});
        throw e;
      }
      return res.status(201).json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, message: 'Could not finish setup.' });
    } finally { creating = false; }
  });

  return router;
}

module.exports = { router: createSetupRouter(), createSetupRouter, setupNeeded, tokenRequired, requestIsLocal, isLocalBaseUrl, LOCK_ID };
