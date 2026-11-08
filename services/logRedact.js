'use strict';

// Access logs must never hold a secret.
const SECRET_QUERY = /([?&][^=&\s]*(?:token|secret|key|password|pass|signature|sig|otp|code|tran_id|tx_ref|transaction_id|session_id)[^=&\s]*=)[^&\s]*/gi;

function redactUrl(url) {
  return String(url || '').replace(SECRET_QUERY, '$1[redacted]');
}

module.exports = { redactUrl, SECRET_QUERY };
