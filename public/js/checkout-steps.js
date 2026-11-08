// Two-step cart drawer: step 1 = cart lines, step 2 = details/payment/coupon.
// It only shows and hides parts of the existing form. Ids, fields and placeOrder are untouched.
(function () {
  'use strict';
  var modal = document.getElementById('cartModal'), form = document.getElementById('checkoutForm'), items = document.getElementById('cartItems');
  if (!modal || !form || !items) return;
  var bar = document.createElement('div');
  bar.className = 'ui-steps-bar';
  bar.innerHTML = '<div class="d-flex justify-content-between fw-bold mb-3"><span>Total:</span><span class="ui-sum-total"></span></div>' +
    '<button type="button" class="btn btn-primary w-100 ui-next"><span>Checkout</span> <i class="bi bi-arrow-right"></i></button>';
  items.insertAdjacentElement('afterend', bar);
  var back = document.createElement('div');
  back.className = 'col-12 ui-back-wrap';
  back.innerHTML = '<button type="button" class="btn btn-outline-secondary btn-sm ui-back"><i class="bi bi-arrow-left"></i> <span>Back</span></button>';
  form.insertBefore(back, form.firstChild);

  function step(n) { modal.setAttribute('data-step', String(n)); }
  function refresh() {
    var has = !!items.querySelector('.cart-row'), total = document.getElementById('cartTotal');
    bar.querySelector('.ui-next').disabled = !has;
    bar.querySelector('.ui-sum-total').textContent = total ? total.textContent : '';
    if (!has) step(1);
  }
  bar.querySelector('.ui-next').addEventListener('click', function () { step(2); form.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  back.querySelector('.ui-back').addEventListener('click', function () { step(1); });
  modal.addEventListener('show.bs.modal', function () { step(1); refresh(); });
  var obs = new MutationObserver(refresh);
  obs.observe(items, { childList: true, subtree: true });
  var tot = document.getElementById('cartTotal'); if (tot) obs.observe(tot, { childList: true, characterData: true, subtree: true });
  step(1); refresh();
})();
