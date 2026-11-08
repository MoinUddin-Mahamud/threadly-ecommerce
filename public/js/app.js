// Storefront: product list, search, cart, checkout and customer account.

const cartKey = 'threadly_cart';
const MAX_QTY_PER_ITEM = 10;   // keep in sync with MAX_QUANTITY_PER_LINE in routes/api.js
const socket = io();
// A picture that fails to load is replaced by the logo. This is one listener for
// the whole page, instead of an inline onerror attribute on every image.
document.addEventListener('error', (ev) => {
  const img = ev.target;
  if (img && img.tagName === 'IMG' && img.dataset && img.dataset.fallbackSrc && !img.dataset.fallbackUsed) {
    img.dataset.fallbackUsed = '1';
    img.src = img.dataset.fallbackSrc;
  }
}, true);
let allProducts = [];
let filteredProducts = [];
let currentUser = null;
let appliedCoupon = null;   // { code, subtotal, discount, total } exactly as the server worked
let couponRequestId = 0;    // only the newest answer from the server is used
let lastCartTotal = 0;      // cart total without a coupon (display only)

// Prices are shown as plain numbers: the store never shows a currency sign or code.
function formatMoney(amount) {
  // TLMoney (brand.js) knows how many decimals the shop's currency uses (0, 2 or 3).
  return window.TLMoney ? window.TLMoney.format(amount) : (Number(amount) || 0).toFixed(2);
}

let SIZES = [];   // loaded from the server (services/sizes.js)
fetch('/api/sizes').then((res) => (res.ok ? res.json() : { sizes: [] }))
  .then((data) => { if (Array.isArray(data.sizes)) SIZES = data.sizes; })
  .catch(() => {});

// Stars with the average and the number of reviews, only for products that have reviews.
function ratingHtml(p) {
  const count = Number(p && p.ratingCount);
  const avg = Number(p && p.ratingAverage);
  if (!(count > 0) || !(avg >= 1 && avg <= 5)) return '';
  // Stars to the nearest half: 4.5 shows four full stars and one half star, not five full ones.
  const halves = Math.round(avg * 2);
  const full = Math.floor(halves / 2);
  const half = halves % 2 === 1 ? 1 : 0;
  return `<div class="small mb-1" title="${escapeHtml(avg.toFixed(1))} out of 5"><span style="color:#d4af37" aria-hidden="true">${'\u2605'.repeat(full)}${half ? '<span class="tl-star-half">\u2605</span>' : ''}${'\u2606'.repeat(5 - full - half)}</span> <span class="text-muted">${escapeHtml(avg.toFixed(1))} (${escapeHtml(String(count))})</span></div>`;
}

// Products this customer has already reviewed (filled when "My orders" opens).
let myReviewedIds = new Set();
function loadMyReviewed() {
  return fetch('/api/users/my-reviews')
    .then((r) => (r.ok ? r.json() : { productIds: [] }))
    .then((d) => { myReviewedIds = new Set(d.productIds || []); })
    .catch(() => {});
}

// A product either has one stock number or, when its seller keeps stock per size, a sizeStock
// object such as { S: 4, M: 0 }.
function sizeKey(size) { return String(size).replace(/\s+/g, ''); }
function tracksSizes(p) { return !!p && !!p.sizeStock && typeof p.sizeStock === 'object' && Object.keys(p.sizeStock).length > 0; }
// Units a customer can still buy in this size (the whole stock for products without stock per
// size).
function availableFor(p, size) {
  if (!p) return 0;
  if (!tracksSizes(p)) return Number(p.stock) || 0;
  return Math.max(0, Number(p.sizeStock[sizeKey(size)]) || 0);
}
// The <option> list for a size menu.
function sizeOptionsHtml(p) {
  const list = tracksSizes(p) ? SIZES.filter((s) => sizeKey(s) in p.sizeStock) : SIZES;
  return list.map((s) => {
    const sold = tracksSizes(p) && availableFor(p, s) <= 0;
    return `<option value="${s}"${sold ? ' disabled' : ''}>${s}${sold ? ' (sold out)' : ''}</option>`;
  }).join('');
}

// The cart lives in localStorage, which can hold anything (an old format, a hand-edited value,
// nothing at all).
function getCart() {
  try {
    const raw = localStorage.getItem(cartKey);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(it => it && typeof it.productId === 'string' &&
      Number.isInteger(it.quantity) && it.quantity > 0 && Number.isFinite(Number(it.price)));
  } catch (e) {
    return [];
  }
}
function saveCart(items) {
  try { localStorage.setItem(cartKey, JSON.stringify(items)); } catch (e) { /* storage full or blocked */ }
  updateCartCount();
}
function updateCartCount() {
  const totalQty = getCart().reduce((sum, it) => sum + it.quantity, 0);
  $('#cartCount').text(totalQty);
}

function addToCart(product, qty = 1, size = null) {
  if (!size || !SIZES.includes(size)) {
    showNotification(`Please choose a size for ${product.title}.`, 'error');
    return false;
  }
  if (product.stock <= 0) {
    showNotification(`${product.title} is out of stock!`, 'error');
    return false;
  }
  const available = availableFor(product, size);   // units of this size when stock is kept per size
  if (available <= 0) {
    showNotification(`${product.title} is sold out in size ${size}.`, 'error');
    return false;
  }
  const cart = getCart();
  const cartKey2 = size ? `${product._id}_${size}` : product._id;
  const existing = cart.find(c => c.cartKey === cartKey2);
  if (existing) {
    const newQty = existing.quantity + qty;
    if (newQty > MAX_QTY_PER_ITEM) {
      showNotification(`You can order at most ${MAX_QTY_PER_ITEM} of one item.`, 'error');
      return false;
    }
    if (newQty > available) {
      showNotification(`Only ${available} available. You already have ${existing.quantity} in cart.`, 'error');
      return false;
    }
    existing.quantity = newQty;
  } else {
    if (qty > MAX_QTY_PER_ITEM) {
      showNotification(`You can order at most ${MAX_QTY_PER_ITEM} of one item.`, 'error');
      return false;
    }
    if (qty > available) {
      showNotification(`Only ${available} available in stock.`, 'error');
      return false;
    }
    cart.push({
      cartKey:   cartKey2,
      productId: product._id,
      title:     product.title,
      price:     product.price,
      quantity:  qty,
      stock:     available,
      size:      size || null
    });
  }
  saveCart(cart);
  showNotification(`${product.title}${size ? ` (${size})` : ''} added to cart!`, 'success');
  return true;
}

// The message is always plain text (product names and server messages can contain anything), so it
// is never parsed as HTML.
function showNotification(message, type = 'info', duration = 3000) {
  const cls  = type === 'success' ? 'alert-success' : type === 'error' ? 'alert-danger' : 'alert-info';
  const icon = type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-triangle' : 'info-circle';
  // Shown just below the sticky navbar so it never covers the menu or the cart button.
  const bar = document.querySelector('.navbar');
  const top = Math.max(8, bar ? Math.round(bar.getBoundingClientRect().bottom) + 8 : 16);
  const n = $(`
    <div class="alert ${cls} alert-dismissible fade show position-fixed start-50 translate-middle-x"
         style="z-index:9999;top:${top}px;min-width:300px;max-width:calc(100vw - 24px);" role="alert">
      <i class="bi bi-${icon} me-2"></i><span class="notification-text"></span>
      <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    </div>
  `);
  n.find('.notification-text').text(String(message));
  $('body').append(n);
  setTimeout(() => n.fadeOut(() => n.remove()), duration);
}

