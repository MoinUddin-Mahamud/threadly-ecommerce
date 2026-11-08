// Admin dashboard.

const socket = io();
let isAuthenticated = false;
let csrfToken = null; // Stored after login, sent on every mutating request

// What the logged-in admin may do. Filled from /admin/auth/status after login.
// This only decides what the page shows; the server checks every request too.
let adminAccess = { isSuper: false, permissions: new Set() };
function can(permission) {
  return adminAccess.isSuper || adminAccess.permissions.has(permission);
}
function applyAccess(data) {
  adminAccess = { isSuper: !!data.isSuper, permissions: new Set(data.permissions || []) };
  ['product', 'order', 'coupon', 'audit', 'vendor'].forEach((res) => {
    ['view', 'details', 'create', 'edit', 'delete'].forEach((act) => {
      document.body.classList.toggle(`can-${res}-${act}`, can(`${res}.${act}`));
    });
  });
  $('.admin-sidebar .nav-link[href="#products-section"]').toggle(can('product.view'));
  $('.admin-sidebar .nav-link[href="#orders-section"]').toggle(can('order.view'));
  $('.admin-sidebar .nav-link[href="#stats-section"]').toggle(can('product.view') && can('order.view'));
  $('#couponsNavLink').toggle(can('coupon.view'));
  $('#auditLogNavLink').toggle(can('audit.view'));
  $('#reviewsNavLink').toggle(can('product.view'));
  $('#rolesNavLink').toggle(adminAccess.isSuper);
}

async function fetchCsrfToken() {
  try {
    const res = await fetch('/admin/csrf-token', { credentials: 'include' });
    const data = await res.json();
    csrfToken = data.csrfToken;
  } catch (e) {
    console.error('Failed to fetch CSRF token:', e);
  }
}

function debounceAdmin(fn, wait) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

// A picture that fails to load is replaced by the logo (one listener for the
// page, instead of an inline onerror attribute on every image).
document.addEventListener('error', (ev) => {
  const img = ev.target;
  if (img && img.tagName === 'IMG' && img.dataset && img.dataset.fallbackSrc && !img.dataset.fallbackUsed) {
    img.dataset.fallbackUsed = '1';
    img.src = img.dataset.fallbackSrc;
  }
}, true);

// A 401 means the admin session ended; the login form comes back with a message.
function sessionExpired() {
  if (!isAuthenticated) return;
  isAuthenticated = false;
  csrfToken = null;
  $('#adminDashboard').addClass('d-none');
  $('#loginSection').removeClass('d-none');
  showAlert('Your session has expired. Please log in again.', 'danger');
}

async function readJson(res) {
  let data = null;
  try { data = await res.json(); } catch (e) { /* empty or not JSON */ }
  if (res.status === 401) { sessionExpired(); throw { status: 401, responseJSON: data || {} }; }
  if (!res.ok) throw { status: res.status, responseJSON: data || {} };
  return data;
}

// GET returning parsed JSON; rejects with { status, responseJSON } for any error status.
function apiGet(url) {
  return fetch(url, { credentials: 'include' }).then(readJson);
}

// JSON request with the CSRF header.
function jsonRequest(url, method, body) {
  return fetch(url, {
    method,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken || ''
    },
    body: body ? JSON.stringify(body) : undefined
  }).then(readJson);
}

function checkAuth() {
  // Signing in once keeps you signed in for up to an hour of inactivity (see ADMIN_IDLE_MS in
  // routes/admin.js).
  fetch('/admin/auth/status', { credentials: 'include' })
    .then(r => r.json())
    .then(async (data) => {
      if (data.isAuthenticated) {
        isAuthenticated = true;
        await fetchCsrfToken(); // Get CSRF token once authenticated
        $('#loginSection').addClass('d-none');
        $('#adminDashboard').removeClass('d-none');
        if (data.username) $('#adminUsername').text(data.username);
        document.body.setAttribute('data-role', data.role || 'owner');
        applyAccess(data);
        if (typeof window.onAdminReady === 'function') window.onAdminReady(data);   // admin-extras.js
        if (can('product.view')) loadProducts();
        if (can('order.view')) loadOrders();
        showSectionFromHash();
      } else {
        isAuthenticated = false;
        csrfToken = null;
        $('#loginSection').removeClass('d-none');
        $('#adminDashboard').addClass('d-none');
      }
    })
    .catch(() => {
      isAuthenticated = false;
      $('#loginSection').removeClass('d-none');
      $('#adminDashboard').addClass('d-none');
    });
}

// One section per URL hash: #products-section, #orders-section, #stats-section,
// #low-stock-section, #revenue-section, #audit-log-section, #edit-product-<id>, #order-<id>
const NAV_FOR_SECTION = {
  'all-products-section': 'stats-section',
  'low-stock-section':    'stats-section',
  'revenue-section':      'stats-section',
  'audit-log-section':    'audit-log-section',
  'edit-product-section': 'products-section',
  'order-detail-section': 'orders-section'
};

function showSection(sectionId) {
  $('.admin-section').hide();
  $('#' + sectionId).show();

  const navId = NAV_FOR_SECTION[sectionId] || sectionId;
  $('.admin-sidebar .nav-link').removeClass('active');
  $(`.admin-sidebar .nav-link[href="#${navId}"]`).addClass('active');

  window.scrollTo({ top: 0, behavior: 'instant' });
}

// Which sections this admin may open, based on their permissions.
function sectionAllowed(hash) {
  if (hash === 'roles-section') return adminAccess.isSuper;
  if (hash === 'coupons-section') return can('coupon.view');
  if (hash === 'vendors-section') return can('vendor.view');
  if (hash === 'audit-log-section') return can('audit.view');
  if (hash === 'reviews-section') return can('product.view');
  if (hash.startsWith('order-')) return can('order.view') && can('order.details');
  if (hash.startsWith('edit-product-')) return can('product.view') && can('product.edit');
  if (hash === 'orders-section' || hash === 'revenue-section') return can('order.view');
  if (hash === 'stats-section') return can('product.view') && can('order.view');
  if (hash === 'products-section' || hash === 'all-products-section' || hash === 'low-stock-section') return can('product.view');
  return true;
}
function firstAllowedHash() {
  if (can('product.view')) return 'products-section';
  if (can('order.view')) return 'orders-section';
  if (can('coupon.view')) return 'coupons-section';
  if (can('audit.view')) return 'audit-log-section';
  if (adminAccess.isSuper) return 'roles-section';
  return null;
}

