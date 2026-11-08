// Seller dashboard.
(function () {
  const $ = (id) => document.getElementById(id);
  const money = (n) => (window.TLMoney ? window.TLMoney.format(Number(n || 0)) : Number(n || 0).toFixed(2));
  const lang = () => { const l = window.UI18n && window.UI18n.getLang(); return !l || l === 'en' ? 'en-GB' : l; };
  const T = (key, text, vars) => (window.UI18n ? window.UI18n.t(key, text, vars) : text.replace(/\{(\w+)\}/g, (m, n) => (vars && vars[n] !== undefined ? vars[n] : m)));
  const day = (d) => new Date(d).toLocaleDateString(lang(), { day: 'numeric', month: 'short', year: 'numeric' });

  // h('div', { class: 'x' }, 'text', childNode) returns an element
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') el.className = v; else if (k === 'on') Object.entries(v).forEach(([e, fn]) => el.addEventListener(e, fn)); else el.setAttribute(k, v === true ? '' : v);
    }
    kids.flat().forEach((c) => { if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return el;
  }
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  async function api(method, url, body) {
    const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(data.message || 'Something went wrong.'); err.status = res.status; err.data = data; throw err; }
    return data;
  }
  const setMsg = (el, text, ok) => { el.textContent = text || ''; el.className = 'small mb-2 ' + (ok ? 'text-success' : 'text-danger'); };

  // A picture that fails to load is replaced by the logo (same as the store pages).
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img && img.tagName === 'IMG' && img.dataset && img.dataset.fallbackSrc && !img.dataset.fallbackUsed) { img.dataset.fallbackUsed = '1'; img.src = img.dataset.fallbackSrc; }
  }, true);

  let me = null;          // { vendor, categories }
  let products = [];
  let editingId = null;
  let itemsPage = 1;
  const STATUS = { approved: ['bg-success', 'Approved'], pending: ['bg-warning text-dark', 'Waiting for approval'], suspended: ['bg-danger', 'Suspended'] };
  const FULFIL = { PENDING: ['bg-warning text-dark', 'To ship'], SHIPPED: ['bg-info text-dark', 'Shipped'], DELIVERED: ['bg-success', 'Delivered'] };
  const STATE = { pending: ['bg-secondary', 'On its way'], payable: ['bg-success', 'Ready to pay'], paid: ['bg-dark', 'Paid out'], clawback: ['bg-danger', 'Refund due to the store'] };
  const badge = (map, key) => { const [c, t] = map[key] || ['bg-secondary', key]; return h('span', { class: 'badge ' + c }, t); };

  function message(title, text, ...actions) {
    clear($('vState')).append(h('div', { class: 'card card-body text-center py-5' }, h('h1', { class: 'h4 mb-2' }, title), h('p', { class: 'text-muted mb-3' }, text), h('div', {}, ...actions)));
  }

  async function init() {
    try {
      me = await api('GET', '/api/vendor/me');
    } catch (err) {
      if (err.status === 401) return message('Log in to continue', 'Log in to your ' + (window.SITE_NAME || 'store') + ' account on the store, then come back here.', h('a', { class: 'btn btn-accent', href: '/' }, 'Go to the store'));
      if (err.status === 404) return message('Selling is not open', 'This store is not accepting sellers right now.', h('a', { class: 'btn btn-ink', href: '/' }, 'Back to the store'));
      return message('Something went wrong', err.message);
    }
    if (!me.vendor) return showApply();
    $('vState').replaceChildren();
    $('vApp').classList.remove('d-none');
    drawShop();
    await Promise.all([loadDashboard(), loadProducts(), loadOrders(), loadEarnings()]);
  }

  function showApply() {
    const name = h('input', { class: 'form-control', maxlength: '60', placeholder: 'Shop name' });
    const desc = h('textarea', { class: 'form-control', rows: '3', maxlength: '500', placeholder: 'What do you sell?' });
    const phone = h('input', { class: 'form-control', maxlength: '30', placeholder: 'Phone (optional)' });
    const msg = h('div', { class: 'small mb-2', 'aria-live': 'polite' });
    const btn = h('button', { class: 'btn btn-accent w-100', type: 'button', on: { click: async () => {
      btn.disabled = true;
      try { await api('POST', '/api/vendor/apply', { shopName: name.value, description: desc.value, phone: phone.value }); await init(); }
      catch (err) { setMsg(msg, err.message, false); } finally { btn.disabled = false; }
    } } }, 'Send application');
    clear($('vState')).append(h('div', { class: 'card card-body' }, h('h1', { class: 'h4 mb-1' }, 'Open your shop'),
      h('p', { class: 'text-muted small' }, 'We review every application. You can add products once it is approved.'),
      h('div', { class: 'mb-3' }, name), h('div', { class: 'mb-3' }, desc), h('div', { class: 'mb-3' }, phone), msg, btn));
  }

  function drawShop() {
    const v = me.vendor;
    $('vShopName').textContent = v.name;
    const [c, t] = STATUS[v.status] || ['bg-secondary', v.status];
    $('vStatus').className = 'badge ' + c; $('vStatus').textContent = t;
    $('vCommission').textContent = 'Commission: ' + v.commissionPercent + '% per sale';
    $('vShopLink').setAttribute('href', '/?shop=' + encodeURIComponent(v.slug) + '#products');
    $('vShopLink').classList.toggle('d-none', v.status !== 'approved');
    $('pDesc').value = v.description || ''; $('pPhone').value = v.phone || '';
    const notice = clear($('vNotice'));
    if (v.status === 'pending') notice.append(h('div', { class: 'alert alert-warning' }, 'Your shop is waiting for approval. You will be able to add products as soon as it is approved.'));
    if (v.status === 'suspended') notice.append(h('div', { class: 'alert alert-danger' }, 'Your shop is suspended: your products are hidden and cannot be bought. Please contact the store.'));
    $('addProductBtn').disabled = v.status !== 'approved';
  }

  async function loadDashboard() {
    try {
      const d = await api('GET', '/api/vendor/dashboard');
      const stat = (label, value, hint) => h('div', { class: 'col-6 col-lg' }, h('div', { class: 'card card-body h-100' }, h('div', { class: 'small text-muted' }, label), h('div', { class: 'fs-4 fw-bold' }, value), hint ? h('div', { class: 'small text-muted' }, hint) : null));
      clear($('vStats')).append(
        stat('Products', String(d.products)), stat('Orders to ship', String(d.ordersToShip)),
        stat('Ready to pay', money(d.earnings.payableNow), d.earnings.clawback > 0 ? money(d.earnings.clawback) + ' refund due for cancelled orders' : 'delivered orders'), stat('On its way', money(d.earnings.pending), 'not delivered yet'), stat('Paid out', money(d.earnings.paidOut)));
    } catch (err) { /* the other panes still work */ }
  }

  async function loadProducts() {
    const box = $('vProducts');
    let res;
    try { res = await api('GET', '/api/vendor/products?page=' + itemsPage); products = res.products; } catch (err) { return clear(box).append(h('p', { class: 'text-danger' }, err.message)); }
    if (!products.length && itemsPage === 1) return clear(box).append(h('div', { class: 'card card-body text-center text-muted py-5' }, 'No products yet. Press "Add product" to list your first item.'));
    
    const rows = products.map((p) => h('tr', {},
      h('td', {}, h('img', { src: p.imageUrl || '/img/logo.svg', alt: '', width: '48', height: '60', style: 'object-fit:cover;border-radius:8px;', 'data-fallback-src': '/img/logo.svg' })),
      h('td', { class: 'fw-semibold' }, p.title), h('td', {}, p.category), h('td', {}, money(p.price)),
      h('td', {}, p.stock <= 0 ? h('span', { class: 'badge bg-danger' }, 'Out of stock') : String(p.stock),
        p.sizeStock && Object.keys(p.sizeStock).length ? h('div', { class: 'small text-muted' }, Object.keys(p.sizeStock).map((k) => k.replace('OneSize', 'One Size') + ' ' + p.sizeStock[k]).join(' \u00b7 ')) : ''),
      h('td', { class: 'text-end text-nowrap' },
        h('button', { class: 'btn btn-outline-ink btn-sm me-1', type: 'button', disabled: me.vendor.status !== 'approved', on: { click: () => openProduct(p) } }, 'Edit'),
        h('button', { class: 'btn btn-outline-danger btn-sm', type: 'button', disabled: me.vendor.status !== 'approved', on: { click: () => removeProduct(p) } }, 'Delete'))));
    
    const tableDiv = h('div', { class: 'table-responsive card' }, h('table', { class: 'table align-middle mb-0' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Title'), h('th', {}, 'Category'), h('th', {}, 'Price'), h('th', {}, 'Stock'), h('th', {}, ''))), h('tbody', {}, rows)));
    
    clear(box).append(tableDiv);
    
    if (res.pagination && res.pagination.pages > 1) {
      const p = res.pagination;
      box.append(h('div', { class: 'd-flex justify-content-between align-items-center mt-3' },
        h('span', { class: 'text-muted small' }, 'Page ' + p.page + ' of ' + p.pages + ' (' + p.total + ' items)'),
        h('div', {},
          h('button', { class: 'btn btn-sm btn-outline-secondary prev-items-btn me-2', disabled: p.page <= 1, on: { click: () => { itemsPage--; loadProducts(); } } }, 'Previous'),
          h('button', { class: 'btn btn-sm btn-outline-secondary next-items-btn', disabled: p.page >= p.pages, on: { click: () => { itemsPage++; loadProducts(); } } }, 'Next')
        )
      ));
    }
  }

  const sizeGrid = SizeGrid.mount($('fSizeGrid'), $('fStock'));   // stock per size (public/js/size-grid.js)
  sizeGrid.set(null);
  const gallery = GalleryEditor.mount($('fGallery'), (dataUri) => api('POST', '/api/vendor/upload-image', { data: dataUri }).then((r) => r.url));   // extra pictures
  gallery.set([]);
  let loadedStock = null;
  function openProduct(p) {
    editingId = p ? String(p._id) : null;
    loadedStock = p ? p.stock : null;   // what the form was opened with (the server applies only the change)
    $('productModalTitle').textContent = p ? 'Edit product' : 'Add product';
    const sel = clear($('fCategory'));
    me.categories.forEach((c) => sel.append(h('option', { value: c }, c)));
    $('fTitle').value = p ? p.title : ''; $('fDesc').value = p ? (p.description || '') : '';
    $('fCategory').value = p ? p.category : me.categories[0]; $('fPrice').value = p ? String(p.price) : '';
    $('fStock').value = p ? String(p.stock) : ''; $('fImage').value = '';
    sizeGrid.set(p ? p.sizeStock : null);
    gallery.set(p ? p.images : []);
    $('fImageHint').textContent = p ? 'Leave empty to keep the current picture.' : 'PNG, JPG, WebP or GIF, up to 2 MB.';
    setMsg($('productMsg'), '', true);
    bootstrap.Modal.getOrCreateInstance($('productModal')).show();
  }
  const readFile = (file) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error('The picture could not be read.')); r.readAsDataURL(file); });

  async function saveProduct(e) {
    e.preventDefault();
    const btn = $('productSave'); btn.disabled = true;
    try {
      const body = { title: $('fTitle').value, description: $('fDesc').value, category: $('fCategory').value, price: $('fPrice').value, stock: $('fStock').value };
      if (editingId && loadedStock !== null) body.previousStock = loadedStock;
      const sg = sizeGrid.payload(!!editingId);
      if (!sg.ok) throw new Error(sg.message);
      Object.assign(body, sg.body);
      body.images = gallery.get();
      if (sg.usesSizes) { delete body.previousStock; body.stock = '0'; }   // the total is the sum of the sizes
      const file = $('fImage').files[0];
      if (file) {
        if (file.size > 2 * 1024 * 1024) throw new Error('The picture is larger than 2 MB.');
        body.imageUrl = await readFile(file);
      }
      await api(editingId ? 'PUT' : 'POST', editingId ? '/api/vendor/products/' + encodeURIComponent(editingId) : '/api/vendor/products', body);
      bootstrap.Modal.getInstance($('productModal')).hide();
      await Promise.all([loadProducts(), loadDashboard()]);
    } catch (err) { setMsg($('productMsg'), err.message, false); } finally { btn.disabled = false; }
  }
  async function removeProduct(p) {
    if (!window.confirm(T('vd.confirmDel', 'Delete "{title}"? This cannot be undone.', { title: p.title }))) return;
    try { await api('DELETE', '/api/vendor/products/' + encodeURIComponent(p._id)); await Promise.all([loadProducts(), loadDashboard()]); }
    catch (err) { window.alert(err.message); }
  }

  let ordersPage = 1;
  let needsShipOnly = false;   // "only orders I can ship now"
  async function loadOrders() {
    const box = $('vOrders');
    let res;
    try { res = await api('GET', '/api/vendor/orders?page=' + ordersPage + (needsShipOnly ? '&needs=ship' : '')); } catch (err) { return clear(box).append(h('p', { class: 'text-danger' }, err.message)); }
    const orders = res.orders || res; // new {orders, pagination} or old flat array
    const filterBar = h('label', { class: 'form-check small mb-3' },
      h('input', { type: 'checkbox', class: 'form-check-input me-2', checked: needsShipOnly, on: { change: (ev) => { needsShipOnly = ev.target.checked; ordersPage = 1; loadOrders(); } } }),
      'Show only orders I can ship now');
    if (!orders.length) return clear(box).append(filterBar, h('div', { class: 'card card-body text-center text-muted py-5' }, needsShipOnly ? 'Nothing to ship right now.' : 'No orders yet. Paid orders that include your items appear here.'));
    clear(box).append(filterBar);
    orders.forEach((o) => {
      const a = o.deliveryAddress || {};
      const next = { PENDING: ['SHIPPED', 'Mark as shipped'], SHIPPED: ['DELIVERED', 'Mark as delivered'] }[o.fulfillment.status];
      const canAct = next && me.vendor.status === 'approved' && !['CANCELLED', 'PLACED', 'PENDING'].includes(o.orderStatus);
      const note = h('input', { class: 'form-control form-control-sm', maxlength: '200', placeholder: 'Courier / tracking note (optional)', value: o.fulfillment.note || '' });
      const msg = h('span', { class: 'small text-danger ms-2' });
      box.append(h('div', { class: 'card card-body mb-3' },
        h('div', { class: 'd-flex flex-wrap justify-content-between gap-2 mb-2' },
          h('div', {}, h('span', { class: 'fw-semibold' }, 'Order #' + o.id.slice(-6).toUpperCase()), h('span', { class: 'text-muted small ms-2' }, day(o.createdAt))),
          h('div', {}, o.orderStatus === 'CANCELLED' ? h('span', { class: 'badge bg-danger me-1' }, 'Cancelled') : null, o.orderStatus === 'PLACED' ? h('span', { class: 'badge bg-secondary me-1' }, 'Awaiting store confirmation') : null, badge(FULFIL, o.fulfillment.status))),
        o.customerHidden ? h('div', { class: 'small text-muted mb-2' }, o.customerName) : h('div', { class: 'small mb-2' }, h('strong', {}, o.customerName), ', ', o.customerPhone || 'no phone', h('br'), [a.address, a.city, a.postcode, a.country].filter(Boolean).join(', ')),
        h('ul', { class: 'list-unstyled mb-2' }, o.items.map((i) => h('li', {}, i.quantity + ' x ' + i.title + (i.size ? ' (' + i.size + ')' : '') + ' - ' + money(i.price * i.quantity)))),
        h('div', { class: 'small text-muted mb-2' }, 'You earn ' + money(o.earnings.net) + ' (sales ' + money(o.earnings.gross) + ' minus commission ' + money(o.earnings.commission) + ')'),
        canAct ? h('div', { class: 'd-flex flex-wrap gap-2 align-items-center' }, h('div', { style: 'min-width:220px;flex:1' }, note),
          h('button', { class: 'btn btn-accent btn-sm', type: 'button', on: { click: async (ev) => {
            ev.target.disabled = true;
            try { await api('PATCH', '/api/vendor/orders/' + encodeURIComponent(o.id) + '/fulfillment', { status: next[0], note: note.value }); await Promise.all([loadOrders(), loadDashboard(), loadEarnings()]); }
            catch (err) { msg.textContent = err.message; ev.target.disabled = false; }
          } } }, next[1]), msg) : null));
    });
    
    if (res.pagination && res.pagination.pages > 1) {
      const p = res.pagination;
      box.append(h('div', { class: 'd-flex justify-content-between align-items-center mt-3' },
        h('span', { class: 'text-muted small' }, 'Page ' + p.page + ' of ' + p.pages + ' (' + p.total + ' orders)'),
        h('div', {},
          h('button', { class: 'btn btn-sm btn-outline-secondary me-2', disabled: p.page <= 1, on: { click: () => { ordersPage--; loadOrders(); } } }, 'Previous'),
          h('button', { class: 'btn btn-sm btn-outline-secondary', disabled: p.page >= p.pages, on: { click: () => { ordersPage++; loadOrders(); } } }, 'Next')
        )
      ));
    }
  }

  async function loadEarnings() {
    const box = $('vEarnings');
    let e;
    try { e = await api('GET', '/api/vendor/earnings'); } catch (err) { return clear(box).append(h('p', { class: 'text-danger' }, err.message)); }
    clear(box).append(
      e.totals.clawback > 0 ? h('div', { class: 'alert alert-warning small' }, 'An order was cancelled after you were paid for it. ' + money(e.totals.clawback) + ' will be taken off your next payout.') : null,
      h('p', { class: 'text-muted small' }, 'You earn the price of your items minus the commission. Discounts and shipping fees stay with the store. An order becomes payable once you mark it delivered; the store then pays you and records it here.'),
      e.lines.length ? h('div', { class: 'table-responsive card mb-4' }, h('table', { class: 'table align-middle mb-0' },
        h('thead', {}, h('tr', {}, ['Date', 'Order', 'Sales', 'Commission', 'You earn', 'Status'].map((t) => h('th', {}, t)))),
        h('tbody', {}, e.lines.map((l) => h('tr', {}, h('td', {}, day(l.createdAt)), h('td', {}, '#' + l.orderId.slice(-6).toUpperCase()), h('td', {}, money(l.gross)), h('td', {}, money(l.commission)), h('td', { class: 'fw-semibold' }, money(l.net)), h('td', {}, badge(STATE, l.state))))))) :
        h('div', { class: 'card card-body text-center text-muted py-4 mb-4' }, 'No earnings yet.'),
      e.linesTotal > e.linesShown ? h('p', { class: 'small text-muted' }, 'Showing your newest ' + e.linesShown + ' of ' + e.linesTotal + ' orders. The totals above include all of them.') : null,
      h('h2', { class: 'h6' }, 'Payouts'),
      e.payouts.length ? h('ul', { class: 'list-group' }, e.payouts.map((p) => h('li', { class: 'list-group-item d-flex justify-content-between' }, h('span', {}, h('span', {}, day(p.createdAt)), ' - ', h('span', {}, p.orders === 1 ? '1 order' : p.orders + ' orders'), p.note ? ' - ' + p.note : ''), h('strong', {}, money(p.amount))))) :
        h('p', { class: 'text-muted small' }, 'No payouts yet.'));
  }

  async function saveProfile(e) {
    e.preventDefault();
    try { const r = await api('PUT', '/api/vendor/profile', { description: $('pDesc').value, phone: $('pPhone').value }); me.vendor = r.vendor; setMsg($('profileMsg'), 'Saved.', true); }
    catch (err) { setMsg($('profileMsg'), err.message, false); }
  }

  // The price placeholder follows the shop's decimals (999.00, 999 or 999.000).
  const showPricePlaceholder = () => { $('fPrice').placeholder = window.TLMoney ? window.TLMoney.fixed(999) : '999.00'; };

  document.addEventListener('DOMContentLoaded', () => {
    showPricePlaceholder();
    document.addEventListener('brand:ready', (e) => {
      showPricePlaceholder();
      if (me && me.vendor && e.detail && e.detail.decimalsChanged) Promise.all([loadDashboard(), loadProducts(), loadOrders(), loadEarnings()]);
    });
    $('addProductBtn').addEventListener('click', () => openProduct(null));
    $('productForm').addEventListener('submit', saveProduct);
    $('profileForm').addEventListener('submit', saveProfile);
    init();
  });
})();