function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(text).replace(/[&<>"']/g, m => map[m]);
}

function checkAuthStatus() {
  fetch('/api/users/me')
    .then(r => r.ok ? r.json() : null)
    .then(user => { if (user) setLoggedIn(user); else setLoggedOut(); })
    .catch(() => setLoggedOut());
}

function setLoggedIn(user) {
  currentUser = user;
  $('#navLoginBtn').addClass('d-none');
  $('#navUserMenu').removeClass('d-none');
  $('#navUserName').text(user.name.split(' ')[0]);
  $('#customerName').val(user.name);
  $('#customerEmail').val(user.email);
  if (typeof window.onShopLogin === 'function') window.onShopLogin();   // wishlist sync (app-extras.js)
}

function setLoggedOut() {
  currentUser = null;
  $('#navLoginBtn').removeClass('d-none');
  $('#navUserMenu').addClass('d-none');
  $('#navUserName').text('Account');
  $('#customerName').val('');
  $('#customerEmail').val('');
}

function showAuthMsg(message, type = 'danger') {
  const cls = type === 'success' ? 'alert-success' : type === 'danger' ? 'alert-danger' : 'alert-info';
  $('#authMsg')
    .removeClass('d-none alert-success alert-danger alert-info')
    .addClass(`alert ${cls}`)
    .empty()
    .append($('<i>').addClass(`bi bi-${type === 'success' ? 'check-circle' : 'exclamation-triangle'} me-2`))
    .append(document.createTextNode(String(message)));
}

function clearAuthMsg() {
  $('#authMsg').addClass('d-none').removeClass('alert alert-success alert-danger alert-info').text('');
}

function switchAuthTab(tab) {
  clearAuthMsg();
  if (tab === 'login') {
    $('#loginForm').removeClass('d-none');
    $('#registerForm').addClass('d-none');
    $('#loginTabBtn').addClass('active text-white').removeClass('text-white-50');
    $('#registerTabBtn').removeClass('active text-white').addClass('text-white-50');
  } else {
    $('#registerForm').removeClass('d-none');
    $('#loginForm').addClass('d-none');
    $('#registerTabBtn').addClass('active text-white').removeClass('text-white-50');
    $('#loginTabBtn').removeClass('active text-white').addClass('text-white-50');
  }
}

function initAuth() {
  $('#loginTabBtn, #switchToLogin').on('click', (e) => { e.preventDefault(); switchAuthTab('login'); });
  $('#registerTabBtn, #switchToRegister').on('click', (e) => { e.preventDefault(); switchAuthTab('register'); });
  $('#authModal').on('show.bs.modal', () => { clearAuthMsg(); switchAuthTab('login'); });

  $(document).on('click', '.toggle-password', function () {
    const target = $('#' + $(this).data('target'));
    const isPassword = target.attr('type') === 'password';
    target.attr('type', isPassword ? 'text' : 'password');
    $(this).find('i').toggleClass('bi-eye bi-eye-slash');
  });

  $('#loginSubmitBtn').on('click', function () {
    const email    = $('#loginEmail').val().trim();
    const password = $('#loginPassword').val();
    if (!email || !password) { showAuthMsg('Please fill in all fields.'); return; }
    const btn = $(this);
    btn.prop('disabled', true).html('<span class="spinner-border spinner-border-sm me-2"></span>Logging in...');
    fetch('/api/users/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    })
    .then(async r => { const data = await r.json(); if (!r.ok) throw new Error(data.message || 'Login failed.'); return data; })
    .then(data => {
      setLoggedIn(data.user);
      bootstrap.Modal.getInstance('#authModal').hide();
      showNotification(`Welcome back, ${data.user.name.split(' ')[0]}!`, 'success');
      $('#loginEmail').val(''); $('#loginPassword').val('');
    })
    .catch(err => showAuthMsg(err.message))
    .finally(() => btn.prop('disabled', false).html('<i class="bi bi-box-arrow-in-right me-2"></i>Login'));
  });

  $('#registerSubmitBtn').on('click', function () {
    const name     = $('#registerName').val().trim();
    const email    = $('#registerEmail').val().trim();
    const password = $('#registerPassword').val();
    if (!name || !email || !password) { showAuthMsg('Please fill in all fields.'); return; }
    if (password.length < 8) { showAuthMsg('Password must be at least 8 characters.'); return; }
    const btn = $(this);
    btn.prop('disabled', true).html('<span class="spinner-border spinner-border-sm me-2"></span>Creating account...');
    fetch('/api/users/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password })
    })
    .then(async r => { const data = await r.json(); if (!r.ok) throw new Error(data.message || 'Registration failed.'); return data; })
    .then(data => {
      setLoggedIn(data.user);
      bootstrap.Modal.getInstance('#authModal').hide();
      showNotification(`Welcome to ${window.SITE_NAME || 'the store'}, ${data.user.name.split(' ')[0]}!` +
        (data.verificationEmailSent ? ' We emailed you a link to verify your address.' : ''), 'success',
        data.verificationEmailSent ? 8000 : 3000);
      $('#registerName').val(''); $('#registerEmail').val(''); $('#registerPassword').val('');
    })
    .catch(err => showAuthMsg(err.message))
    .finally(() => btn.prop('disabled', false).html('<i class="bi bi-person-check me-2"></i>Create Account'));
  });

  $('#navLogoutBtn').on('click', function (e) {
    e.preventDefault();
    fetch('/api/users/logout', { method: 'POST' })
      .then(() => { setLoggedOut(); if (typeof window.onShopLogout === 'function') window.onShopLogout(); showNotification('You have been logged out.', 'info'); })
      .catch(() => setLoggedOut());
  });

  $('#navMyOrders, #viewOrdersLink, #viewOrdersLinkFooter, #trackOrdersBtn').on('click', function (e) {
    e.preventDefault();
    openMyOrders();
  });

  // Ask for a new email-verification link (the button is drawn inside My Orders)
  $(document).on('click', '#resendVerifyBtn', function () {
    const btn = $(this);
    btn.prop('disabled', true);
    fetch('/api/users/resend-verification', { method: 'POST' })
      .then(r => r.json())
      .then(data => showNotification(data.message || 'Done.', data.sent === false ? 'error' : 'success'))
      .catch(() => showNotification('Could not send the email. Please try again.', 'error'))
      .finally(() => btn.prop('disabled', false));
  });
}

// Shows the logged-in customer's own orders, 10 at a time; guests are asked to log in.
let myOrdersShown = 0;

function appendOrderCards(body, orders) {
  orders.forEach(o => {
    const reviewable = o.status === 'DELIVERED'
      ? o.items.filter((i, n, all) => i.productId && !myReviewedIds.has(String(i.productId)) && all.findIndex((x) => String(x.productId) === String(i.productId)) === n)
      : [];
    const reviewButtons = reviewable.map((i) => `<button type="button" class="btn btn-sm btn-outline-secondary me-1 mb-1 review-open-btn" data-product-id="${escapeHtml(String(i.productId))}" data-title="${escapeHtml(i.title)}"><i class="bi bi-star me-1"></i>Review ${escapeHtml(i.title)}</button>`).join('');
    const itemsText = o.items.map(i => {
      const sizeTag = i.size ? ` <span class="badge bg-info text-dark">${escapeHtml(i.size)}</span>` : '';
      return `<span translate="no">${escapeHtml(i.title)}</span>${sizeTag} x${Number(i.quantity)} (${escapeHtml(formatMoney(i.price))})`;
    }).join(', ');
    body.append($(`
      <div class="border rounded p-3 mb-3 my-order-card">
        <div class="d-flex justify-content-between align-items-start mb-2">
          <div>
            <strong>${escapeHtml(new Date(o.createdAt).toLocaleDateString())}</strong>
            <div class="text-muted small">${escapeHtml(new Date(o.createdAt).toLocaleTimeString())}</div>
          </div>
          ${getStatusBadge(o.status)}
        </div>
        <div class="text-muted small mb-2">${itemsText}</div>
        <strong>Total: <span class="text-primary">${escapeHtml(formatMoney(o.totalAmount))}</span></strong>
        ${reviewButtons ? `<div class="mt-2 review-actions">${reviewButtons}</div>` : ''}
      </div>
    `));
  });
}

// "Review <product>" in My orders opens a small form under the order; it is sent to the server,
// which checks that an order with the product was delivered.
$(document).on('click', '.review-open-btn', function () {
  const card = $(this).closest('.my-order-card');
  card.find('.review-form').remove();
  const productId = String($(this).data('product-id'));
  const form = $(`
    <div class="review-form border rounded p-2 mt-2 bg-light">
      <div class="fw-semibold small mb-1"></div>
      <select class="form-select form-select-sm review-rating mb-1" aria-label="Rating">
        <option value="5">\u2605\u2605\u2605\u2605\u2605 Excellent</option>
        <option value="4">\u2605\u2605\u2605\u2605\u2606 Good</option>
        <option value="3">\u2605\u2605\u2605\u2606\u2606 Okay</option>
        <option value="2">\u2605\u2605\u2606\u2606\u2606 Poor</option>
        <option value="1">\u2605\u2606\u2606\u2606\u2606 Bad</option>
      </select>
      <textarea class="form-control form-control-sm review-text mb-1" rows="2" maxlength="1000" placeholder="Your review (optional)"></textarea>
      <button type="button" class="btn btn-sm btn-primary review-send-btn">Send review</button>
      <button type="button" class="btn btn-sm btn-link review-cancel-btn">Cancel</button>
      <span class="small ms-2 review-msg" role="status"></span>
    </div>`);
  form.find('.fw-semibold').text('Your review of ' + String($(this).data('title')));
  form.data('product-id', productId);
  card.append(form);
});
$(document).on('click', '.review-cancel-btn', function () { $(this).closest('.review-form').remove(); });
$(document).on('click', '.review-send-btn', function () {
  const form = $(this).closest('.review-form');
  const msg = form.find('.review-msg');
  const btn = $(this).prop('disabled', true);
  fetch(`/api/users/products/${encodeURIComponent(form.data('product-id'))}/reviews`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rating: Number(form.find('.review-rating').val()), text: form.find('.review-text').val() })
  })
    .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
    .then(({ ok, d }) => {
      if (!ok) { msg.removeClass('text-success').addClass('text-danger').text(d.message || 'Could not send your review.'); btn.prop('disabled', false); return; }
      myReviewedIds.add(String(form.data('product-id')));
      form.replaceWith('<div class="small text-success mt-2">Thank you for your review!</div>');
    })
    .catch(() => { msg.addClass('text-danger').text('Could not send your review.'); btn.prop('disabled', false); });
});

