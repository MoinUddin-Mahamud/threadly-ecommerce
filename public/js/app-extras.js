// Storefront extras: wishlist and shipping fee display.
(function () {
  const esc = (v) => escapeHtml(String(v === undefined || v === null ? '' : v));

  // Browser storage can be blocked (private mode); the page must work without it.
  function store(key, value) {
    try {
      if (value === undefined) return window.localStorage.getItem(key);
      window.localStorage.setItem(key, value);
    } catch (e) { /* ignore */ }
    return null;
  }

  const GUEST_KEY = 'threadly_wishlist';
  const ID_RE = /^[0-9a-fA-F]{24}$/;
  let wishIds = new Set();
  let productsById = {};

  function readGuestIds() {
    try {
      const list = JSON.parse(store(GUEST_KEY) || '[]');
      return Array.isArray(list) ? list.filter((id) => typeof id === 'string' && ID_RE.test(id)).slice(0, 200) : [];
    } catch (e) { return []; }
  }
  const saveGuestIds = () => store(GUEST_KEY, JSON.stringify([...wishIds]));

  function paintHearts() {
    $('.wishlist-heart').each(function () {
      const on = wishIds.has(String($(this).attr('data-product-id')));
      $(this).attr('aria-pressed', on ? 'true' : 'false').attr('title', on ? 'Remove from wishlist' : 'Save to wishlist')
        .find('i').toggleClass('bi-heart-fill', on).toggleClass('bi-heart', !on);
    });
    const n = wishIds.size;
    $('#wishlistCount').text(n).toggleClass('d-none', n === 0);
  }

  window.addWishlistHeart = function (col, product) {
    const holder = col.find('.position-relative').first();
    if (!holder.length) return;
    const id = String(product._id);
    const btn = $('<button type="button" class="btn btn-light btn-sm rounded-circle wishlist-heart position-absolute top-0 start-0 m-2"><i class="bi bi-heart"></i></button>')
      .attr('data-product-id', id).attr('aria-label', 'Save to wishlist');
    btn.on('click', (e) => { e.preventDefault(); toggleWish(id); });
    holder.append(btn);
    paintHearts();
  };

  function toggleWish(id) {
    const adding = !wishIds.has(id);
    if (!currentUser) {   // guest: kept in this browser only
      if (adding) {
        if (wishIds.size >= 200) { showNotification('Your wishlist is full (200 products).', 'error'); return; }
        wishIds.add(id);
      } else { wishIds.delete(id); }
      saveGuestIds();
      paintHearts();
      showNotification(adding ? 'Saved to your wishlist. Log in to keep it on every device.' : 'Removed from your wishlist.', 'info');
      return;
    }
    // Logged in: update at once, undo if the server says no
    if (adding) wishIds.add(id); else wishIds.delete(id);
    paintHearts();
    fetch(adding ? '/api/users/wishlist' : `/api/users/wishlist/${id}`, {
      method: adding ? 'POST' : 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: adding ? JSON.stringify({ productId: id }) : undefined
    }).then(async (r) => {
      if (!r.ok) { let m = {}; try { m = await r.json(); } catch (e) { /* not JSON */ } throw new Error(m.message || 'Could not update your wishlist.'); }
      showNotification(adding ? 'Saved to your wishlist.' : 'Removed from your wishlist.', 'info');
      if ($('#wishlistModal').hasClass('show')) drawWishlist();
    }).catch((err) => {
      if (adding) wishIds.delete(id); else wishIds.add(id);
      paintHearts();
      showNotification(err.message, 'error');
    });
  }

  // After login: add what the visitor saved as a guest, then use the server's list.
  window.onShopLogin = function () {
    const guest = readGuestIds();
    const merge = guest.length
      ? fetch('/api/users/wishlist/merge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: guest }) }).catch(() => null)
      : Promise.resolve(null);
    merge.then(() => fetch('/api/users/wishlist'))
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        wishIds = new Set((data.ids || []).map(String));
        store(GUEST_KEY, '[]');
        paintHearts();
      }).catch(() => {});
  };
  window.onShopLogout = function () {
    wishIds = new Set(readGuestIds());
    paintHearts();
  };
  window.onProductsLoaded = function (products) {
    productsById = {};
    products.forEach((p) => { productsById[String(p._id)] = p; });
    if (!currentUser) wishIds = new Set(readGuestIds());
    // a product that no longer exists drops out of a guest's list
    paintHearts();
    if ($('#wishlistModal').hasClass('show')) drawWishlist();
  };

  function drawWishlist() {
    const body = $('#wishlistBody').empty();
    const items = [...wishIds].map((id) => productsById[id]).filter(Boolean);
    if (items.length === 0) {
      body.html('<p class="text-muted text-center py-4"><i class="bi bi-heart fs-1 d-block mb-2"></i>Your wishlist is empty. Tap the heart on an item to save it.</p>');
      return;
    }
    if (!currentUser) {
      body.append('<div class="alert alert-info small">This list is saved in this browser only. <a href="#" id="wishlistLoginLink">Log in</a> to keep it on every device.</div>');
    }
    items.forEach((p) => {
      const out = p.stock <= 0;
      const row = $(`
        <div class="wishlist-row">
          <a href="/product/${esc(p._id)}"><img src="${esc(p.imageUrl || '/img/logo.svg')}" alt="" data-fallback-src="/img/logo.svg"></a>
          <div class="flex-grow-1">
            <a href="/product/${esc(p._id)}" class="fw-semibold text-decoration-none text-reset">${esc(p.title)}</a>
            <div class="text-muted small">${esc(formatMoney(p.price))}${out ? ' - <span class="text-danger">Out of stock</span>' : ''}</div>
          </div>
          <select class="form-select form-select-sm wish-size" style="max-width:100px;" aria-label="Size">
            <option value="">Size</option>${sizeOptionsHtml(p)}
          </select>
          <button type="button" class="btn btn-primary btn-sm wish-add" ${out ? 'disabled' : ''}><i class="bi bi-cart-plus"></i></button>
          <button type="button" class="btn btn-outline-danger btn-sm wish-remove" aria-label="Remove"><i class="bi bi-trash"></i></button>
        </div>`);
      row.find('.wish-add').on('click', () => addToCart(p, 1, row.find('.wish-size').val() || null));
      row.find('.wish-remove').on('click', () => { toggleWish(String(p._id)); if (!currentUser) drawWishlist(); });
      body.append(row);
    });
  }

  let shipping = { enabled: false };
  const normCity = (c) => String(c || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

  // The same rules as quoteShipping() in services/shipping.js. The server works
  // out the fee itself and refuses the order if this number is different.
  // Money is compared in the smallest unit of the shop currency (a hundredth, or 1 or a thousandth).
  const unit = () => Math.pow(10, window.TLMoney ? window.TLMoney.decimals() : 2);
  window.currentShippingFee = function (goods, city) {
    if (!shipping.enabled || !(goods > 0)) return 0;
    if (shipping.freeOver > 0 && Math.round(goods * unit()) >= Math.round(shipping.freeOver * unit())) return 0;
    const wanted = normCity(city);
    const isHome = shipping.homeRate !== null && shipping.homeRate !== undefined && wanted !== '' && wanted === normCity(shipping.homeCity);
    return isHome ? shipping.homeRate : shipping.flatRate;
  };

  window.updateShippingDisplay = function () {
    const row = $('#cartShippingRow');
    if (!shipping.enabled || cartIsEmpty) { row.addClass('d-none'); return; }
    const goods = appliedCoupon ? appliedCoupon.total : lastCartTotal;
    const fee = window.currentShippingFee(goods, $('#deliveryCity').val());
    row.removeClass('d-none');
    $('#cartShipping').text(fee > 0 ? formatMoney(fee) : 'Free');
    let note = '';
    if (shipping.freeOver > 0 && fee > 0) {
      const left = Math.round((shipping.freeOver - goods) * unit()) / unit();
      if (left > 0) note = `Add ${formatMoney(left)} more for free shipping.`;
    }
    $('#cartShippingNote').text(note);
    $('#cartTotal').text(formatMoney(goods + fee));
  };

  $(function () {
    wishIds = new Set(readGuestIds());
    paintHearts();

    $('#viewWishlistLink').on('click', function (e) {
      e.preventDefault();
      drawWishlist();
      bootstrap.Modal.getOrCreateInstance('#wishlistModal').show();
    });
    $(document).on('click', '#wishlistLoginLink', function (e) {
      e.preventDefault();
      bootstrap.Modal.getInstance('#wishlistModal').hide();
      bootstrap.Modal.getOrCreateInstance('#authModal').show();
    });

    fetch('/api/shipping-options').then((r) => (r.ok ? r.json() : null)).then((data) => {
      if (data && data.enabled) { shipping = data; window.updateShippingDisplay(); }
    }).catch(() => {});
    $('#deliveryCity').on('input', window.updateShippingDisplay);

    // Footer contact block: shown only for the details set in .env (no placeholder text).
    fetch('/api/site-info').then((r) => (r.ok ? r.json() : null)).then((info) => {
      if (!info) return;
      const list = $('#footerContactList').empty();
      const add = (icon, text, href) => {
        if (!text) return;
        const li = $('<li></li>').append($('<i class="bi me-2"></i>').addClass(icon));
        li.append(href ? $('<a></a>').attr('href', href).text(text) : document.createTextNode(text));
        list.append(li);
      };
      add('bi-envelope', info.supportEmail, info.supportEmail ? 'mailto:' + info.supportEmail : '');
      add('bi-telephone', info.supportPhone, info.supportPhone ? 'tel:' + info.supportPhone.replace(/[^0-9+]/g, '') : '');
      add('bi-geo-alt', info.supportAddress, '');
      $('#footerContact').toggleClass('d-none', list.children().length === 0);
    }).catch(() => {});

  });
})();