function showSectionFromHash() {
  const hash = window.location.hash.replace('#', '');

  // Send people to the first page they're allowed to see
  const fallback = firstAllowedHash();
  if (!fallback) {
    $('.admin-section').hide();
    $('#noAccessNotice').show();
    return;
  }
  $('#noAccessNotice').hide();
  if (!hash || !sectionAllowed(hash)) {
    window.location.hash = fallback;
    return;
  }

  if (hash === 'roles-section') {
    showSection('roles-section');
    if (typeof loadRolesPage === 'function') loadRolesPage();
    return;
  }

  if (hash === 'coupons-section') {
    showSection('coupons-section');
    if (typeof loadCouponsPage === 'function') loadCouponsPage();
    return;
  }

  if (hash === 'vendors-section') {
    showSection('vendors-section');
    if (typeof loadVendorsPage === 'function') loadVendorsPage();   // admin-extras.js
    return;
  }

  if (hash.startsWith('order-')) {
    showSection('order-detail-section');
    loadOrderDetail(hash.replace('order-', ''));
    return;
  }
  if (hash.startsWith('edit-product-')) {
    showSection('edit-product-section');
    loadEditProduct(hash.replace('edit-product-', ''));
    return;
  }
  if (hash === 'products-section') { showProductsView(false); return; }
  if (hash === 'all-products-section') { showProductsView(true); return; }
  if (hash === 'low-stock-section') { showSection(hash); loadLowStock(); return; }
  if (hash === 'revenue-section')    { showSection(hash); loadRevenue();  return; }
  if (hash === 'audit-log-section')  { showSection(hash); loadAuditLog(); return; }
  if (hash === 'reviews-section')    { showSection(hash); loadReviews(1); return; }

  const validSections = ['stats-section', 'orders-section', 'products-section'];
  const target = validSections.includes(hash) ? hash : 'stats-section';
  if (!sectionAllowed(target)) { window.location.hash = fallback; return; }
  showSection(target);
}

// Products page in two modes: full management (add form + list) from the
// sidebar, or list-only when opened from the Total Products statistics card.
function showProductsView(listOnly) {
  showSection('products-section');
  $('#addProductCard').toggle(!listOnly && can('product.create'));
  $('#backToStatsFromProducts').toggle(listOnly);
  $('#productsHeading span').text(listOnly ? 'All Products' : 'Product Management');
  $('.admin-sidebar .nav-link').removeClass('active');
  $(`.admin-sidebar .nav-link[href="#${listOnly ? 'stats-section' : 'products-section'}"]`).addClass('active');
}

function fetchProductsList() {
  return apiGet('/admin/products');
}
// One page of orders (50 at a time). Resolves to { orders, pagination }.
function fetchOrdersPage(page = 1, status = '') {
  const qs = new URLSearchParams({ page, limit: 50 });
  if (status) qs.set('status', status);
  return apiGet(`/admin/orders?${qs}`);
}
function fetchOrdersList() {
  return fetchOrdersPage(1).then(d => d.orders || []);
}

function loadLowStock() {
  const tbody = $('#lowStockTable');
  tbody.html('<tr><td colspan="6" class="text-center py-4"><div class="spinner-border text-primary"></div></td></tr>');
  fetchProductsList().then((products) => {
    const low = products.filter(p => p.stock < 5).sort((a, b) => a.stock - b.stock);
    if (low.length === 0) {
      tbody.html('<tr><td colspan="6" class="text-center text-muted py-4"><i class="bi bi-check-circle fs-1 d-block mb-2 text-success"></i>Nothing is running low. All products have 5 or more in stock.</td></tr>');
      return;
    }
    tbody.empty();
    low.forEach((p) => {
      tbody.append(`
        <tr>
          <td><img src="${escapeHtml(p.imageUrl || '/img/logo.svg')}" alt="" class="img-thumbnail" style="width:50px;height:50px;object-fit:cover;" data-fallback-src="/img/logo.svg"></td>
          <td><strong>${escapeHtml(p.title)}</strong></td>
          <td><span class="badge bg-secondary">${escapeHtml(p.category || 'General')}</span></td>
          <td>${escapeHtml(String(p.price))}</td>
          <td><span class="badge ${p.stock === 0 ? 'bg-danger' : 'bg-warning text-dark'}">${escapeHtml(String(p.stock))}</span></td>
          <td><a href="#edit-product-${escapeHtml(String(p._id))}" class="btn btn-primary btn-sm"><i class="bi bi-pencil"></i> Edit</a></td>
        </tr>`);
    });
  }).catch(() => tbody.html('<tr><td colspan="6" class="text-center text-danger py-4">Failed to load products.</td></tr>'));
}

// Totals come from the server (all orders, not just this page). An order counts once paid and
// until cancelled.
function countsAsRevenue(o) {
  if (typeof o.countsAsRevenue === 'boolean') return o.countsAsRevenue;
  return !!o.paidAt && o.status !== 'CANCELLED';
}

// The footer of the revenue table.
function revenueFooter(revenue) {
  const money = (n) => escapeHtml(TLMoney.fixed(Number(n || 0)));
  if (revenue.commissionEarned === undefined) {
    return `<tr class="table-light"><th colspan="4" class="text-end">Total sales (paid, not cancelled; all orders)</th><th class="text-end">${money(revenue.totalRevenue)}</th></tr>`;
  }
  return `
    <tr class="table-light"><th colspan="4" class="text-end">Sales (paid, not cancelled; all orders)</th><th class="text-end">${money(revenue.totalRevenue)}</th></tr>
    <tr class="table-light text-muted"><th colspan="4" class="text-end fw-normal">Less sellers' share (price minus commission)</th><th class="text-end fw-normal">&minus; ${money(revenue.vendorShare)}</th></tr>
    <tr class="table-info"><th colspan="4" class="text-end">Store revenue (own items + commission + shipping &minus; coupons)</th><th class="text-end">${money(revenue.storeRevenue)}</th></tr>
    ${Number(revenue.keptEarningsCost) > 0 ? `<tr class="table-light text-muted"><th colspan="4" class="text-end fw-normal">Less: earnings kept by sellers on cancelled orders (already deducted from Store revenue)</th><th class="text-end fw-normal">&minus; ${money(revenue.keptEarningsCost)}</th></tr>` : ''}
    <tr class="table-light text-muted"><td colspan="4" class="text-end small">of which commission ${money(revenue.commissionEarned)}, shipping ${money(revenue.shippingCollected)}, coupons given ${money(revenue.couponDiscounts)}</td><td></td></tr>`;
}

function loadRevenue() {
  const tbody = $('#revenueTable');
  const foot  = $('#revenueFoot');
  tbody.html('<tr><td colspan="5" class="text-center py-4"><div class="spinner-border text-primary"></div></td></tr>');
  foot.empty();

  // Fetch server-side total (all orders) and the current page list in parallel.
  Promise.all([
    apiGet('/admin/revenue'),
    fetchOrdersList()
  ]).then(([revenue, orders]) => {
    if (orders.length === 0) {
      tbody.html('<tr><td colspan="5" class="text-center text-muted py-4">No orders yet.</td></tr>');
      foot.html(revenueFooter(revenue));
      return;
    }
    tbody.empty();
    orders.forEach((o) => {
      const counted = countsAsRevenue(o);
      const id = escapeHtml(String(o._id));
      tbody.append(`
        <tr class="${counted ? '' : 'text-muted'}">
          <td><a href="#order-${id}">#${id.slice(-8).toUpperCase()}</a></td>
          <td>${escapeHtml(o.customerName)}<br><small class="text-muted">${escapeHtml(o.customerEmail)}</small></td>
          <td>${escapeHtml(new Date(o.createdAt).toLocaleDateString())}</td>
          <td>${getStatusBadge(o.status)}${paymentMethodBadge(o)}</td>
          <td class="text-end ${counted ? '' : 'text-decoration-line-through'}">${escapeHtml(TLMoney.fixed(Number(o.totalAmount)))}</td>
        </tr>`);
    });
    // Footer shows the accurate server-side total, not a client-side page sum.
    foot.html(revenueFooter(revenue));
  }).catch(() => tbody.html('<tr><td colspan="5" class="text-center text-danger py-4">Failed to load orders.</td></tr>'));
}