function loadMyOrdersPage(page) {
  const body = $('#myOrdersBody');
  return (page === 1 ? loadMyReviewed() : Promise.resolve()).then(() => fetch(`/api/users/my-orders?page=${page}&limit=10`))
    .then(r => r.json())
    .then(data => {
      const orders = data.orders || [];
      body.find('.my-orders-more, .my-orders-count').remove();

      if (page === 1) {
        body.empty();
        // Guest orders only show up once the customer has proven the email is theirs
        if (data.emailVerified === false) {
          body.append(`
            <div class="alert alert-warning d-flex justify-content-between align-items-center small">
              <span><i class="bi bi-envelope-exclamation me-2"></i>Verify your email address to see orders you placed as a guest.</span>
              <button type="button" class="btn btn-sm btn-dark ms-3 text-nowrap" id="resendVerifyBtn">Send link</button>
            </div>`);
        }
        myOrdersShown = 0;
        if (orders.length === 0) {
          body.append('<p class="text-muted text-center py-4"><i class="bi bi-bag-x fs-1 d-block mb-2"></i>You have no orders yet.</p>');
          return;
        }
      }

      appendOrderCards(body, orders);
      myOrdersShown += orders.length;
      const total = data.pagination ? data.pagination.total : myOrdersShown;
      body.prepend($(`<p class="text-muted small mb-3 my-orders-count">Showing ${myOrdersShown} of ${total} order(s).</p>`));
      if (myOrdersShown < total) {
        const more = $('<div class="text-center my-orders-more"><button type="button" class="btn btn-outline-primary btn-sm">Load more orders</button></div>');
        more.find('button').on('click', function () {
          $(this).prop('disabled', true).text(window.UI18n ? window.UI18n.t('o.loading', 'Loading...') : 'Loading...');
          loadMyOrdersPage(page + 1).catch(() => { $(this).prop('disabled', false).text('Load more orders'); });
        });
        body.append(more);
      }
    });
}

function openMyOrders() {
  if (!currentUser) {
    showNotification('Please log in to view your orders.', 'info');
    bootstrap.Modal.getOrCreateInstance('#authModal').show();
    return;
  }
  const modal = bootstrap.Modal.getOrCreateInstance('#myOrdersModal');
  $('#myOrdersBody').html('<div class="text-center py-4"><div class="spinner-border text-primary"></div></div>');
  modal.show();
  loadMyOrdersPage(1)
    .catch(() => $('#myOrdersBody').html('<p class="text-danger text-center py-4">Failed to load orders. Please try again.</p>'));
}

function renderProducts(products) {
  const grid       = $('#productGrid');
  const noProducts = $('#noProducts');
  grid.empty();
  if (products.length === 0) {
    noProducts.removeClass('d-none');
    $('#productCount').text('0 products');
    return;
  }
  noProducts.addClass('d-none');
  $('#productCount').text(`${products.length} product${products.length !== 1 ? 's' : ''}`);
  products.forEach((p) => {
    const stockClass   = p.stock <= 0 ? 'out-of-stock' : p.stock < 5 ? 'low-stock' : 'in-stock';
    const stockText    = p.stock <= 0 ? 'Out of Stock' : p.stock < 5 ? `Only ${p.stock} left` : 'In Stock';
    const safeTitle    = escapeHtml(p.title);
    const safeDesc     = escapeHtml(p.description || 'Quality clothing');
    const safeCategory = escapeHtml(p.category || '');
    const safeImageUrl = escapeHtml(p.imageUrl || '/img/logo.svg');
    const safePrice    = escapeHtml(formatMoney(p.price));
    const safeId       = escapeHtml(String(p._id));
    const sizeSelector = `
      <div class="mb-2">
        <select class="form-select form-select-sm size-select" data-product-id="${safeId}" style="max-width:120px;">
          <option value="">Select Size</option>
          ${sizeOptionsHtml(p)}
        </select>
      </div>`;
    const col = $(`
      <div class="col-md-4 col-sm-6 col-lg-4">
        <div class="card h-100">
          <div class="position-relative">
            <a href="/product/${safeId}" class="d-block" aria-label="${safeTitle}">
              <img src="${safeImageUrl}" class="card-img-top" alt="${safeTitle}" loading="lazy"
                   data-fallback-src="/img/logo.svg">
            </a>
            <span class="stock-badge ${stockClass} position-absolute top-0 end-0 m-2" data-product-id="${safeId}">${stockText}</span>
          </div>
          <div class="card-body d-flex flex-column">
            <h5 class="card-title" translate="no"><a href="/product/${safeId}" class="text-decoration-none text-reset">${safeTitle}</a></h5>
            ${ratingHtml(p)}
            <p class="card-text text-muted small">${safeDesc}</p>
            ${safeCategory ? `<span class="badge bg-secondary mb-2">${safeCategory}</span>` : ''}
            <div class="mt-auto pt-3">
              ${sizeSelector}
              <div class="d-flex justify-content-between align-items-center">
                <span class="price-tag">${safePrice}</span>
                <button class="btn btn-primary btn-sm add-to-cart-btn"
                        ${p.stock <= 0 ? 'disabled' : ''}
                        data-product-id="${safeId}">
                  <i class="bi bi-cart-plus me-1"></i>${p.stock <= 0 ? 'Out of Stock' : 'Add to Cart'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>`);
    col.find('.add-to-cart-btn').on('click', function () {
      if (p.stock <= 0) return;
      addToCart(p, 1, col.find('.size-select').val() || null);
    });
    if (typeof window.addWishlistHeart === 'function') window.addWishlistHeart(col, p);
    grid.append(col);
  });
}

