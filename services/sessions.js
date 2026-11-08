'use strict';

const mongoose = require('mongoose');

// Ends every login session of one customer (optionally keeping the one that is making the
// request), so a stolen session cannot outlive a password change or reset.
async function endUserSessions(store, userId, exceptSid) {
  const id = String(userId || '');
  if (!/^[a-f0-9]{24}$/i.test(id) || !store) return 0;
  try {
    if (store.collectionP) {
      const col = await store.collectionP;
      const filter = {
        $or: [
          { session: { $regex: '"userId":"' + id + '"' } },
          { 'session.userId': new mongoose.Types.ObjectId(id) },
          { 'session.userId': id }
        ]
      };
      if (exceptSid) filter._id = { $ne: exceptSid };
      const result = await col.deleteMany(filter);
      return (result && result.deletedCount) || 0;
    }
    if (typeof store.all === 'function' && typeof store.destroy === 'function') {
      const all = await new Promise((resolve) => store.all((err, sessions) => resolve(err ? null : sessions)));
      if (!all) return 0;
      const entries = Array.isArray(all) ? all.map((s) => [s && (s.id || s.sid), s]) : Object.entries(all);
      let n = 0;
      for (const [sid, sess] of entries) {
        if (!sess || String(sess.userId || '') !== id || sid === exceptSid) continue;
        await new Promise((resolve) => store.destroy(sid, () => resolve()));
        n += 1;
      }
      return n;
    }
  } catch (err) {
    console.error('Could not end the old sessions:', err && err.message);
  }
  return 0;
}

module.exports = { endUserSessions };
