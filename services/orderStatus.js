'use strict';

// Which status changes an admin may make by hand.

const TRANSITIONS = {
  PENDING:   ['CANCELLED'],
  PLACED:    ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['SHIPPED', 'CANCELLED'],
  SHIPPED:   ['DELIVERED', 'CANCELLED'],
  DELIVERED: ['CANCELLED'],
  CANCELLED: ['PLACED', 'CONFIRMED']
};

const OFFLINE_GATEWAYS = ['cod', 'manual'];

// The statuses `order` may be moved to by an admin.
function allowedNextStatuses(order) {
  // A payment the gateway flagged as risky leaves the order PENDING for staff to check: they may
  // confirm it.
  if (order.status === 'PENDING' && order.paymentIssue === 'PAYMENT_UNCONFIRMED') return ['CONFIRMED', 'CANCELLED'];
  const base = TRANSITIONS[order.status] || [];
  if (order.status !== 'CANCELLED') return base;
  const offline = OFFLINE_GATEWAYS.includes(order.paymentGateway);
  const paid = !!order.paidAt;
  // A cancelled online order that was never paid has nothing to reopen.
  if (!offline && !paid) return [];
  // Offline orders go back to PLACED (awaiting confirmation) or CONFIRMED;
  // a paid online order can only go back to CONFIRMED.
  return offline ? base : ['CONFIRMED'];
}

function canTransition(order, next) {
  return allowedNextStatuses(order).includes(next);
}

module.exports = { TRANSITIONS, allowedNextStatuses, canTransition };