// The category counts show how many products each category would give with the search, price and
// stock filters applied, so they always match what the list shows.
function applyFilters() {
  let filtered = [...allProducts];
  const searchTerm = $('#searchInput').val().toLowerCase().trim();
  if (searchTerm) {
    filtered = filtered.filter(p =>
      p.title.toLowerCase().includes(searchTerm) ||
      (p.description && p.description.toLowerCase().includes(searchTerm)) ||
      (p.category    && p.category.toLowerCase().includes(searchTerm))
    );
  }
  const minPrice = parseFloat($('#minPrice').val()) || 0;
  const maxPrice = parseFloat($('#maxPrice').val()) || Infinity;
  filtered = filtered.filter(p => p.price >= minPrice && p.price <= maxPrice);
  if ($('#inStockOnly').is(':checked')) filtered = filtered.filter(p => p.stock > 0);

  updateCategoryCounts(filtered);

  const selectedCategory = $('.list-group-item.active[data-category]').attr('data-category');
  if (selectedCategory && selectedCategory !== 'all') {
    filtered = filtered.filter(p => p.category === selectedCategory);
  }
  filteredProducts = filtered;
  applySorting();
}

function updateCategoryCounts(products) {
  const counts = {};
  products.forEach(p => { if (p.category) counts[p.category] = (counts[p.category] || 0) + 1; });
  // Every badge is set, so a category with no matching product shows 0, not a stale number.
  $('[data-category-count]').each(function () {
    const cat = $(this).attr('data-category-count');
    $(this).text(cat === 'all' ? products.length : (counts[cat] || 0));
  });
}

function applySorting() {
  const sortValue = $('#sortSelect').val();
  let sorted = [...filteredProducts];
  switch (sortValue) {
    case 'newest':     sorted.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); break;
    case 'oldest':     sorted.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)); break;
    case 'price-low':  sorted.sort((a, b) => a.price - b.price); break;
    case 'price-high': sorted.sort((a, b) => b.price - a.price); break;
    case 'name-asc':   sorted.sort((a, b) => a.title.localeCompare(b.title)); break;
    case 'name-desc':  sorted.sort((a, b) => b.title.localeCompare(a.title)); break;
  }
  renderProducts(sorted);
}

function updateCategoryFilter(products) {
  const categories = ['all', ...new Set(products.map(p => p.category).filter(Boolean))];
  const container  = $('#categoryFilter');
  const previous   = container.find('.list-group-item.active').attr('data-category') || 'all';
  container.empty();
  const counts = { all: products.length };
  products.forEach(p => { if (p.category) counts[p.category] = (counts[p.category] || 0) + 1; });
  const icons = { all: 'grid-3x3-gap', Men: 'gender-male', Women: 'gender-female', Kids: 'stars', Accessories: 'handbag', General: 'tag' };
  const active = categories.includes(previous) ? previous : 'all';
  categories.forEach(cat => {
    // Category names come from the admin; they are escaped and set as attributes,
    // never pasted into a selector.
    const item = $(`
      <button class="list-group-item list-group-item-action ${cat === active ? 'active' : ''}">
        <span><i class="bi bi-${icons[cat] || 'tag'} me-2"></i><span class="category-name"></span></span>
        <span class="badge bg-secondary rounded-pill category-count">${counts[cat] || 0}</span>
      </button>`);
    item.attr('data-category', cat);
    item.find('.category-name').text(cat === 'all' ? 'All Categories' : cat);
    item.find('.category-count').attr('data-category-count', cat);
    container.append(item);
  });
  container.find('.list-group-item').on('click', function () {
    container.find('.list-group-item').removeClass('active');
    $(this).addClass('active');
    applyFilters();
  });
}

// The server prices the cart and checks the coupon; the numbers shown are its answer.
function cartLinesForServer() {
  return getCart().map(it => ({ productId: it.productId, quantity: it.quantity, size: it.size }));
}

function setCouponMessage(text, kind) {
  const cls = kind === 'success' ? 'text-success' : kind === 'error' ? 'text-danger' : 'text-muted';
  $('#couponMsg').removeClass('text-success text-danger text-muted').addClass(cls).text(text || '');
}

// Redraws the coupon box and the totals from appliedCoupon (null = no coupon).
function showCouponState(localTotal) {
  if (appliedCoupon) {
    $('#cartSummary').removeClass('d-none');
    $('#cartSubtotal').text(formatMoney(appliedCoupon.subtotal));
    $('#cartCouponCode').text(appliedCoupon.code);
    $('#cartDiscount').text(formatMoney(appliedCoupon.discount));
    $('#cartTotal').text(formatMoney(appliedCoupon.total));
    $('#removeCouponBtn').removeClass('d-none');
    $('#applyCouponBtn').addClass('d-none');
    $('#couponInput').prop('readonly', true).val(appliedCoupon.code);
  } else {
    $('#cartSummary').addClass('d-none');
    $('#removeCouponBtn').addClass('d-none');
    $('#applyCouponBtn').removeClass('d-none');
    $('#couponInput').prop('readonly', false);
    if (typeof localTotal === 'number') $('#cartTotal').text(formatMoney(localTotal));
  }
  if (typeof window.updateShippingDisplay === 'function') window.updateShippingDisplay();   // shipping fee (app-extras.js)
}

function removeCoupon(message) {
  couponRequestId++;
  appliedCoupon = null;
  $('#couponInput').val('');
  setCouponMessage(message || '', message ? 'error' : null);
  showCouponState(lastCartTotal);
}

// Asks the server about a code for the current cart. Resolves to the answer
// ({ valid: true, code, subtotal, discount, total }) or rejects with { message }.
function checkCouponWithServer(code) {
  return fetch('/api/coupons/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, items: cartLinesForServer(), email: ($('#customerEmail').val() || '').trim(), city: ($('#deliveryCity').val() || '').trim() })
  }).then(async res => {
    let data = {};
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok || !data.valid) throw { message: data.message || 'Could not check the coupon. Please try again.' };
    return data;
  });
}

function applyCouponFromInput() {
  const code = $('#couponInput').val().trim();
  if (!code) { setCouponMessage('Enter a coupon code.', 'error'); return; }
  if (getCart().length === 0) { setCouponMessage('Your cart is empty.', 'error'); return; }

  const requestId = ++couponRequestId;
  const btn = $('#applyCouponBtn').prop('disabled', true);
  setCouponMessage('Checking...', null);
  checkCouponWithServer(code)
    .then(data => {
      if (requestId !== couponRequestId) return;
      appliedCoupon = { code: data.code, subtotal: data.subtotal, discount: data.discount, total: data.total };
      setCouponMessage('Coupon applied.', 'success');
      showCouponState(lastCartTotal);
    })
    .catch(err => { if (requestId === couponRequestId) setCouponMessage(err.message, 'error'); })
    .finally(() => btn.prop('disabled', false));
}

// The cart changed: ask the server for the discount again, so it always
// matches what is in the cart. A coupon that no longer applies is removed.
function refreshCoupon() {
  if (!appliedCoupon) { showCouponState(lastCartTotal); return; }
  const requestId = ++couponRequestId;
  checkCouponWithServer(appliedCoupon.code)
    .then(data => {
      if (requestId !== couponRequestId) return;
      appliedCoupon = { code: data.code, subtotal: data.subtotal, discount: data.discount, total: data.total };
      showCouponState(lastCartTotal);
    })
    .catch(err => { if (requestId === couponRequestId) removeCoupon(`Coupon removed: ${err.message}`); });
}

