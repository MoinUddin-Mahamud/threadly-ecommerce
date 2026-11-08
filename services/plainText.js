'use strict';

// Product titles and shop names are shown in many places (pages, e-mails, invoices, the chatbot).
// They are stored as plain text: "<", ">" and control characters are removed when written, and
// every screen still escapes them when it shows them (older data may contain them).
function plainName(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/[<>\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// "Wool Coat (M) x2, Leather Belt x1": the size part is left out when an item has none
// (Accessories).
function itemSummary(items) {
  return (items || []).map((i) => `${i.title}${i.size ? ` (${i.size})` : ''} x${i.quantity}`).join(', ');
}

module.exports = { plainName, itemSummary };
