'use strict';

const AuditLog = require('../models/AuditLog');

// Audit entries are kept for a long time, so pictures (data: URIs) and very long text are replaced by a short note.
function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (value.startsWith('data:')) return `[image data omitted, ${value.length} characters]`;
    return value.length > 1000 ? `${value.slice(0, 1000)}... [${value.length} characters]` : value;
  }
  if (typeof value !== 'object' || depth > 6) return value;
  if (typeof value.toObject === 'function') value = value.toObject();
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = redact(v, depth + 1);
  return out;
}

async function logAudit(details) {
  try {
    const { actor, action, targetId, targetType, before, after, ip } = details || {};
    if (!actor || !action) return;

    await AuditLog.create({
      actor: String(actor),
      action: String(action),
      targetId: targetId ? String(targetId) : null,
      targetType: targetType ? String(targetType) : null,
      before: redact(before) || null,
      after: redact(after) || null,
      ip: ip ? String(ip) : null
    });
  } catch (err) {
    console.error('[AuditLog Error]', err.message);
  }
}

module.exports = {
  logAudit,
  redact
};