// Drawn with current prices and stock. Gone or sold-out items must be removed; quantities are
// capped to stock.
let cartHasProblems = false;
let cartIsEmpty = true;
let lastProductMap = null;

function fetchProductsForCart() {
  return fetchAllProducts();   // every page: a cart line may be any product in the catalogue
}

function cartNotice(kind, html) {
  return $(`<div class="alert alert-${kind} py-2 small mb-2"></div>`).html(html);
}

function drawCart(items, productMap) {
  const container = $('#cartItems').empty();
  const known = !!productMap;
  lastProductMap = productMap;
  let total = 0, problems = 0, priceChanges = 0, reduced = 0;
  const used = {};   // units of each product already claimed by earlier cart lines

  const rows = [];
  items.forEach((it, idx) => {
    const p = known ? productMap[it.productId] : null;
    let unavailable = false;
    let maxQty = MAX_QTY_PER_ITEM;
    if (known) {
      const avail = p ? availableFor(p, it.size) : 0;   // this size's units for products with stock per size
      const usedKey = `${it.productId}|${sizeKey(it.size || '')}`;
      if (!p || p.stock <= 0 || avail <= 0) {
        unavailable = true;
      } else {
        if (it.price !== p.price) { it.price = p.price; priceChanges++; }
        it.title = p.title;
        it.stock = avail;
        const remaining = avail - (used[usedKey] || 0);
        if (remaining <= 0) {
          unavailable = true;
        } else {
          maxQty = Math.min(MAX_QTY_PER_ITEM, remaining);
          if (it.quantity > maxQty) { it.quantity = maxQty; reduced++; }
          used[usedKey] = (used[usedKey] || 0) + it.quantity;
        }
      }
    }
    if (unavailable) problems++; else total += it.price * it.quantity;

    const sizeLabel = it.size ? ` <span class="badge bg-info text-dark">${escapeHtml(it.size)}</span>` : '';
    const atMax     = known ? it.quantity >= maxQty : it.quantity >= MAX_QTY_PER_ITEM;
    const row = $(`
      <div class="cart-row ${unavailable ? 'opacity-50' : ''}">
        <div>
          <strong translate="no">${escapeHtml(it.title)}</strong>${sizeLabel}
          <div class="text-muted small">${escapeHtml(formatMoney(it.price))} x ${it.quantity}</div>
          ${unavailable ? `<span class="badge bg-danger mt-1">${p ? 'Out of Stock' : 'No longer available'}</span>` : ''}
        </div>
        <div class="d-flex gap-2">
          <button type="button" class="btn btn-outline-secondary btn-sm" data-idx="${idx}" data-action="dec" ${unavailable ? 'disabled' : ''} aria-label="One less"><i class="bi bi-dash"></i></button>
          <span class="btn btn-sm border">${it.quantity}</span>
          <button type="button" class="btn btn-outline-secondary btn-sm" data-idx="${idx}" data-action="inc" ${unavailable || atMax ? 'disabled' : ''} aria-label="One more"><i class="bi bi-plus"></i></button>
          <button type="button" class="btn btn-outline-danger btn-sm" data-idx="${idx}" data-action="remove" aria-label="Remove"><i class="bi bi-trash"></i></button>
        </div>
      </div>`);
    rows.push(row);
  });

  if (!known) container.append(cartNotice('warning', 'We could not check current prices and stock. We will check again when you place the order.'));
  if (priceChanges) container.append(cartNotice('info', 'Some prices changed. Your cart now shows today\'s prices.'));
  if (reduced) container.append(cartNotice('info', 'Some quantities were reduced to what is in stock.'));
  if (problems) {
    container.append(cartNotice('warning',
      `${problems} item${problems > 1 ? 's are' : ' is'} no longer available. ` +
      '<button type="button" class="btn btn-sm btn-dark ms-2" id="removeUnavailableBtn">Remove unavailable items</button>'));
  }
  rows.forEach(r => container.append(r));

  cartHasProblems = problems > 0;
  lastCartTotal = total;
  $('#cartTotal').text(formatMoney(total));
  if (typeof window.updateShippingDisplay === 'function') window.updateShippingDisplay();
  if (known) saveCart(items);
  refreshCoupon();
  updateSubmitState();
}

function renderCart() {
  const items = getCart();
  const container = $('#cartItems');
  container.empty();
  cartIsEmpty = items.length === 0;
  if (cartIsEmpty) {
    cartHasProblems = false;
    container.html('<p class="text-muted text-center py-4"><i class="bi bi-cart-x fs-1 d-block mb-2"></i>Your cart is empty.</p>');
    $('#cartTotal').text(formatMoney(0));
    lastCartTotal = 0;
    if (appliedCoupon) removeCoupon(); else showCouponState(0);
    updateSubmitState();
    return;
  }
  fetchProductsForCart()
    .then(products => {
      const map = {};
      products.forEach(p => { map[p._id] = p; });
      drawCart(items, map);
    })
    // The buttons work in this view too (stock is not known).
    .catch(() => drawCart(items, null));
}

// One handler for every cart button, however the cart was drawn.
$(document).on('click', '#cartItems button[data-action]', function () {
  const idx    = parseInt($(this).attr('data-idx'), 10);
  const action = $(this).attr('data-action');
  const cart   = getCart();
  if (!cart[idx]) return;
  const product = lastProductMap ? lastProductMap[cart[idx].productId] : null;
  const stock   = lastProductMap ? (product ? availableFor(product, cart[idx].size) : 0) : Infinity;
  if (action === 'dec') {
    cart[idx].quantity = Math.max(1, cart[idx].quantity - 1);
  } else if (action === 'inc') {
    if (cart[idx].quantity >= MAX_QTY_PER_ITEM) { showNotification(`You can order at most ${MAX_QTY_PER_ITEM} of one item.`, 'error'); return; }
    if (cart[idx].quantity >= stock) { showNotification(`Only ${stock} available.`, 'error'); return; }
    cart[idx].quantity += 1;
  } else if (action === 'remove') {
    cart.splice(idx, 1);
  }
  saveCart(cart);
  renderCart();
});

$(document).on('click', '#removeUnavailableBtn', function () {
  const map = lastProductMap || {};
  saveCart(getCart().filter(it => map[it.productId] && availableFor(map[it.productId], it.size) > 0));
  renderCart();
});

// The server says which methods are really set up; only those are shown, so a customer is never
// offered a button that cannot work.
const GATEWAY_INPUTS = {
  sslcommerz: '#gatewaySslcommerz', stripe: '#gatewayStripe',
  paypal: '#gatewayPaypal', flutterwave: '#gatewayFlutterwave', mollie: '#gatewayMollie',
  cod: '#gatewayCod', manual: '#gatewayManual'
};
let noPaymentMethods = true;
let checkoutBusy = false;
let cardCurrency = '';      // set when the card gateways charge in another currency than the prices
let cardNoteRequestId = 0;  // only the newest answer from the server is shown