function loadReviews(page = 1) {
  const tbody = $('#reviewsTable');
  const hiddenOnly = $('#reviewsHiddenOnly').is(':checked');
  tbody.html('<tr><td colspan="6" class="text-center py-4"><div class="spinner-border text-primary"></div></td></tr>');
  apiGet(`/admin/reviews?page=${page}${hiddenOnly ? '&hidden=true' : ''}`)
    .then((data) => {
      const list = data.reviews || [];
      $('#reviewsPager').empty();
      if (!list.length) {
        tbody.html('<tr><td colspan="6" class="text-center text-muted py-4">No reviews yet.</td></tr>');
        return;
      }
      tbody.empty();
      const canEdit = can('product.edit');
      list.forEach((r) => {
        const stars = '\u2605'.repeat(Number(r.rating) || 0) + '\u2606'.repeat(5 - (Number(r.rating) || 0));
        tbody.append(`
          <tr class="${r.hidden ? 'table-secondary' : ''}">
            <td><small>${escapeHtml(new Date(r.createdAt).toLocaleString())}</small></td>
            <td>${escapeHtml(r.productTitle)}</td>
            <td>${escapeHtml(r.authorName)}</td>
            <td><span style="color:#d4af37" aria-label="${escapeHtml(String(r.rating))} out of 5">${stars}</span></td>
            <td>${escapeHtml(r.text || '')}${r.hidden ? ' <span class="badge bg-secondary">hidden</span>' : ''}</td>
            <td>${canEdit ? `
              <button class="btn btn-sm btn-outline-secondary review-toggle-btn" data-id="${escapeHtml(String(r._id))}" data-hidden="${r.hidden ? 'false' : 'true'}">${r.hidden ? 'Show' : 'Hide'}</button>
              <button class="btn btn-sm btn-outline-danger review-delete-btn" data-id="${escapeHtml(String(r._id))}">Delete</button>` : ''}</td>
          </tr>`);
      });
      const p = data.pagination || {};
      if (p.pages > 1) {
        $('#reviewsPager').html(`
          <span class="text-muted small">Page ${p.page} of ${p.pages} (${p.total} reviews)</span>
          <div>
            <button class="btn btn-sm btn-outline-secondary me-2" id="reviewsPrev" ${p.page <= 1 ? 'disabled' : ''}>Previous</button>
            <button class="btn btn-sm btn-outline-secondary" id="reviewsNext" ${p.page >= p.pages ? 'disabled' : ''}>Next</button>
          </div>`);
        $('#reviewsPrev').on('click', () => loadReviews(p.page - 1));
        $('#reviewsNext').on('click', () => loadReviews(p.page + 1));
      }
    })
    .catch(() => tbody.html('<tr><td colspan="6" class="text-center text-danger py-4">Could not load reviews.</td></tr>'));
}
$(document).on('change', '#reviewsHiddenOnly', () => loadReviews(1));
$(document).on('click', '.review-toggle-btn', function () {
  jsonRequest(`/admin/reviews/${$(this).data('id')}`, 'PUT', { hidden: String($(this).data('hidden')) === 'true' })
    .then(() => loadReviews(1))
    .catch((err) => showAlert('Failed: ' + (err.responseJSON?.message || err.message || 'Unknown error'), 'danger'));
});
$(document).on('click', '.review-delete-btn', function () {
  if (!confirm('Delete this review for good?')) return;
  jsonRequest(`/admin/reviews/${$(this).data('id')}`, 'DELETE')
    .then(() => loadReviews(1))
    .catch((err) => showAlert('Failed: ' + (err.responseJSON?.message || err.message || 'Unknown error'), 'danger'));
});

function loadAuditLog(page = 1) {
  const tbody = $('#auditLogTable');
  tbody.html('<tr><td colspan="5" class="text-center py-4"><div class="spinner-border text-primary"></div></td></tr>');
  apiGet(`/admin/audit-log?limit=50&page=${page}`)
    .then(data => {
      const entries = data.entries || [];
      if (!entries.length) {
        tbody.html('<tr><td colspan="5" class="text-center text-muted py-4">No audit log entries yet.</td></tr>');
        return;
      }
      tbody.empty();
      entries.forEach(e => {
        tbody.append(`
          <tr>
            <td><small>${new Date(e.createdAt).toLocaleString()}</small></td>
            <td><code>${escapeHtml(e.action)}</code></td>
            <td>${escapeHtml(e.targetType || '')} <small class="text-muted">${escapeHtml(String(e.targetId || '').slice(-8).toUpperCase())}</small></td>
            <td>${escapeHtml(e.actor || 'system')}</td>
            <td><small class="text-muted">${escapeHtml(e.ip || '')}</small></td>
          </tr>`);
      });
    })
    .catch(() => tbody.html('<tr><td colspan="5" class="text-center text-danger py-4">Failed to load audit log.</td></tr>'));
}

let editNewImageData = null; // base64 chosen in the edit form, if any
// Stock per size in the add and edit forms (see public/js/size-grid.js).
const addGrid  = SizeGrid.mount(document.getElementById('addSizeGrid'), document.getElementById('stock'));
const editGrid = SizeGrid.mount(document.getElementById('editSizeGrid'), document.getElementById('editStock'));
addGrid.set(null); editGrid.set(null);
// Extra pictures in the add and edit forms (public/js/gallery-editor.js). A chosen file is
// uploaded at once and kept as a file.
const uploadPicture = (dataUri) => jsonRequest('/admin/upload-image', 'POST', { data: dataUri }).then((r) => r.url);
const addGallery  = GalleryEditor.mount(document.getElementById('addGallery'), uploadPicture);
const editGallery = GalleryEditor.mount(document.getElementById('editGallery'), uploadPicture);

function loadEditProduct(id) {
  editNewImageData = null;
  $('#editImageFile').val('');
  fetchProductsList().then((products) => {
    const p = products.find(x => String(x._id) === id);
    if (!p) { showAlert('Product not found.', 'danger'); window.location.hash = 'products-section'; return; }
    $('#editId').val(p._id);
    $('#editTitle').val(p.title);
    $('#editPrice').val(p.price);
    $('#editStock').val(p.stock).data('loaded', p.stock);
    editGrid.set(p.sizeStock || null);   // stock per size, when this product keeps it per size
    editGallery.set(p.images || []);
    // A product from before the category list may carry an old value: keep it selectable so saving
    // does not change it.
    const $editCat = $('#editCategory');
    $editCat.find('option[data-legacy]').remove();
    if (p.category && !$editCat.find('option').filter(function () { return this.value === p.category; }).length) {
      $editCat.append($('<option data-legacy="1"></option>').val(p.category).text(p.category + ' (old category)'));
    }
    $editCat.val(p.category || '');
    $('#editDescription').val(p.description || '');
    $('#editImageUrl').val(p.imageUrl && !p.imageUrl.startsWith('data:') ? p.imageUrl : '').data('original', p.imageUrl || '');
    $('#editPreviewImg').attr('src', p.imageUrl || '/img/logo.svg');
  }).catch(() => showAlert('Failed to load product.', 'danger'));
}

