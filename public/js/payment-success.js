// Payment-success page: the same page serves a confirmed online payment, a Cash
// on Delivery order and a manual-payment (bank / mobile transfer) order.
(function () {
  const params = new URLSearchParams(window.location.search);
  const tranId = params.get('tran_id');
  const orderId = params.get('order_id');
  const $ = (id) => document.getElementById(id);

  // Every real redirect here carries a transaction id. Without one this is not a
  // finished order (someone opened the page by hand), so show nothing and leave
  // the cart alone.
  if (!tranId) {
    window.location.replace('/');
    return;
  }
  $('tranId').textContent = tranId;
  const money = (n) => (window.TLMoney ? window.TLMoney.format(Number(n)) : Number(n).toFixed(2));

  // The order is placed (or paid), so the cart is emptied now, and not before.
  function clearCart() {
    try { localStorage.removeItem('threadly_cart'); } catch (e) { /* storage blocked */ }
    try { sessionStorage.removeItem('threadly_checkout'); } catch (e) { /* storage blocked */ }
  }

  function showManual() {
    $('manualBox').classList.remove('d-none');
    fetch('/api/payment-options').then((r) => r.json()).then((o) => {
      const m = (o && o.manual) || {};
      const box = $('manualInstructions');
      box.textContent = '';
      // One element per line, so each line is translated on its own.
      [m.hours ? 'Please pay within ' + m.hours + ' hours and send us your payment reference below, or the order is cancelled automatically.' : '', m.instructions || '']
        .filter(Boolean).forEach((line, i) => {
          const d = document.createElement('div');
          if (i === 1 || !m.hours) d.setAttribute('translate', 'no');   // the store's own words
          d.textContent = line; d.style.whiteSpace = 'pre-line'; box.appendChild(d);
        });
    }).catch(() => { $('manualInstructions').textContent = 'We will email you how to pay.'; });

    $('referenceForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const msg = $('referenceMsg');
      msg.className = 'small mt-2 text-muted';
      msg.textContent = 'Sending\u2026';
      fetch('/api/orders/' + encodeURIComponent(orderId || '') + '/payment-reference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentReference: $('paymentReference').value.trim(), transactionId: tranId })
      }).then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.message || 'Could not save the reference.');
        msg.className = 'small mt-2 text-success';
        msg.textContent = 'Thank you. We have your payment reference.';
      }).catch((err) => { msg.className = 'small mt-2 text-danger'; msg.textContent = err.message; });
    });
  }

  // What this page says comes from the SERVER, not from the address bar: anyone can type any
  // address, and the page must not tell a visitor "payment received" for a transaction the shop
  // has never heard of.
  fetch('/api/payment/status?tran_id=' + encodeURIComponent(tranId))
    .then(async (r) => {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('status');
      return r.json();
    })
    .then((order) => {
      if (!order || !order.found) {
        // Not an order of this shop: show nothing about it and leave the cart alone.
        window.location.replace('/');
        return;
      }
      if (Number.isFinite(Number(order.amount))) {
        $('amountPaid').textContent = money(order.amount);
        document.addEventListener('brand:ready', () => { $('amountPaid').textContent = money(order.amount); });
      }

      if (order.status === 'CANCELLED') {
        document.title = 'Order cancelled';
        $('heading').textContent = 'This order was cancelled';
        $('message').textContent = 'This order is no longer active. If you paid, please contact us with the transaction ID below and we will sort it out.';
        $('amountLabel').textContent = 'Order total';
        return;   // the cart is left alone
      }
      if (order.gateway === 'cod') {
        document.title = 'Order Placed';
        $('heading').textContent = 'Order Placed!';
        $('message').textContent = 'Your order has been placed. We will confirm it shortly. Please pay the amount below in cash when it is delivered.';
        $('amountLabel').textContent = 'Amount to Pay on Delivery';
        clearCart();
      } else if (order.gateway === 'manual') {
        document.title = 'Order Placed';
        $('heading').textContent = 'Order Placed!';
        $('message').textContent = 'Your order is reserved. Please send the payment below; we confirm the order once we have checked it.';
        $('amountLabel').textContent = 'Amount to Send';
        clearCart();
        showManual();
      } else if (order.underReview) {
        // The gateway took the payment but flagged it as risky: staff check it before the order is
        // confirmed.
        document.title = 'Payment received';
        $('heading').textContent = 'Payment received';
        $('message').textContent = 'Your payment was received and is being checked by our team. We will confirm your order by email shortly. Please keep your transaction ID.';
        clearCart();
      } else if (order.status === 'PENDING') {
        // Redirected here, but the gateway has not confirmed the payment to the shop yet.
        document.title = 'Confirming your payment';
        $('heading').textContent = 'Confirming your payment';
        $('message').textContent = 'We have not received the final confirmation from the payment provider yet. This usually takes a minute. Please keep your transaction ID and refresh this page shortly; you will get an email once it is confirmed.';
        $('amountLabel').textContent = 'Order total';
      } else {
        clearCart();
      }
    })
    .catch(() => {
      // The check itself failed (offline, server busy). Say so rather than claim success, and keep
      // the cart.
      $('heading').textContent = 'We could not check your order';
      $('message').textContent = 'Please keep your transaction ID and refresh this page. If you paid, you will also get an email once the order is confirmed.';
    });
})();