function applyPaymentOptions(opts) {
  const enabled = {
    sslcommerz: !!(opts.sslcommerz && opts.sslcommerz.enabled),
    stripe:     !!(opts.stripe && opts.stripe.enabled),
    paypal:      !!(opts.paypal && opts.paypal.enabled),
    flutterwave: !!(opts.flutterwave && opts.flutterwave.enabled),
    mollie:      !!(opts.mollie && opts.mollie.enabled),
    cod:        !!(opts.cod && opts.cod.enabled),
    manual:     !!(opts.manual && opts.manual.enabled)
  };
  Object.entries(GATEWAY_INPUTS).forEach(([name, sel]) => {
    $(sel).prop('disabled', !enabled[name]);
    $(`label[for="${sel.slice(1)}"]`).toggleClass('d-none', !enabled[name]);
  });
  const checked = $('input[name="paymentGateway"]:checked');
  if (!checked.length || checked.prop('disabled')) {
    const first = Object.keys(GATEWAY_INPUTS).find(n => enabled[n]);
    $('input[name="paymentGateway"]').prop('checked', false);
    if (first) $(GATEWAY_INPUTS[first]).prop('checked', true);
  }
  noPaymentMethods = !Object.values(enabled).some(Boolean);
  $('#paymentNone').toggleClass('d-none', !noPaymentMethods)
    .text('This store has no payment method set up yet, so orders cannot be placed right now.');

  const maxCod = enabled.cod && opts.cod.maxAmount;
  $('#codNote').toggleClass('d-none', !maxCod).text(maxCod ? `Cash on Delivery is available for orders up to ${formatMoney(maxCod)}.` : '');
  if (enabled.manual) {
    const m = opts.manual;
    $('#manualNote').data('text', `Pay by bank transfer or mobile banking within ${m.hours} hours.`).data('instr', String(m.instructions || '').trim());
  }
  cardCurrency = opts.card && opts.card.currency ? String(opts.card.currency) : '';
  updateCheckoutButton();
}

// The amount and currency the card gateway page will charge, shown under the total.
function updateCardNote() {
  const g = $('input[name="paymentGateway"]:checked').val();
  const note = $('#cardChargeNote');
  const id = ++cardNoteRequestId;
  if (!cardCurrency || cartIsEmpty || !['stripe', 'paypal', 'flutterwave', 'mollie'].includes(g)) { note.addClass('d-none').text(''); return; }
  const goods = appliedCoupon ? appliedCoupon.total : lastCartTotal;
  const shown = goods + (typeof window.currentShippingFee === 'function' ? window.currentShippingFee(goods, $('#deliveryCity').val()) : 0);
  fetch('/api/payment-options?total=' + encodeURIComponent(window.TLMoney ? window.TLMoney.fixed(shown) : shown.toFixed(2)))
    .then(r => (r.ok ? r.json() : null))
    .then(opts => {
      if (id !== cardNoteRequestId) return;
      const amount = opts && opts.card && opts.card.amounts && opts.card.amounts[g];
      note.toggleClass('d-none', !amount).text(amount ? `You will be charged ${amount} ${opts.card.currency} on the payment page.` : '');
    })
    .catch(() => { if (id === cardNoteRequestId) note.addClass('d-none').text(''); });
}

function loadPaymentOptions() {
  fetch('/api/payment-options')
    .then(r => { if (!r.ok) throw new Error('options'); return r.json(); })
    .then(applyPaymentOptions)
    .catch(() => {
      noPaymentMethods = true;
      $('#paymentNone').removeClass('d-none').text('Could not load the payment methods. Please refresh the page.');
      updateSubmitState();
    });
}

// The button text follows the chosen payment method; the button is off while the
// cart is empty or has unavailable items, or the store has no payment method.
function updateCheckoutButton() {
  const g = $('input[name="paymentGateway"]:checked').val();
  const label = g === 'cod' ? '<i class="bi bi-bag-check me-2"></i>Place Order (Pay on Delivery)'
    : g === 'manual' ? '<i class="bi bi-bank me-2"></i>Place Order (Pay by Transfer)'
    : '<i class="bi bi-credit-card me-2"></i>Proceed to Payment';
  if (!checkoutBusy) $('#checkoutForm button[type="submit"]').html(label);
  const note = $('#manualNote');
  if (g === 'manual' && note.data('text')) note.removeClass('d-none').empty().append($('<div></div>').text(note.data('text')), note.data('instr') ? $('<div></div>').text(note.data('instr')) : null); else note.addClass('d-none');
  updateCardNote();
  updateSubmitState();
}

function updateSubmitState() {
  $('#checkoutForm button[type="submit"]').prop('disabled', checkoutBusy || cartIsEmpty || cartHasProblems || noPaymentMethods);
}