// Passwords: forgot, reset (emailed link) and change
// The server does all the checking; this only collects the fields and shows the answer.
(function () {
  const $ = window.jQuery;
  if (!$) return;

  function msg(text, ok) {
    $('#passwordMsg').removeClass('d-none alert-success alert-danger').addClass('alert ' + (ok ? 'alert-success' : 'alert-danger')).text(text);
  }
  function show(which, title) {
    $('#passwordMsg').addClass('d-none').text('');
    $('#pwForgot, #pwReset, #pwChange').addClass('d-none');
    $('#' + which).removeClass('d-none');
    $('#passwordModalTitle').text(title);
    bootstrap.Modal.getOrCreateInstance(document.getElementById('passwordModal')).show();
  }
  async function post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let data = {};
    try { data = await r.json(); } catch (e) { /* not JSON */ }
    if (!r.ok) throw new Error(data.message || 'Something went wrong. Please try again.');
    return data;
  }
  const tooLong = (p) => new TextEncoder().encode(p).length > 72;
  function checkNew(p, again) {
    if (p.length < 8) return 'Password must be at least 8 characters.';
    if (tooLong(p)) return 'Password must be at most 72 bytes (about 72 letters and digits).';
    if (p !== again) return 'The two passwords do not match.';
    return null;
  }

  $(document).on('click', '#forgotPasswordLink', function (e) {
    e.preventDefault();
    const modal = bootstrap.Modal.getInstance(document.getElementById('authModal'));
    if (modal) modal.hide();
    $('#pwForgotEmail').val($('#loginEmail').val() || '');
    show('pwForgot', 'Forgot your password?');
  });
  $(document).on('click', '#navChangePassword', function (e) {
    e.preventDefault();
    $('#pwChangeCurrent, #pwChangeNew, #pwChangeConfirm').val('');
    show('pwChange', 'Change password');
  });

  $('#pwForgotSubmit').on('click', async function () {
    const email = $('#pwForgotEmail').val().trim();
    if (!email) return msg('Enter your email address.', false);
    const btn = $(this).prop('disabled', true);
    try { msg((await post('/api/users/forgot-password', { email })).message, true); }
    catch (err) { msg(err.message, false); }
    finally { btn.prop('disabled', false); }
  });

  $('#pwResetSubmit').on('click', async function () {
    const p = $('#pwResetNew').val();
    const problem = checkNew(p, $('#pwResetConfirm').val());
    if (problem) return msg(problem, false);
    const btn = $(this).prop('disabled', true);
    try {
      const out = await post('/api/users/reset-password', { token: window.__resetToken, password: p });
      msg(out.message, true);
      $('#pwResetNew, #pwResetConfirm').val('');
      window.__resetToken = null;
    } catch (err) { msg(err.message, false); }
    finally { btn.prop('disabled', false); }
  });

  $('#pwChangeSubmit').on('click', async function () {
    const problem = checkNew($('#pwChangeNew').val(), $('#pwChangeConfirm').val());
    if (!$('#pwChangeCurrent').val()) return msg('Enter your current password.', false);
    if (problem) return msg(problem, false);
    const btn = $(this).prop('disabled', true);
    try {
      msg((await post('/api/users/change-password', { currentPassword: $('#pwChangeCurrent').val(), newPassword: $('#pwChangeNew').val() })).message, true);
      $('#pwChangeCurrent, #pwChangeNew, #pwChangeConfirm').val('');
    } catch (err) { msg(err.message, false); }
    finally { btn.prop('disabled', false); }
  });

  // The emailed link opens the shop with #resetToken=... (browsers do not send the
  // fragment to the server, so the token stays out of access logs).
  $(function () {
    const params = new URLSearchParams(window.location.search);
    const fromHash = /(?:^#|&)resetToken=([a-f0-9]{64})(?:&|$)/.exec(window.location.hash);
    const token = fromHash ? fromHash[1] : params.get('resetToken');
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      window.__resetToken = token;
      params.delete('resetToken');
      const rest = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (rest ? '?' + rest : ''));
      show('pwReset', 'Choose a new password');
    }
  });
})();