// Load a single order: one printable invoice-style page
function loadOrderDetail(orderId) {
  $('#orderDetailContent').html(`
    <div class="text-center py-5">
      <div class="spinner-border text-primary" role="status">
        <span class="visually-hidden">Loading order...</span>
      </div>
    </div>
  `);

  apiGet(`/admin/orders/${orderId}`)
    .catch((err) => {
      if (err.status !== 401) {
        $('#orderDetailContent').html(`<div class="alert alert-danger">${escapeHtml((err.responseJSON && err.responseJSON.message) || 'Order not found.')}</div>`);
      }
      return null;
    })
    .then((data) => {
      if (!data) return;
      const o = data;
      const addr = o.deliveryAddress || {};
      const orderNo = '#' + String(o._id).slice(-8).toUpperCase();
      const itemsRows = (o.items || []).map(i => `
        <tr>
          <td>${escapeHtml(i.title)}${i.size ? ` <span class="text-muted">(${escapeHtml(i.size)})</span>` : ''}</td>
          <td class="text-center">${escapeHtml(String(i.quantity))}</td>
          <td class="text-end">${escapeHtml(TLMoney.fixed(Number(i.price)))}</td>
          <td class="text-end">${escapeHtml(TLMoney.fixed((i.price * i.quantity)))}</td>
        </tr>`).join('');

      // With a coupon the invoice shows the items' total, the discount and what was charged.
      const shippingFee = Number(o.shippingAmount) || 0;
      const shippingRow = shippingFee > 0
        ? `<tr><td colspan="3" class="text-end text-muted">Shipping</td><td class="text-end text-muted">${escapeHtml(TLMoney.fixed(shippingFee))}</td></tr>`
        : '';
      const discountRows = Number(o.discountAmount) > 0
        ? `<tr><td colspan="3" class="text-end text-muted">Subtotal</td><td class="text-end text-muted">${escapeHtml(TLMoney.fixed((Number(o.totalAmount) - shippingFee + Number(o.discountAmount))))}</td></tr>
           <tr><td colspan="3" class="text-end text-success">Discount${o.couponCode ? ` (${escapeHtml(o.couponCode)})` : ''}</td><td class="text-end text-success">-${escapeHtml(TLMoney.fixed(Number(o.discountAmount)))}</td></tr>`
        : '';

      $('#orderDetailContent').html(`
        <div class="invoice">
          <div class="invoice-header">
            <div class="invoice-brand"><img src="/img/logo.svg" alt="${escapeHtml(window.SITE_NAME || '')}" style="border-radius:50%;object-fit:cover;"><span>${escapeHtml(window.SITE_NAME || '')}</span></div>
            <div class="invoice-meta">
              <div><strong>Order ${escapeHtml(orderNo)}</strong></div>
              <div>${escapeHtml(new Date(o.createdAt).toLocaleString())}</div>
            </div>
          </div>
          <div class="invoice-body">
            <div class="row g-4 mb-4">
              <div class="col-sm-4 invoice-block">
                <h6>Customer</h6>
                <p><strong>${escapeHtml(o.customerName)}</strong></p>
                <p>${escapeHtml(o.customerEmail)}</p>
                <p>${escapeHtml(o.customerPhone || 'N/A')}</p>
              </div>
              <div class="col-sm-4 invoice-block">
                <h6>Delivery Address</h6>
                <p>${escapeHtml(addr.address || 'N/A')}</p>
                <p>${escapeHtml([addr.city, addr.postcode].filter(Boolean).join(' '))}</p>
                <p>${escapeHtml(addr.country || '')}</p>
              </div>
              <div class="col-sm-4 invoice-block">
                <h6>Order Info</h6>
                <p>Status: ${getStatusBadge(o.status)}${paymentIssueBadge(o)}</p>
                <p>Payment: ${escapeHtml(gatewayLabel(o.paymentGateway))}${paymentMethodBadge(o)}</p>
                <p>Txn: <code>${escapeHtml(o.transactionId || 'N/A')}</code></p>
                ${o.paymentReference ? `<p>Reference: <code>${escapeHtml(o.paymentReference)}</code></p>` : ''}
                ${o.paymentReferenceDuplicate ? duplicateReferenceNote() : ''}
                ${o.paidAt ? `<p>${o.paymentGateway === 'cod' ? 'Cash received' : 'Paid'}: ${escapeHtml(new Date(o.paidAt).toLocaleString())}</p>` : ''}
              </div>
            </div>
            <div class="table-responsive">
              <table class="table mb-0">
                <thead class="table-light">
                  <tr><th>Product</th><th class="text-center">Qty</th><th class="text-end">Price</th><th class="text-end">Subtotal</th></tr>
                </thead>
                <tbody>${itemsRows}</tbody>
                <tfoot>
                  ${discountRows}${shippingRow}
                  <tr><th colspan="3" class="text-end">Total</th><th class="text-end">${escapeHtml(TLMoney.fixed(Number(o.totalAmount)))}</th></tr>
                  ${o.paymentGateway === 'cod' ? `<tr><td colspan="3" class="text-end ${o.paidAt ? 'text-success' : 'text-danger'}">${o.paidAt ? 'Paid in cash' : 'Amount due on delivery'}</td><td class="text-end ${o.paidAt ? 'text-success' : 'text-danger'}">${escapeHtml(o.paidAt ? '0.00' : TLMoney.fixed(Number(o.totalAmount)))}</td></tr>` : ''}
                </tfoot>
              </table>
            </div>
          </div>
          <div class="invoice-footer">Thank you for shopping with ${escapeHtml(window.SITE_NAME || 'us')}. This is a computer-generated order summary.</div>
        </div>
      `);
    })
    .catch(() => {
      $('#orderDetailContent').html('<div class="alert alert-danger">Failed to load order details.</div>');
    });
}

function handleLogin(username, password, otp) {
  // Login is a public endpoint, so no CSRF token is sent.
  // `otp` is the two-factor code; it is only sent when the person typed one.
  fetch('/admin/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(otp ? { username, password, otp } : { username, password })
  })
    .then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw data;
      return data;
    })
    .then(async (data) => {
      if (data.success) {
        csrfToken = data.csrfToken; // Server sends CSRF token on login
        $('#loginError').addClass('d-none');
        $('#otpGroup').addClass('d-none');
        $('#otpCode').val('');
        checkAuth();
      } else {
        $('#loginError').removeClass('d-none').text(data.message || 'Login failed');
      }
    })
    .catch((err) => {
      // The account uses two-factor login: show the code box and ask again.
      if (err && err.twoFactorRequired) {
        $('#otpGroup').removeClass('d-none');
        $('#otpCode').trigger('focus');
      }
      const message = err.message || 'Login failed. Please try again.';
      $('#loginError').removeClass('d-none').text(message);
    });
}