// A checkout id stays the same while cart, details and payment method do, so a double click or
// Back returns the existing order.
const CHECKOUT_ID_PATTERN = /^[A-Za-z0-9_-]{16,100}$/;
function newCheckoutId() {
  const c = window.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c && typeof c.getRandomValues === 'function') {
    return Array.from(c.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  let s = '';
  while (s.length < 32) s += Math.random().toString(36).slice(2);
  return s.slice(0, 32);
}
function checkoutRequestId(signature) {
  try {
    const saved = JSON.parse(sessionStorage.getItem('threadly_checkout') || 'null');
    if (saved && saved.sig === signature && CHECKOUT_ID_PATTERN.test(saved.id) && Date.now() - saved.at < 30 * 60 * 1000) return saved.id;
  } catch (e) { /* fall through to a new id */ }
  const id = newCheckoutId();
  try { sessionStorage.setItem('threadly_checkout', JSON.stringify({ sig: signature, id, at: Date.now() })); } catch (e) { /* private mode */ }
  return id;
}
function clearCheckoutRequestId() {
  try { sessionStorage.removeItem('threadly_checkout'); } catch (e) { /* ignore */ }
}

// The phone rule the server applies to online payment and cash on delivery (isUsablePhone in
// services/cod.js): digits with optional + ( ) - . and spaces, at least 6 digits, at most 30
// characters.
function isUsablePhone(phone) {
  if (typeof phone !== 'string') return false;
  const value = phone.trim();
  if (value.length === 0 || value.length > 30) return false;
  if (!/^[0-9+()\-. ]+$/.test(value)) return false;
  return value.replace(/\D/g, '').length >= 6;
}
const PHONE_MESSAGE = 'Please enter a valid phone number: digits, with optional + ( ) - . and spaces, at least 6 digits.';
// Only a bank or mobile-banking transfer ("manual") accepts a phone number that is not in that
// format.
const phoneRuleApplies = (paymentGateway) => paymentGateway !== 'manual';

function placeOrder(name, email, phone, address, paymentGateway) {
  const items = getCart();
  if (items.length === 0) return Promise.reject({ message: 'Your cart is empty.' });
  if (email.length > 254 || !/^[^\s@,;:<>()\[\]\"'\\]+@[^\s@,;:<>()\[\]\"'\\]+\.[^\s@,;:<>()\[\]\"'\\]+$/.test(email)) return Promise.reject({ message: 'Invalid email address format' });
  if (!name || name.trim().length < 2) return Promise.reject({ message: 'Name must be at least 2 characters' });
  if (!phone || !phone.trim()) return Promise.reject({ message: 'Please enter a valid phone number' });
  if (phoneRuleApplies(paymentGateway) && !isUsablePhone(phone)) return Promise.reject({ message: PHONE_MESSAGE });
  if (!address.address || !address.city || !address.postcode || !address.country) {
    return Promise.reject({ message: 'Please fill in all delivery address fields' });
  }
  if (items.some(it => !it.size)) return Promise.reject({ message: 'Every item needs a size. Remove the item and add it again with a size.' });

  const gateway = ['cod', 'stripe', 'paypal', 'flutterwave', 'mollie', 'manual'].includes(paymentGateway) ? paymentGateway : 'sslcommerz';
  const lines = items.map(it => ({ productId: it.productId, quantity: it.quantity, size: it.size }));
  const couponCode = appliedCoupon ? appliedCoupon.code : undefined;   // only the code; the server works out the discount
  // The total shown on screen. If a price changed in the meantime, the server
  // refuses the order (instead of charging something different from what was shown).
  const goodsShown = appliedCoupon ? appliedCoupon.total : lastCartTotal;
  const shippingShown = typeof window.currentShippingFee === 'function' ? window.currentShippingFee(goodsShown, address.city) : 0;
  const shown = goodsShown + shippingShown;
  const unit = Math.pow(10, window.TLMoney ? window.TLMoney.decimals() : 2);   // smallest unit of the shop currency
  const expectedTotal = shown > 0 ? Math.round(shown * unit) / unit : undefined;

  const payload = {
    customerName:    name.trim(),
    customerEmail:   email.trim().toLowerCase(),
    customerPhone:   phone.trim(),
    deliveryAddress: address,
    paymentGateway:  gateway,
    couponCode,
    expectedTotal,
    clientRequestId: checkoutRequestId(JSON.stringify([lines, gateway, name, email, phone, address, couponCode])),
    items: lines
  };

  return fetch('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(async res => {
    let data = {};
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok) throw { status: res.status, ...data, message: data.message || 'The order could not be placed. Please try again.' };
    return data;
  });
}

// The product list comes in pages (the server answers X-Has-More: true while there is another
// one), so a very large catalogue is never sent, or held in memory, in one piece.
async function fetchAllProducts() {
  const PAGE = 200;
  const all = [];
  for (let page = 0; page < 100; page++) {       // 100 pages x 200 = 20,000 products at most
    const res = await fetch(`/api/products?limit=${PAGE}&skip=${page * PAGE}`);
    if (!res.ok) throw new Error('Could not load the products.');
    all.push(...await res.json());
    if (res.headers.get('X-Has-More') !== 'true') break;
  }
  return all;
}

function loadProducts() {
  fetchAllProducts().then((loaded) => {
    // A shop page (/?shop=name) shows only that shop's products (marketplace.js).
    const products = typeof window.filterLoadedProducts === 'function' ? window.filterLoadedProducts(loaded) : loaded;
    allProducts      = products;
    filteredProducts = products;
    if (typeof window.onProductsLoaded === 'function') window.onProductsLoaded(loaded);
    updateCategoryFilter(products);
    renderFeaturedProducts(products);
    updateCategoryCounts(products);
    applyFilters();
  }).catch(() => showNotification('Failed to load products. Please refresh.', 'error'));
}

function renderFeaturedProducts(products) {
  const featured  = products.slice(0, 6);
  const container = $('#featuredProducts');
  container.empty();
  if (featured.length === 0) {
    container.html('<div class="col-12 text-center text-muted py-5">No featured products available.</div>');
    return;
  }
  featured.forEach((p) => {
    const safeImageUrl = escapeHtml(p.imageUrl || '/img/logo.svg');
    const safeTitle    = escapeHtml(p.title);
    const safeDesc     = escapeHtml(p.description || 'Quality clothing');
    const safeCategory = escapeHtml(p.category || '');
    const safePrice    = escapeHtml(formatMoney(p.price));
    const safeId       = escapeHtml(String(p._id));
    const stockClass   = p.stock <= 0 ? 'out-of-stock' : p.stock < 5 ? 'low-stock' : 'in-stock';
    const stockText    = p.stock <= 0 ? 'Out of Stock' : p.stock < 5 ? `Only ${p.stock} left` : 'In Stock';
    const sizeSelector = `
      <div class="mb-2">
        <select class="form-select form-select-sm feat-size-select" style="max-width:120px;">
          <option value="">Select Size</option>
          ${sizeOptionsHtml(p)}
        </select>
      </div>`;
    const col = $(`
      <div class="col-lg-4 col-md-6">
        <div class="card h-100">
          <div class="position-relative">
            <a href="/product/${safeId}" class="d-block" aria-label="${safeTitle}">
              <img src="${safeImageUrl}" class="card-img-top" alt="${safeTitle}" loading="lazy"
                   data-fallback-src="/img/logo.svg">
            </a>
            <span class="stock-badge ${stockClass} position-absolute top-0 end-0 m-2" data-product-id="${safeId}">${stockText}</span>
          </div>
          <div class="card-body d-flex flex-column">
            <h5 class="card-title" translate="no"><a href="/product/${safeId}" class="text-decoration-none text-reset">${safeTitle}</a></h5>
            ${ratingHtml(p)}
            <p class="card-text text-muted small">${safeDesc}</p>
            ${safeCategory ? `<span class="badge bg-secondary mb-2">${safeCategory}</span>` : ''}
            <div class="mt-auto pt-3">
              ${sizeSelector}
              <div class="d-flex justify-content-between align-items-center">
                <span class="price-tag">${safePrice}</span>
                <button class="btn btn-primary btn-sm feat-add-btn" ${p.stock <= 0 ? 'disabled' : ''}>
                  <i class="bi bi-cart-plus me-1"></i>${p.stock <= 0 ? 'Out of Stock' : 'Add to Cart'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>`);
    col.find('.feat-add-btn').on('click', function () {
      if (p.stock <= 0) return;
      addToCart(p, 1, col.find('.feat-size-select').val() || null);
    });
    if (typeof window.addWishlistHeart === 'function') window.addWishlistHeart(col, p);
    container.append(col);
  });
}

function getStatusBadge(status) {
  const badges = { PENDING: 'bg-warning text-dark', PLACED: 'bg-secondary', CONFIRMED: 'bg-info', SHIPPED: 'bg-primary', DELIVERED: 'bg-success', CANCELLED: 'bg-danger' };
  return `<span class="badge ${badges[status] || 'bg-secondary'}">${status}</span>`;
}

function debounce(func, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

function handleSidebarSticky() {
  const sidebar = $('#sidebarFilter');
  const footer  = $('.footer');
  if (sidebar.length && footer.length) {
    $(window).on('scroll', function () {
      if (sidebar.offset().top + sidebar.outerHeight() > footer.offset().top - 20) {
        sidebar.css({ position: 'absolute', top: 'auto' });
      } else {
        sidebar.css({ position: 'sticky', top: '90px' });
      }
    });
  }
}

// Prices drawn before the shop's decimals were known are drawn again.
document.addEventListener('brand:ready', (e) => {
  if (!e.detail || !e.detail.decimalsChanged) return;
  if (allProducts.length) { applyFilters(); renderFeaturedProducts(allProducts); }
  renderCart();
});

$(function () {
  updateCartCount();
  loadProducts();
  handleSidebarSticky();
  checkAuthStatus();

  // The verification email opens the shop with #verifyToken=...; the page confirms it here
  const verifyHash = /(?:^#|&)verifyToken=([a-f0-9]{64})(?:&|$)/.exec(window.location.hash);
  if (verifyHash) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    fetch('/api/users/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: verifyHash[1] })
    }).then((res) => {
      if (res.ok) showNotification('Email verified. You can now see all your orders.', 'success');
      else showNotification('That verification link is invalid or has expired. Open My Orders to get a new one.', 'error');
    }).catch(() => showNotification('Could not verify your email. Please try the link again.', 'error'));
  }

  // Landing here after an invalid verification link
  const verifiedParam = new URLSearchParams(window.location.search).get('emailVerified');
  if (verifiedParam !== null) {
    if (verifiedParam === '1') showNotification('Email verified. You can now see all your orders.', 'success');
    else showNotification('That verification link is invalid or has expired. Open My Orders to get a new one.', 'error');
    window.history.replaceState(null, '', window.location.pathname + window.location.hash);
  }
  initAuth();

  // Stock changes (an order, an admin edit) refresh the product list quietly. A
  // burst of events is merged into one refresh, and an open cart is redrawn so
  // its stock and prices stay right. No pop-up: it would reach every visitor.
  const refreshSoon = debounce(() => {
    loadProducts();
    if ($('#cartModal').hasClass('show')) renderCart();
  }, 400);
  // Socket.IO v4 has no 'reconnect' event on the socket itself (it lives on
  // socket.io). 'connect' fires on every (re)connection, so skip the first one,
  // the page has just loaded its products, and refresh after each later one.
  let socketWasConnected = false;
  socket.on('connect', () => {
    if (socketWasConnected) refreshSoon();
    socketWasConnected = true;
  });
  socket.on('productUpdate', refreshSoon);

  // Keep the sticky filter sidebar's offset in sync with the navbar's real
  // height (a hardcoded pixel guess doesn't match at every width, since the
  // navbar can wrap taller depending on content, zoom, or screen size).
  function updateNavbarHeightVar() {
    const navbar = document.querySelector('nav.navbar');
    if (navbar) {
      document.documentElement.style.setProperty('--navbar-height', navbar.offsetHeight + 'px');
    }
  }
  updateNavbarHeightVar();
  window.addEventListener('resize', debounce(updateNavbarHeightVar, 150));
  window.addEventListener('load', updateNavbarHeightVar);

  $('#mobileFilterToggle').on('click', function () {
    const $sidebar = $('#sidebarFilter');
    const isHidden = $sidebar.hasClass('collapsed-mobile');
    $sidebar.toggleClass('collapsed-mobile');
    $(this).find('span').text(isHidden ? 'Hide Filters' : 'Show Filters');
    $(this).find('i').toggleClass('bi-funnel bi-x-circle');
  });
  $('#searchInput').on('input', debounce(applyFilters, 300));
  $('#minPrice, #maxPrice').on('input', debounce(applyFilters, 300));
  $('#inStockOnly').on('change', applyFilters);
  $('#sortSelect').on('change', applySorting);
  $('#clearFilters').on('click', function () {
    $('#searchInput').val('');
    $('#minPrice').val('');
    $('#maxPrice').val('');
    $('#inStockOnly').prop('checked', true);
    $('.list-group-item[data-category="all"]').click();
    applyFilters();
  });

  const cartModal = new bootstrap.Modal('#cartModal');
  $('#viewCartLink').on('click', (e) => { e.preventDefault(); renderCart(); cartModal.show(); });

  // Coupon box. Enter must apply the coupon, not submit the checkout form.
  $('#applyCouponBtn').on('click', applyCouponFromInput);
  $('#removeCouponBtn').on('click', () => removeCoupon());
  $('#couponInput').on('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); applyCouponFromInput(); }
  });

  $('#cartModal').on('show.bs.modal', function () {
    if (currentUser) {
      $('#customerName').val(currentUser.name);
      $('#customerEmail').val(currentUser.email);
    }
  });

  $('#customerPhone').on('input', function () { $(this).removeClass('is-invalid'); });
  $('#checkoutForm').on('submit', function (e) {
    e.preventDefault();
    if (checkoutBusy) return;   // a second click while the first is still working

    const name     = $('#customerName').val().trim();
    const email    = $('#customerEmail').val().trim();
    const phone    = $('#customerPhone').val().trim();
    const paymentGateway = $('input[name="paymentGateway"]:checked').val();
    const address  = {
      address:  $('#deliveryAddress').val().trim(),
      city:     $('#deliveryCity').val().trim(),
      postcode: $('#deliveryPostcode').val().trim(),
      country:  $('#deliveryCountry').val().trim()
    };

    const showMsg = (cls, icon, text) => $('#checkoutMsg').removeClass().addClass(cls)
      .empty().append($('<i>').addClass(`bi bi-${icon} me-2`)).append(document.createTextNode(text));

    if (!paymentGateway) { showMsg('text-danger', 'exclamation-triangle', 'Please choose a payment method.'); return; }
    if (!name || !email || !phone || !address.address || !address.city || !address.postcode || !address.country) {
      showMsg('text-danger', 'exclamation-triangle', 'Please fill in all required fields.');
      return;
    }
    // The same phone rule as the server, with the message next to the field
    if (phoneRuleApplies(paymentGateway) && !isUsablePhone(phone)) {
      $('#customerPhone').addClass('is-invalid').trigger('focus');
      $('#customerPhoneError').text(PHONE_MESSAGE);
      showMsg('text-danger', 'exclamation-triangle', 'Please correct the phone number.');
      return;
    }
    $('#customerPhone').removeClass('is-invalid');

    const submitBtn = $(this).find('button[type="submit"]');
    const offline = paymentGateway === 'cod' || paymentGateway === 'manual';
    checkoutBusy = true;
    submitBtn.prop('disabled', true).html(`<span class="spinner-border spinner-border-sm me-2"></span>${offline ? 'Placing order...' : 'Redirecting to payment...'}`);
    showMsg('text-info', 'hourglass-split', 'Preparing your order...');

    const done = () => { checkoutBusy = false; updateCheckoutButton(); };
    const q = (obj) => new URLSearchParams(obj).toString();

    placeOrder(name, email, phone, address, paymentGateway)
      .then((data) => {
        if (data.cod) {
          // Cash on Delivery: placed, nothing to pay online
          clearCheckoutRequestId();
          saveCart([]);
          window.location.href = `/payment-success.html?${q({ cod: 'true', tran_id: data.transactionId, amount: data.amount })}`;
        } else if (data.manual) {
          clearCheckoutRequestId();
          saveCart([]);
          window.location.href = `/payment-success.html?${q({ manual: 'true', tran_id: data.transactionId, order_id: data.orderId, amount: data.amount })}`;
        } else if (data.paid) {
          clearCheckoutRequestId();
          window.location.href = `/payment-success.html?${q({ tran_id: data.transactionId, already: 'true' })}`;
        } else if (data.paymentUrl) {
          // The cart stays in place until the payment succeeds (the success page
          // empties it). If the customer cancels or the payment fails, nothing is lost.
          window.location.href = data.paymentUrl;
        } else {
          throw { message: 'The payment page did not open. Please try again.' };
        }
      })
      .catch((err) => {
        const msg = (err && err.message) || 'Order failed. Please try again.';
        const networkProblem = !err || err.status === undefined;
        // A definite refusal means no order was made, so the next try starts fresh.
        if (!networkProblem && err.status < 500) clearCheckoutRequestId();
        if (networkProblem && err instanceof TypeError) {
          showMsg('text-danger', 'exclamation-triangle', 'Could not reach the shop. Check your connection and try again; you will not be charged twice.');
          showNotification('Could not reach the shop.', 'error');
        } else {
          // The server refused the coupon (for example its last use was just taken): drop it
          if (err && err.couponInvalid) removeCoupon(msg);
          // A price changed or an item went away: show the cart as it is now
          if (err && (err.priceChanged || err.unavailable)) renderCart();
          showMsg('text-danger', 'exclamation-triangle', msg);
          showNotification(msg, 'error');
        }
        done();
      });
  });

  // Coming back with the Back button can restore the page as it was left, with
  // the button stuck on "Redirecting...".
  window.addEventListener('pageshow', (ev) => { if (ev.persisted) { checkoutBusy = false; updateCheckoutButton(); renderCart(); } });

  loadPaymentOptions();
  $('input[name="paymentGateway"]').on('change', updateCheckoutButton);
  new MutationObserver(updateCardNote).observe(document.getElementById('cartTotal'), { childList: true, characterData: true, subtree: true });

  $('a[href^="#"]').on('click', function (e) {
    const href = $(this).attr('href');
    if (!href || href.length < 2) return;   // a bare "#" is not a valid selector and made jQuery throw
    const target = $(href);
    if (target.length) { e.preventDefault(); $('html, body').animate({ scrollTop: target.offset().top - 80 }, 600); }
  });

  $('.category-badge').on('click', function (e) {
    e.preventDefault();
    const category = $(this).attr('data-category');
    if (category) {
      $('#categoryFilter .list-group-item').filter(function () { return $(this).attr('data-category') === category; }).first().click();
      $('html, body').animate({ scrollTop: $('#products').offset().top - 80 }, 600);
    }
  });
});