// Coupons page: list, create, edit, switch on/off, delete. Uses helpers from admin.js:
// jsonRequest, showAlert, escapeHtml.
(function () {
  let coupons = [];
  let editingId = null;   // null while creating a new coupon

  const $id = (id) => document.getElementById(id);
  const esc = (v) => escapeHtml(String(v));

  const STATUS_BADGES = {
    active:    ['bg-success', 'Active'],
    disabled:  ['bg-secondary', 'Disabled'],
    scheduled: ['bg-info text-dark', 'Scheduled'],
    expired:   ['bg-warning text-dark', 'Expired'],
    used_up:   ['bg-dark', 'Used up']
  };

  function fail(prefix, err) {
    showAlert(prefix + ((err && err.responseJSON && err.responseJSON.message) || 'Something went wrong.'), 'danger');
  }

  function getJson(url) {
    return apiGet(url);   // from admin.js: also handles an expired session
  }

  // "2026-10-02T14:30" for a <input type="datetime-local"> (browser time zone)
  function toLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const fromLocalInput = (value) => (value ? new Date(value).toISOString() : null);
  const numberOrNull = (value) => (String(value).trim() === '' ? null : Number(value));
  const formatDate = (iso) => (iso ? new Date(iso).toLocaleString() : '');

  window.loadCouponsPage = async function () {
    const body = $id('couponTable');
    try {
      coupons = await getJson('/admin/coupons');
      render();
    } catch (err) {
      body.innerHTML = '<tr><td colspan="7" class="text-center text-danger py-4">Failed to load coupons.</td></tr>';
      fail('Could not load coupons: ', err);
    }
  };

  function render() {
    const body = $id('couponTable');
    if (!coupons.length) {
      body.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-4"><i class="bi bi-ticket-perforated fs-1 d-block mb-2"></i>No coupons yet. Create your first one.</td></tr>';
      return;
    }
    body.innerHTML = coupons.map((c) => {
      const discount = c.type === 'percent' ? `${esc(c.value)}%` : esc(TLMoney.fixed(Number(c.value)));
      const rules = [
        c.minOrderAmount != null ? `Min order ${esc(c.minOrderAmount)}` : '',
        c.type === 'percent' && c.maxDiscount != null ? `Max discount ${esc(c.maxDiscount)}` : ''
      ].filter(Boolean).join('<br>') || '<span class="text-muted">None</span>';
      const valid = (c.startsAt || c.endsAt)
        ? `${c.startsAt ? 'From ' + esc(formatDate(c.startsAt)) : ''}${c.startsAt && c.endsAt ? '<br>' : ''}${c.endsAt ? 'Until ' + esc(formatDate(c.endsAt)) : ''}`
        : '<span class="text-muted">Always</span>';
      const used = (c.usageLimit != null ? `${esc(c.usedCount)} / ${esc(c.usageLimit)}` : `${esc(c.usedCount)}`) +
        (c.perCustomerLimit != null ? `<br><small class="text-muted">${esc(c.perCustomerLimit)} per customer</small>` : '');
      const [badgeClass, badgeText] = STATUS_BADGES[c.status] || ['bg-secondary', c.status];
      const toggleLabel = c.active ? 'Disable' : 'Enable';
      return `<tr>
        <td><code class="fs-6">${esc(c.code)}</code></td>
        <td>${discount}</td>
        <td class="small">${rules}</td>
        <td class="small">${valid}</td>
        <td>${used}</td>
        <td><span class="badge ${badgeClass}">${esc(badgeText)}</span></td>
        <td class="text-end">
          <div class="btn-group btn-group-sm" role="group">
            <button class="btn btn-outline-primary coupon-edit-btn" data-id="${esc(c._id)}" title="Edit"><i class="bi bi-pencil"></i></button>
            <button class="btn btn-outline-secondary coupon-toggle-btn" data-id="${esc(c._id)}" title="${toggleLabel}">${toggleLabel}</button>
            <button class="btn btn-outline-danger coupon-delete-btn" data-id="${esc(c._id)}" title="Delete"><i class="bi bi-trash"></i></button>
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  function syncTypeFields() {
    const percent = $id('couponType').value === 'percent';
    $id('couponMaxDiscountGroup').style.display = percent ? '' : 'none';
    $id('couponValue').max = percent ? '100' : '';
  }

  function openForm(coupon) {
    editingId = coupon ? coupon._id : null;
    $id('couponModalTitle').textContent = coupon ? `Edit coupon ${coupon.code}` : 'New Coupon';
    $id('couponCode').value = coupon ? coupon.code : '';
    $id('couponCode').disabled = !!coupon;   // the code can not be changed
    $id('couponType').value = coupon ? coupon.type : 'percent';
    $id('couponValue').value = coupon ? coupon.value : '';
    $id('couponMinOrder').value = coupon && coupon.minOrderAmount != null ? coupon.minOrderAmount : '';
    $id('couponMaxDiscount').value = coupon && coupon.maxDiscount != null ? coupon.maxDiscount : '';
    $id('couponUsageLimit').value = coupon && coupon.usageLimit != null ? coupon.usageLimit : '';
    $id('couponPerCustomerLimit').value = coupon && coupon.perCustomerLimit != null ? coupon.perCustomerLimit : '';
    $id('couponStartsAt').value = coupon ? toLocalInput(coupon.startsAt) : '';
    $id('couponEndsAt').value = coupon ? toLocalInput(coupon.endsAt) : '';
    $id('couponActive').checked = coupon ? coupon.active : true;
    syncTypeFields();
    bootstrap.Modal.getOrCreateInstance($id('couponModal')).show();
  }

  document.addEventListener('DOMContentLoaded', function () {
    $id('newCouponBtn').addEventListener('click', () => openForm(null));
    $id('couponType').addEventListener('change', syncTypeFields);

    $id('couponForm').addEventListener('submit', function (e) {
      e.preventDefault();
      const payload = {
        type: $id('couponType').value,
        value: Number($id('couponValue').value),
        minOrderAmount: numberOrNull($id('couponMinOrder').value),
        maxDiscount: $id('couponType').value === 'percent' ? numberOrNull($id('couponMaxDiscount').value) : null,
        usageLimit: numberOrNull($id('couponUsageLimit').value),
        perCustomerLimit: numberOrNull($id('couponPerCustomerLimit').value),
        startsAt: fromLocalInput($id('couponStartsAt').value),
        endsAt: fromLocalInput($id('couponEndsAt').value),
        active: $id('couponActive').checked
      };
      const creating = editingId === null;
      if (creating) payload.code = $id('couponCode').value.trim();

      const btn = $id('couponSaveBtn');
      btn.disabled = true;
      jsonRequest(creating ? '/admin/coupons' : `/admin/coupons/${encodeURIComponent(editingId)}`, creating ? 'POST' : 'PUT', payload)
        .then(() => {
          bootstrap.Modal.getOrCreateInstance($id('couponModal')).hide();
          showAlert(creating ? 'Coupon created.' : 'Coupon saved.', 'success');
          loadCouponsPage();
        })
        .catch((err) => fail('Could not save coupon: ', err))
        .finally(() => { btn.disabled = false; });
    });

    $id('couponTable').addEventListener('click', function (e) {
      const btn = e.target.closest('button[data-id]');
      if (!btn) return;
      const coupon = coupons.find((c) => String(c._id) === btn.dataset.id);
      if (!coupon) return;

      if (btn.classList.contains('coupon-edit-btn')) return openForm(coupon);

      if (btn.classList.contains('coupon-toggle-btn')) {
        jsonRequest(`/admin/coupons/${encodeURIComponent(coupon._id)}`, 'PUT', { active: !coupon.active })
          .then(() => { showAlert(`Coupon ${coupon.code} ${coupon.active ? 'disabled' : 'enabled'}.`, 'success'); loadCouponsPage(); })
          .catch((err) => fail('Could not change the coupon: ', err));
        return;
      }

      if (btn.classList.contains('coupon-delete-btn')) {
        if (!confirm(`Delete the coupon "${coupon.code}"? Orders that already used it keep their discount. To stop new orders from using it without deleting it, use Disable instead.`)) return;
        jsonRequest(`/admin/coupons/${encodeURIComponent(coupon._id)}`, 'DELETE')
          .then(() => { showAlert('Coupon deleted.', 'success'); loadCouponsPage(); })
          .catch((err) => fail('Could not delete coupon: ', err));
      }
    });
  });
})();