function handleLogout() {
  jsonRequest('/admin/logout', 'POST')
    .then(() => {
      isAuthenticated = false;
      csrfToken = null;
      checkAuth();
    })
    .catch(() => {
      isAuthenticated = false;
      csrfToken = null;
      checkAuth();
    });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    if (!file) { resolve(null); return; }
    if (!file.type.startsWith('image/')) {
      reject(new Error('Please select an image file'));
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      reject(new Error('Image size must be less than 5MB'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(text).replace(/[&<>"']/g, m => map[m]);
}

function loadProducts() {
  if (!isAuthenticated) { checkAuth(); return; }

  const table = $('#productTable');
  table.html('<tr><td colspan="6" class="text-center py-4"><div class="spinner-border text-primary" role="status"></div></td></tr>');

  apiGet('/admin/products')
    .then((products) => {
      table.empty();

      if (!products || products.length === 0) {
        table.html('<tr><td colspan="6" class="text-center text-muted py-4"><i class="bi bi-inbox fs-1 d-block mb-2"></i>No products found. Add your first product above.</td></tr>');
        return;
      }

      products.forEach((p) => {
        const safeTitle    = escapeHtml(p.title);
        const safeDesc     = p.description ? escapeHtml(p.description.substring(0, 50) + (p.description.length > 50 ? '...' : '')) : '';
        const safeCategory = escapeHtml(p.category || 'General');
        const safeImageUrl = escapeHtml(p.imageUrl || '/img/logo.svg');
        const safePrice    = escapeHtml(String(p.price));
        const safeStock    = escapeHtml(String(p.stock));
        const bySize       = p.sizeStock && typeof p.sizeStock === 'object' && Object.keys(p.sizeStock).length > 0;
        const sizeNote     = bySize ? Object.keys(p.sizeStock).map((k) => `${escapeHtml(k.replace('OneSize', 'One Size'))} ${escapeHtml(String(p.sizeStock[k]))}`).join(' - ') : '';
        const safeId       = escapeHtml(String(p._id));

        const row = $(`
          <tr>
            <td>
              <img src="${safeImageUrl}" alt="${safeTitle}" class="img-thumbnail"
                   style="width:50px;height:50px;object-fit:cover;" loading="lazy"
                   data-fallback-src="/img/logo.svg">
            </td>
            <td>
              <strong>${safeTitle}</strong>
              ${safeDesc ? `<br><small class="text-muted">${safeDesc}</small>` : ''}
            </td>
            <td><span class="badge bg-secondary">${safeCategory}</span></td>
            <td>
              <input type="number" class="form-control form-control-sm price-input"
                     data-id="${safeId}" value="${safePrice}" style="width:100px;" min="0" step="0.01" />
            </td>
            <td>
              <input type="number" class="form-control form-control-sm stock-input"
                     data-id="${safeId}" data-original="${safeStock}" value="${safeStock}" style="width:100px;" min="0"
                     ${bySize ? 'disabled title="Stock is kept per size. Use Edit to change it."' : ''} />
              ${bySize ? `<div class="small text-muted mt-1">${sizeNote}</div>` : ''}
            </td>
            <td>
              <div class="btn-group" role="group">
                <a href="#edit-product-${safeId}" class="btn btn-primary btn-sm" title="Edit details">
                  <i class="bi bi-pencil"></i>
                </a>
                <button class="btn btn-success btn-sm update-btn" data-id="${safeId}" title="Quick save price/stock">
                  <i class="bi bi-check-lg"></i>
                </button>
                <button class="btn btn-danger btn-sm delete-btn" data-id="${safeId}" title="Delete">
                  <i class="bi bi-trash"></i>
                </button>
              </div>
            </td>
          </tr>
        `);
        table.append(row);
      });

      updateStats();
    })
    .catch((err) => {
      console.error('Failed to load products:', err);
      if (err.status !== 401) table.html('<tr><td colspan="6" class="text-center text-danger py-4">Failed to load products.</td></tr>');
    });
}

let ordersPage = 1;
let ordersStatusFilter = '';

// Shown on an order whose manual-payment reference is also on another order.
function duplicateReferenceNote() {
  return '<div class="alert alert-warning py-1 px-2 small mb-2"><i class="bi bi-exclamation-triangle me-1"></i>Same payment reference on another order: confirm only the order the transfer belongs to</div>';
}

// Draws one page of orders. `page` 1 replaces the list; later pages are appended
// by the "Load more" button, so the admin can reach every order, not just the newest 50.
function loadOrders(page = 1) {
  if (!isAuthenticated) { checkAuth(); return; }
  ordersPage = page;

  fetchOrdersPage(page, ordersStatusFilter)
    .then((data) => {
      const orders = data.orders || [];
      const pg = data.pagination || { page, pages: 1, total: orders.length };
      const container = $('#ordersList');
      if (page === 1) container.empty();
      container.find('.orders-more').remove();

      if (page === 1 && orders.length === 0) {
        container.html('<p class="text-muted text-center py-4">No orders found.</p>');
        updateStats();
        return;
      }

      orders.forEach((o) => {
        const safeName   = escapeHtml(o.customerName);
        const safeEmail  = escapeHtml(o.customerEmail);
        const itemsText  = o.items.map(i => `${escapeHtml(i.title)}${i.size ? ` (${escapeHtml(i.size)})` : ''} x ${Number(i.quantity)}`).join(', ');
        const statusBadge = getStatusBadge(o.status) + paymentMethodBadge(o) + paymentIssueBadge(o) + (o.paymentReferenceDuplicate ? ' <span class="badge bg-warning text-dark" title="Same payment reference on another order">Same reference</span>' : '');
        const canMarkPaid = o.paymentGateway === 'cod' && o.status === 'DELIVERED' && !o.paidAt;
        const markPaidBtn = canMarkPaid
          ? `<button type="button" class="btn btn-sm btn-success cod-paid-btn me-2" data-id="${escapeHtml(String(o._id))}"><i class="bi bi-cash-coin me-1"></i>Mark cash received</button>`
          : '';
        const safeTotal  = escapeHtml(TLMoney.fixed(Number(o.totalAmount)));
        const safeDate   = escapeHtml(new Date(o.createdAt).toLocaleString());
        const safeId     = escapeHtml(String(o._id));
        const safeStatus = escapeHtml(o.status);
        const couponLine = Number(o.discountAmount) > 0
          ? `<div class="mb-2 small text-success"><i class="bi bi-ticket-perforated me-1"></i>Coupon <code>${escapeHtml(o.couponCode || '')}</code>: -${escapeHtml(TLMoney.fixed(Number(o.discountAmount)))}</div>`
          : '';
        const refLine = o.paymentReference
          ? `<div class="mb-2 small"><i class="bi bi-receipt me-1"></i>Payment reference: <code>${escapeHtml(o.paymentReference)}</code></div>`
          : (o.paymentIssue === 'PAYMENT_UNCONFIRMED' && o.valId
            ? `<div class="mb-2 small"><i class="bi bi-receipt me-1"></i>Gateway validation ID: <code>${escapeHtml(o.valId)}</code></div>`
            : '');
        const dupRefLine = o.paymentReferenceDuplicate ? duplicateReferenceNote() : '';
        const refundLine = o.refundedAt
          ? `<div class="mb-2 small text-success"><i class="bi bi-arrow-counterclockwise me-1"></i>Refunded${o.refundedAmount != null ? ' ' + escapeHtml(TLMoney.fixed(Number(o.refundedAmount))) : ''}${o.refundNote ? ' (' + escapeHtml(o.refundNote) + ')' : ''}</div>`
          : '';

        const canConfirm = o.status === 'PLACED' || (o.status === 'PENDING' && o.paymentIssue === 'PAYMENT_UNCONFIRMED');
        const confirmBtn = canConfirm
          ? `<button type="button" class="btn btn-sm btn-primary confirm-order-btn me-2" data-id="${escapeHtml(String(o._id))}"><i class="bi bi-check-circle me-1"></i>${o.paymentGateway === 'manual' ? 'Payment received, confirm' : (o.status === 'PENDING' ? 'Payment checked, confirm' : 'Confirm Order')}</button>`
          : '';
        const canMarkRefunded = o.paymentIssue === 'REFUND_DUE' || o.paymentIssue === 'PAID_AFTER_CANCEL';
        const markRefundedBtn = canMarkRefunded
          ? `<button type="button" class="btn btn-sm btn-warning mark-refunded-btn me-2" data-id="${escapeHtml(String(o._id))}"><i class="bi bi-arrow-counterclockwise me-1"></i>Mark Refunded</button>`
          : '';

        // The server says which changes are legal for this order right now, so the
        // dropdown never offers a step that would be refused.
        const allowed = Array.isArray(o.allowedStatuses) ? o.allowedStatuses : [];
        const options = [safeStatus, ...allowed.map(escapeHtml)]
          .map(st => `<option value="${st}" ${st === safeStatus ? 'selected' : ''}>${st}${st === 'PENDING' ? ' (unpaid)' : ''}</option>`)
          .join('');
        const selectDisabled = allowed.length === 0 ? 'disabled' : '';

        const card = $(`
          <div class="border rounded p-3 mb-3">
            <div class="d-flex justify-content-between align-items-start mb-2">
              <div>
                <strong><i class="bi bi-person me-2"></i>${safeName}</strong>
                <div class="text-muted small"><i class="bi bi-envelope me-1"></i>${safeEmail}</div>
              </div>
              <div class="text-end">
                ${statusBadge}
                <select class="form-select form-select-sm mt-2 status-select" data-id="${safeId}" style="width:auto;display:inline-block;" ${selectDisabled}>
                  ${options}
                </select>
              </div>
            </div>
            <div class="mb-2"><strong>Items:</strong> ${itemsText}</div>
            ${couponLine}
            ${refLine}
            ${dupRefLine}
            ${refundLine}
            <div class="d-flex justify-content-between align-items-center">
              <div><strong>Total:</strong> <span class="text-primary fs-5">${safeTotal}</span></div>
              <small class="text-muted"><i class="bi bi-clock me-1"></i>${safeDate}</small>
            </div>
            <div class="text-end mt-2">
              ${confirmBtn}
              ${markRefundedBtn}
              ${markPaidBtn}
              <a href="#order-${safeId}" class="btn btn-sm btn-outline-primary view-order-btn" data-id="${safeId}">
                <i class="bi bi-eye me-1"></i>View Details
              </a>
            </div>
          </div>
        `);
        container.append(card);
      });

      const shown = container.children('.border').length;
      if (pg.page < pg.pages) {
        container.append(`<div class="text-center orders-more"><button type="button" class="btn btn-outline-primary load-more-orders">Load more orders</button><div class="small text-muted mt-1">Showing ${shown} of ${pg.total}</div></div>`);
      }
      updateStats();
    })
    .catch((err) => {
      console.error('Failed to load orders:', err);
      if (err.status !== 401) showAlert('Failed to load orders', 'danger');
    });
}

// One small request; calls are merged so a burst of live events causes one refresh.
let statsTimer = null;
function updateStats() {
  clearTimeout(statsTimer);
  statsTimer = setTimeout(() => {
    apiGet('/admin/stats')
      .then((d) => {
        $('#totalProducts').text(d.productCount);
        $('#lowStockItems').text(d.lowStock + d.outOfStock);
        $('#totalOrders').text(d.totalOrders);
        $('#totalRevenue').text(TLMoney.fixed((d.totalRevenue || 0)));
        if (d.commissionEarned !== undefined) {
          $('.multivendor-stat').removeClass('d-none');
          $('#commissionEarned').text(TLMoney.fixed(d.commissionEarned));
          $('#storeRevenue').text(TLMoney.fixed(d.storeRevenue));
        } else {
          $('.multivendor-stat').addClass('d-none');
        }
      })
      .catch(() => { /* the cards keep their last numbers; a 401 is handled in readJson */ });
  }, 200);
}

// Red flag for orders whose payment arrived after the order had been cancelled: the customer was
// charged, so the owner has to reopen the order or refund it.
function paymentIssueBadge(order) {
  if (order.paymentIssue === 'PAID_AFTER_CANCEL') {
    return ' <span class="badge bg-danger" title="The customer paid after this order was cancelled. Set the status back to CONFIRMED to reopen it (stock is taken again), or refund the payment.">Paid after cancellation</span>';
  }
  if (order.paymentIssue === 'REFUND_DUE') {
    return ' <span class="badge bg-warning text-dark" title="This order was cancelled but money may have been received (it was paid, or the customer reported paying). Check your bank or gateway and refund if so, then press Mark Refunded.">Refund Due</span>';
  }
  if (order.paymentIssue === 'PAYMENT_UNCONFIRMED') {
    const why = order.paymentGateway === 'manual'
      ? 'The customer reports having paid by transfer. Check your bank or wallet, then confirm the order. If it is not verified in time it is cancelled and flagged Refund Due.'
      : 'The payment gateway flagged this payment as risky. Check it in the gateway panel, then confirm or cancel the order.';
    return ` <span class="badge bg-warning text-dark" title="${why}">Payment unconfirmed</span>`;
  }
  return '';
}

// "COD / unpaid" until the admin records the cash, then "COD / paid".
function paymentMethodBadge(order) {
  if (order.paymentGateway !== 'cod') return '';
  return order.paidAt
    ? ' <span class="badge bg-success">COD / paid</span>'
    : ' <span class="badge bg-warning text-dark">COD / unpaid</span>';
}

function gatewayLabel(gateway) {
  if (gateway === 'cod')    return 'Cash on Delivery';
  if (gateway === 'manual') return 'Manual Payment (Bank Transfer)';
  const names = { stripe: 'Stripe (International)', paypal: 'PayPal (International)', flutterwave: 'Flutterwave (International)', mollie: 'Mollie (International)' };
  return names[gateway] || 'SSLCommerz';
}

function getStatusBadge(status) {
  const badges = {
    'PENDING': 'bg-light text-dark border', 'PLACED': 'bg-secondary', 'CONFIRMED': 'bg-info',
    'SHIPPED': 'bg-primary',  'DELIVERED': 'bg-success', 'CANCELLED': 'bg-danger'
  };
  return `<span class="badge ${badges[status] || 'bg-secondary'}">${status}</span>`;
}

function showAlert(message, type = 'info') {
  const cls = type === 'success' ? 'alert-success' : type === 'danger' ? 'alert-danger' : 'alert-info';
  // The message is set as TEXT: some messages contain product titles typed by sellers.
  const alert = $(`
    <div class="alert ${cls} alert-dismissible fade show position-fixed top-0 start-50 translate-middle-x mt-3"
         style="z-index:9999;min-width:300px;" role="alert">
      <span class="alert-msg"></span>
      <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    </div>
  `);
  alert.find('.alert-msg').text(String(message));
  $('body').append(alert);
  setTimeout(() => alert.fadeOut(() => alert.remove()), 3000);
}

function showFieldError(selector, message) {
  const field = $(selector);
  field.addClass('is-invalid');
  if (!field.next('.invalid-feedback').length) {
    // The message is set as TEXT: it can contain something a seller or customer typed.
    field.after($('<div class="invalid-feedback"></div>').text(String(message)));
  } else {
    field.next('.invalid-feedback').text(message);
  }
}

// Price and coupon inputs step by the smallest unit of the shop currency (1, 0.01 or 0.001).
function applyMoneySteps() {
  const step = String(Math.pow(10, -TLMoney.decimals()));
  $('#price, #editPrice, #couponMinOrder').attr('step', step);
  $('#couponMaxDiscount').attr({ step, min: step });
  // A percentage has 2 decimals in every currency.
  const percent = $('#couponType').val() === 'percent';
  $('#couponValue').attr({ step: percent ? '0.01' : step, min: percent ? '0.01' : step });
}

// Lists drawn before the shop's decimals were known are drawn again.
function redrawMoney(e) {
  applyMoneySteps();
  if (!isAuthenticated || !e.detail || !e.detail.decimalsChanged) return;
  if (can('product.view')) loadProducts();
  if (can('order.view')) loadOrders();
  showSectionFromHash();
}

$(function () {
  checkAuth();
  applyMoneySteps();
  document.addEventListener('brand:ready', redrawMoney);
  $('#couponType').on('change', applyMoneySteps);
  document.getElementById('couponModal').addEventListener('show.bs.modal', applyMoneySteps);

  $('#loginForm').on('submit', function (e) {
    e.preventDefault();
    const username = $('#username').val().trim();
    const password = $('#password').val();
    if (!username || !password) {
      $('#loginError').removeClass('d-none').text('Please enter both username and password');
      return;
    }
    handleLogin(username, password, ($('#otpCode').val() || '').trim());
  });

  $('#logoutBtn').on('click', handleLogout);

  $('#imageFile').on('change', function (e) {
    const file = e.target.files[0];
    if (file) {
      fileToBase64(file)
        .then((base64) => {
          $('#imagePreview').show();
          $('#previewImg').attr('src', base64);
          $('#clearImageBtn').show();
          $('#imageUrl').val('');
        })
        .catch((err) => {
          showAlert(err.message, 'danger');
          $(this).val('');
        });
    }
  });

  $('#clearImageBtn').on('click', function () {
    $('#imageFile').val('');
    $('#imagePreview').hide();
    $('#previewImg').attr('src', '');
    $('#clearImageBtn').hide();
    $('#imageUrl').val('');
  });

  $('#imageUrl').on('input', function () {
    const url = $(this).val().trim();
    if (url) {
      $('#imageFile').val('');
      $('#imagePreview').hide();
      $('#clearImageBtn').hide();
      if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:image/')) {
        $('#imagePreview').show();
        $('#previewImg').attr('src', url);
      }
    } else {
      $('#imagePreview').hide();
    }
  });

  $('#resetFormBtn').on('click', function () {
    $('#addProductForm')[0].reset();
    $('#imagePreview').hide();
    $('#clearImageBtn').hide();
    $('.is-invalid').removeClass('is-invalid');
    $('.invalid-feedback').remove();
  });

  // Live events from the server. A burst (several orders at once) is merged into
  // one refresh each, and the "Load more" position is kept by reloading only page 1.
  const refreshProducts = debounceAdmin(() => { if (isAuthenticated && can('product.view')) loadProducts(); }, 400);
  const refreshOrders   = debounceAdmin(() => { if (isAuthenticated && can('order.view')) loadOrders(); }, 400);
  socket.on('productUpdate', refreshProducts);
  socket.on('newOrder',      refreshOrders);
  socket.on('orderUpdate',   refreshOrders);

  // Sidebar navigation: each link opens a section, tracked in the URL hash
  $('.admin-sidebar .nav-link').on('click', function (e) {
    e.preventDefault();
    const sectionId = $(this).attr('href').replace('#', '');
    if (window.location.hash === '#' + sectionId) {
      showSection(sectionId);
    } else {
      window.location.hash = sectionId;
    }
  });
  $('#backToOrdersBtn').on('click', function (e) {
    e.preventDefault();
    window.location.hash = 'orders-section';
  });
  window.addEventListener('hashchange', showSectionFromHash);

  $('#addProductForm').on('submit', async function (e) {
    e.preventDefault();
    if (!isAuthenticated) { showAlert('Please login first', 'danger'); return; }

    $('.is-invalid').removeClass('is-invalid');
    $('.invalid-feedback').remove();

    const title       = $('#title').val().trim();
    const priceInput  = $('#price').val().trim();
    const stockInput  = $('#stock').val().trim();
    const sizesPart   = addGrid.payload(false);
    const category    = $('#category').val();
    const description = $('#description').val().trim();

    let hasErrors = false;
    if (!title || title.length < 2) { showFieldError('#title', 'Title is required (min 2 chars).'); hasErrors = true; }
    const price = parseFloat(priceInput);
    if (!priceInput || isNaN(price) || price < 0) { showFieldError('#price', 'Valid price required.'); hasErrors = true; }
    const stock = parseInt(stockInput, 10);
    if (!sizesPart.ok) { showAlert(sizesPart.message, 'danger'); return; }
    if (!sizesPart.usesSizes && (!stockInput || isNaN(stock) || stock < 0)) { showFieldError('#stock', 'Valid stock required.'); hasErrors = true; }
    if (!category) { showFieldError('#category', 'Choose a category.'); hasErrors = true; }
    if (hasErrors) { showAlert('Please fix the errors before submitting.', 'danger'); return; }

    let imageUrl = '';
    const imageFile = $('#imageFile')[0].files[0];
    if (imageFile) {
      try { imageUrl = await fileToBase64(imageFile); }
      catch (err) { showAlert(err.message, 'danger'); return; }
    } else {
      imageUrl = $('#imageUrl').val().trim();
    }

    const submitBtn  = $(this).find('button[type="submit"]');
    const origText   = submitBtn.html();
    submitBtn.prop('disabled', true).html('<span class="spinner-border spinner-border-sm me-2"></span>Adding...');

    jsonRequest('/admin/products', 'POST', { title, price, stock, imageUrl, category, description, images: addGallery.get(), ...sizesPart.body })
      .then(() => {
        this.reset();
        addGrid.set(null);
        addGallery.set([]);
        $('#imagePreview').hide();
        $('#clearImageBtn').hide();
        showAlert('Product added successfully!', 'success');
        loadProducts();
        $('html, body').animate({ scrollTop: $('#productTable').offset().top - 100 }, 500);
      })
      .catch((err) => {
        if (err.status === 401) { showAlert('Session expired. Please login again.', 'danger'); checkAuth(); }
        else showAlert('Failed to add product: ' + (err.responseJSON?.message || 'Unknown error'), 'danger');
      })
      .finally(() => submitBtn.prop('disabled', false).html(origText));
  });

  $(document).on('click', '.update-btn', function () {
    const id    = $(this).data('id');
    const price = Number($(`.price-input[data-id="${id}"]`).val());
    const $stockInput = $(`.stock-input[data-id="${id}"]`);
    const stock = Number($stockInput.val());
    if (price < 0 || stock < 0) { showAlert('Price and stock must be non-negative', 'danger'); return; }
    if ($stockInput.prop('disabled')) {
      // Stock kept per size is changed in the edit form; the quick save changes the price only.
      jsonRequest(`/admin/products/${id}`, 'PUT', { price })
        .then(() => { showAlert('Product updated!', 'success'); loadProducts(); })
        .catch((err) => showAlert('Failed to update: ' + (err.responseJSON?.message || 'Unknown error'), 'danger'));
      return;
    }

    // previousStock = what the row showed when it was loaded: the server applies only the change,
    // so units that orders took in the meantime are not put back on sale.
    jsonRequest(`/admin/products/${id}`, 'PUT', { price, stock, previousStock: $stockInput.data('original') })
      .then(() => { showAlert('Product updated!', 'success'); loadProducts(); })
      .catch((err) => showAlert('Failed to update: ' + (err.responseJSON?.message || 'Unknown error'), 'danger'));
  });

  $('#editProductForm').on('submit', function (e) {
    e.preventDefault();
    if (!isAuthenticated) { showAlert('Please login first', 'danger'); return; }
    const id = $('#editId').val();
    const title = $('#editTitle').val().trim();
    const price = parseFloat($('#editPrice').val());
    const stock = parseInt($('#editStock').val(), 10);
    const category = $('#editCategory').val();
    const sizesPart = editGrid.payload(true);
    if (!sizesPart.ok) { showAlert(sizesPart.message, 'danger'); return; }
    if (!id) { showAlert('Open a product from the list first.', 'danger'); return; }
    if (title.length < 2) { showAlert('Title must be at least 2 characters.', 'danger'); return; }
    if (isNaN(price) || price < 0) { showAlert('Enter a valid price.', 'danger'); return; }
    if (isNaN(stock) || stock < 0) { showAlert('Enter a valid stock number.', 'danger'); return; }
    if (!category) { showAlert('Choose a category.', 'danger'); return; }

    const body = {
      title, price, stock, category,
      description: $('#editDescription').val().trim(),
      previousStock: $('#editStock').data('loaded')
    };
    if (sizesPart.usesSizes) { delete body.stock; delete body.previousStock; }   // the total is the sum of the sizes
    Object.assign(body, sizesPart.body);
    body.images = editGallery.get();   // the whole list: pictures that are not in it any more are removed
    // A new picture wins; a changed address is sent; otherwise the picture is left alone.
    const $url = $('#editImageUrl');
    const typedUrl = $url.val().trim();
    if (editNewImageData) body.imageUrl = editNewImageData;
    else if (typedUrl && typedUrl !== ($url.data('original') || '')) body.imageUrl = typedUrl;

    const btn = $(this).find('button[type="submit"]').prop('disabled', true);
    jsonRequest(`/admin/products/${id}`, 'PUT', body)
      .then(() => { showAlert('Product saved.', 'success'); window.location.hash = 'products-section'; loadProducts(); })
      .catch((err) => {
        if (err.status === 401) { showAlert('Session expired. Please login again.', 'danger'); checkAuth(); }
        else showAlert('Failed to save: ' + (err.responseJSON?.message || 'Unknown error'), 'danger');
      })
      .finally(() => btn.prop('disabled', false));
  });

  $('#editImageFile').on('change', async function () {
    try {
      editNewImageData = await fileToBase64(this.files[0]);
      if (editNewImageData) $('#editPreviewImg').attr('src', editNewImageData);
    } catch (e) { showAlert(e.message, 'danger'); this.value = ''; editNewImageData = null; }
  });

  $('#editImageUrl').on('input', function () {
    const url = $(this).val().trim();
    if (url && (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:image/'))) {
      $('#editPreviewImg').attr('src', url);
    }
  });

  $('#printOrderBtn').on('click', function () {
    const btn = $(this).prop('disabled', true);
    const imgs = document.querySelectorAll('#orderDetailContent img');
    const ready = Array.from(imgs).map(img => {
      if (img.complete) return Promise.resolve();
      return new Promise(resolve => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      });
    });
    Promise.race([Promise.all(ready), new Promise(r => setTimeout(r, 1500))])
      .then(() => requestAnimationFrame(() => requestAnimationFrame(() => {
        window.print();
        btn.prop('disabled', false);
      })));
  });

  // Confirm a placed COD or manual-payment order
  $(document).on('click', '.confirm-order-btn', function () {
    const orderId = $(this).data('id');
    if (!confirm('Confirm this order? This means you have verified the customer and are ready to proceed with delivery.')) return;
    const btn = $(this).prop('disabled', true);
    jsonRequest(`/admin/orders/${orderId}/confirm`, 'PUT')
      .then(() => { showAlert('Order confirmed!', 'success'); loadOrders(); })
      .catch((err) => { showAlert('Failed: ' + (err.responseJSON?.message || 'Unknown error'), 'danger'); btn.prop('disabled', false); loadOrders(); });
  });

  // Mark a paid+cancelled order as refunded
  $(document).on('click', '.mark-refunded-btn', function () {
    const orderId = $(this).data('id');
    if (!confirm('Mark refund as processed? This records that the customer has been refunded.')) return;
    // Optional details for the record: how much was refunded (blank = the full amount) and a
    // reference or note.
    const amountText = prompt('Amount refunded (leave blank for the full order total):', '');
    if (amountText === null) return;
    const note = prompt('Refund reference or note (optional, e.g. the bank transfer reference):', '');
    if (note === null) return;
    const refundBody = {};
    if (amountText.trim()) refundBody.amount = amountText.trim();
    if (note.trim()) refundBody.note = note.trim();
    const btn = $(this).prop('disabled', true);
    jsonRequest(`/admin/orders/${orderId}/mark-refunded`, 'PUT', refundBody)
      .then(() => { showAlert('Refund marked as processed.', 'success'); loadOrders(); })
      .catch((err) => { showAlert('Failed: ' + (err.responseJSON?.message || 'Unknown error'), 'danger'); btn.prop('disabled', false); loadOrders(); });
  });

  // Cash on Delivery: record that the cash was received
  $(document).on('click', '.cod-paid-btn', function () {
    const orderId = $(this).data('id');
    if (!confirm('Mark this Cash on Delivery order as paid? Do this only after the cash has been received.')) return;
    const btn = $(this).prop('disabled', true);
    jsonRequest(`/admin/orders/${orderId}/cod-paid`, 'PUT')
      .then(() => { showAlert('Order marked as paid.', 'success'); loadOrders(); })
      .catch((err) => { showAlert('Failed: ' + (err.responseJSON?.message || 'Unknown error'), 'danger'); btn.prop('disabled', false); loadOrders(); });
  });

  $(document).on('click', '.load-more-orders', function () {
    $(this).prop('disabled', true).text('Loading...');
    loadOrders(ordersPage + 1);
  });

  $(document).on('change', '.status-select', function () {
    const orderId   = $(this).data('id');
    const newStatus = $(this).val();

    jsonRequest(`/admin/orders/${orderId}/status`, 'PUT', { status: newStatus })
      .then(() => { showAlert(`Order status updated to ${newStatus}`, 'success'); loadOrders(); })
      .catch((err) => { showAlert('Failed to update status: ' + (err.responseJSON?.message || 'Unknown error'), 'danger'); loadOrders(); });
  });

  $(document).on('click', '.delete-btn', function () {
    const id = $(this).data('id');
    if (!confirm('Are you sure you want to delete this product?')) return;

    jsonRequest(`/admin/products/${id}`, 'DELETE')
      .then(() => { showAlert('Product deleted!', 'success'); loadProducts(); })
      .catch((err) => showAlert('Failed to delete: ' + (err.responseJSON?.message || 'Unknown error'), 'danger'));
  });
});