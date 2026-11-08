// Payment-failed page: explains why, using the reason the server put in the address.
(function () {
  const params = new URLSearchParams(window.location.search);
  const reason = params.get('reason');
  const messages = {
    payment_failed:    'Your payment was declined. Your cart has been kept: please try again or choose a different payment method.',
    cancelled:         'You cancelled the payment, so no order was placed. Your cart has been kept so you can try again.',
    validation_failed: 'We could not verify your payment. If money was taken from you, please contact us with your transaction ID.',
    invalid_status:    'We received an invalid payment status. Your cart has been kept; please try again.',
    server_error:      'A server error occurred. Your cart has been kept; please try again in a moment.',
    paid_late:         'We received your payment, but your order had already expired. Please contact us with the transaction ID below and we will confirm your order or refund you.'
  };
  if (reason && Object.prototype.hasOwnProperty.call(messages, reason)) {
    document.getElementById('reasonText').textContent = messages[reason];
  }
  if (reason === 'paid_late') {
    document.getElementById('pageTitle').textContent = 'Payment Received';
    const tran = params.get('tran_id');
    if (tran) {
      const p = document.createElement('p');
      p.className = 'small text-muted';
      const label = document.createElement('span'); label.textContent = 'Transaction ID:';
      const val = document.createElement('span'); val.setAttribute('translate', 'no'); val.textContent = tran;
      p.append(label, ' ', val);
      document.getElementById('reasonText').after(p);
    }
  }
})();
