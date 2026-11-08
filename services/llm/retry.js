'use strict';

// Retry helpers shared by every chatbot provider.

// A failure that usually passes by itself: a timeout, or a busy / overloaded provider.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

// Retry-After is either a number of seconds or a date. Capped so a huge value cannot hold a
// customer.
function parseRetryAfter(header, now = Date.now()) {
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(10000, Math.max(0, seconds * 1000));
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.min(10000, Math.max(0, when - now)) : 0;
}

// How long to wait for a 0-based retry number: 500 ms, 1 s, 2 s ... plus up to 250 ms of jitter,
// and never less than the provider's Retry-After.
function retryDelayMs(retryNumber, retryAfterMs = 0, baseMs = 500, random = Math.random) {
  const backoff = baseMs * 2 ** retryNumber + Math.floor(random() * Math.max(1, baseMs / 2));
  return Math.max(backoff, retryAfterMs);
}

module.exports = { RETRYABLE_STATUS, parseRetryAfter, retryDelayMs };
