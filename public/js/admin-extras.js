// Admin extras: CSV product import and two-factor login setup.
(function () {
  const $id = (id) => document.getElementById(id);
  const esc = (v) => escapeHtml(String(v === undefined || v === null ? '' : v));
  const msgOf = (err, fallback) => (err && err.responseJSON && err.responseJSON.message) || fallback;

  function setMsg(el, text, kind) {
    const cls = kind === 'success' ? 'text-success' : kind === 'error' ? 'text-danger' : 'text-muted';
    el.className = `mb-2 ${cls}`;
    el.textContent = text || '';
  }

  let csvText = '';
  let previewed = false;   // Import is only possible right after a successful preview of the

  const ACTION_BADGE = {
    create: ['bg-success', 'New'],
    update: ['bg-primary', 'Update'],
    skip:   ['bg-secondary', 'Skipped'],
    error:  ['bg-danger', 'Error']
  };

  function resetImport() {
    csvText = '';
    previewed = false;
    $id('importFile').value = '';
    $id('importResults').innerHTML = '';
    setMsg($id('importMsg'), '', null);
    $id('importPreviewBtn').disabled = true;
    $id('importApplyBtn').disabled = true;
  }

  function drawImportResult(data) {
    const c = data.counts;
    const badges = ['create', 'update', 'skip', 'error']
      .map((k) => `<span class="badge ${ACTION_BADGE[k][0]} me-1">${c[k]} ${ACTION_BADGE[k][1].toLowerCase()}</span>`).join('');
    const rows = data.results.map((r) => {
      const [cls, label] = ACTION_BADGE[r.action] || ['bg-secondary', r.action];
      return `<tr><td>${esc(r.line)}</td><td>${esc(r.title)}</td><td><span class="badge ${cls}">${esc(label)}</span></td><td class="small text-muted">${esc(r.message || '')}</td></tr>`;
    }).join('');
    $id('importResults').innerHTML =
      `<div class="mb-2">${badges}</div>` +
      `<div class="table-responsive"><table class="table table-sm align-middle"><thead><tr><th>Line</th><th>Title</th><th>Result</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function runImport(dryRun) {
    const mode = $id('importMode').value;
    const previewBtn = $id('importPreviewBtn');
    const applyBtn = $id('importApplyBtn');
    previewBtn.disabled = true;
    applyBtn.disabled = true;
    setMsg($id('importMsg'), dryRun ? 'Checking the file...' : 'Importing...', null);

    return jsonRequest('/admin/products/import', 'POST', { csv: csvText, mode, dryRun })
      .then((data) => {
        drawImportResult(data);
        const c = data.counts;
        if (dryRun) {
          previewed = true;
          const will = c.create + c.update;
          setMsg($id('importMsg'),
            will ? `Ready: ${c.create} new, ${c.update} updated. Rows with errors or skipped rows are left out.` : 'Nothing would be imported from this file.',
            will ? 'success' : 'error');
          applyBtn.disabled = will === 0;
        } else {
          previewed = false;
          setMsg($id('importMsg'), `Done: ${c.create} added, ${c.update} updated, ${c.skip} skipped, ${c.error} with errors.`, c.error ? 'error' : 'success');
          showAlert(`Import finished: ${c.create} added, ${c.update} updated.`, 'success');
          if (typeof loadProducts === 'function' && can('product.view')) loadProducts();
        }
      })
      .catch((err) => {
        previewed = false;
        $id('importResults').innerHTML = '';
        setMsg($id('importMsg'), msgOf(err, 'The import failed. Please try again.'), 'error');
      })
      .finally(() => { previewBtn.disabled = !csvText; if (!previewed) applyBtn.disabled = true; });
  }

  function initImport() {
    const modalEl = $id('importModal');
    if (!modalEl) return;
    $id('importCsvBtn').addEventListener('click', () => {
      resetImport();
      bootstrap.Modal.getOrCreateInstance(modalEl).show();
    });
    $id('importFile').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      previewed = false;
      $id('importApplyBtn').disabled = true;
      $id('importResults').innerHTML = '';
      if (!file) { csvText = ''; $id('importPreviewBtn').disabled = true; return; }
      if (file.size > 1000000) {
        csvText = '';
        $id('importPreviewBtn').disabled = true;
        setMsg($id('importMsg'), 'That file is larger than 1 MB.', 'error');
        return;
      }
      try {
        csvText = await file.text();
        setMsg($id('importMsg'), `${file.name} loaded. Press Preview to check it.`, null);
        $id('importPreviewBtn').disabled = false;
      } catch (err) {
        csvText = '';
        setMsg($id('importMsg'), 'The file could not be read.', 'error');
      }
    });
    // Changing the mode means the preview no longer applies.
    $id('importMode').addEventListener('change', () => {
      previewed = false;
      $id('importApplyBtn').disabled = true;
      $id('importResults').innerHTML = '';
      if (csvText) setMsg($id('importMsg'), 'Mode changed. Press Preview again.', null);
    });
    $id('importPreviewBtn').addEventListener('click', () => { if (csvText) runImport(true); });
    $id('importApplyBtn').addEventListener('click', () => { if (csvText && previewed) runImport(false); });
  }

  const PANELS = ['tfaOff', 'tfaSetup', 'tfaCodes', 'tfaOn'];
  function showPanel(name) {
    PANELS.forEach((p) => $id(p).classList.toggle('d-none', p !== name));
  }

  function loadTwoFactor() {
    setMsg($id('tfaMsg'), 'Loading...', null);
    PANELS.forEach((p) => $id(p).classList.add('d-none'));
    return apiGet('/admin/2fa/status')
      .then((s) => {
        setMsg($id('tfaMsg'), '', null);
        if (s.enabled) {
          $id('tfaLeft').textContent = `${s.backupCodesLeft} backup code${s.backupCodesLeft === 1 ? '' : 's'} left.`;
          showPanel('tfaOn');
        } else {
          showPanel('tfaOff');
        }
      })
      .catch((err) => setMsg($id('tfaMsg'), msgOf(err, 'Could not load the status.'), 'error'));
  }

  function initTwoFactor() {
    const modalEl = $id('securityModal');
    if (!modalEl) return;
    $id('securityBtn').addEventListener('click', () => {
      $id('tfaEnableCode').value = '';
      $id('tfaDisablePassword').value = '';
      $id('tfaDisableCode').value = '';
      bootstrap.Modal.getOrCreateInstance(modalEl).show();
      loadTwoFactor();
    });

    $id('tfaStartBtn').addEventListener('click', () => {
      setMsg($id('tfaMsg'), '', null);
      jsonRequest('/admin/2fa/setup', 'POST')
        .then((data) => {
          $id('tfaSecret').textContent = data.secret.replace(/(.{4})/g, '$1 ').trim();
          $id('tfaLink').setAttribute('href', data.otpauthUrl);
          showPanel('tfaSetup');
        })
        .catch((err) => setMsg($id('tfaMsg'), msgOf(err, 'Could not start the setup.'), 'error'));
    });

    $id('tfaEnableBtn').addEventListener('click', () => {
      const code = $id('tfaEnableCode').value.trim();
      if (!code) { setMsg($id('tfaMsg'), 'Type the 6-digit code from your app.', 'error'); return; }
      jsonRequest('/admin/2fa/enable', 'POST', { code })
        .then((data) => {
          setMsg($id('tfaMsg'), 'Two-factor login is on.', 'success');
          $id('tfaCodesList').textContent = data.backupCodes.join('\n');
          showPanel('tfaCodes');
        })
        .catch((err) => setMsg($id('tfaMsg'), msgOf(err, 'Could not turn it on.'), 'error'));
    });

    $id('tfaDisableBtn').addEventListener('click', () => {
      const password = $id('tfaDisablePassword').value;
      const code = $id('tfaDisableCode').value.trim();
      if (!password || !code) { setMsg($id('tfaMsg'), 'Enter your password and a code.', 'error'); return; }
      jsonRequest('/admin/2fa/disable', 'POST', { password, code })
        .then(() => {
          $id('tfaDisablePassword').value = '';
          $id('tfaDisableCode').value = '';
          setMsg($id('tfaMsg'), 'Two-factor login is off.', 'success');
          showPanel('tfaOff');
        })
        .catch((err) => setMsg($id('tfaMsg'), msgOf(err, 'Could not turn it off.'), 'error'));
    });
  }


  const money = (n) => (window.TLMoney ? window.TLMoney.format(Number(n || 0)) : Number(n || 0).toFixed(2));
  const dateOf = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const V_STATUS = { approved: ['bg-success', 'Approved'], pending: ['bg-warning text-dark', 'Pending'], suspended: ['bg-danger', 'Suspended'] };
  const E_STATE = { pending: ['bg-secondary', 'On its way'], payable: ['bg-success', 'Payable'], paid: ['bg-dark', 'Paid out'], clawback: ['bg-danger', 'Refund due'] };
  const pill = (map, key) => { const [c, t] = map[key] || ['bg-secondary', key]; return `<span class="badge ${c}">${esc(t)}</span>`; };

  function changeVendor(id, body, okText) {
    setMsg($id('vendorsMsg'), 'Saving...', null);
    return jsonRequest('/admin/vendors/' + encodeURIComponent(id), 'PATCH', body)
      .then(() => { setMsg($id('vendorsMsg'), okText, 'success'); return window.loadVendorsPage(); })
      .catch((err) => setMsg($id('vendorsMsg'), msgOf(err, 'Could not save the change.'), 'error'));
  }

  window.loadVendorsPage = function () {
    const box = $id('vendorsTable');
    return apiGet('/admin/vendors').then((vendors) => {
      const edit = can('vendor.edit');
      if (!vendors.length) { box.innerHTML = '<div class="card card-body text-center text-muted py-5">No sellers yet. Applications from the storefront appear here.</div>'; return; }
      const rows = vendors.map((v) => {
        const actions = [];
        if (edit && v.status !== 'approved') actions.push(`<button type="button" class="btn btn-success btn-sm" data-act="status" data-id="${esc(v.id)}" data-status="approved">${v.status === 'pending' ? 'Approve' : 'Reinstate'}</button>`);
        if (edit && v.status === 'approved') actions.push(`<button type="button" class="btn btn-outline-danger btn-sm" data-act="status" data-id="${esc(v.id)}" data-status="suspended">Suspend</button>`);
        actions.push(`<button type="button" class="btn btn-outline-primary btn-sm" data-act="earnings" data-id="${esc(v.id)}" data-name="${esc(v.name)}">Earnings</button>`);
        return `<tr>
          <td><div class="fw-semibold">${esc(v.name)}</div><div class="small text-muted">${esc(v.ownerName)}${v.ownerEmail ? ', ' + esc(v.ownerEmail) : ''}</div><div class="small text-muted">${esc(v.phone)}</div></td>
          <td>${pill(V_STATUS, v.status)}<div class="small text-muted mt-1">${esc(dateOf(v.createdAt))}</div></td>
          <td>${esc(v.products)}</td>
          <td style="min-width:150px;">${edit
            ? `<div class="input-group input-group-sm"><input type="number" min="0" max="90" step="0.5" class="form-control" value="${esc(v.commissionPercent)}" data-commission-for="${esc(v.id)}" aria-label="Commission percent"><span class="input-group-text">%</span><button type="button" class="btn btn-outline-secondary" data-act="commission" data-id="${esc(v.id)}">Save</button></div>`
            : esc(v.commissionPercent) + '%'}</td>
          <td class="text-end text-nowrap">${actions.join(' ')}</td></tr>`;
      }).join('');
      box.innerHTML = `<div class="table-responsive card"><table class="table align-middle mb-0"><thead><tr><th>Shop</th><th>Status</th><th>Products</th><th>Commission</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }).catch((err) => { box.innerHTML = ''; setMsg($id('vendorsMsg'), msgOf(err, 'Could not load the vendors.'), 'error'); });
  };

  function openEarnings(id, name) {
    $id('vendorModalName').textContent = name + ', earnings';
    $id('vendorModalBody').innerHTML = '<div class="text-center py-4"><div class="spinner-border"></div></div>';
    setMsg($id('vendorModalMsg'), '', null);
    bootstrap.Modal.getOrCreateInstance($id('vendorModal')).show();
    apiGet('/admin/vendors/' + encodeURIComponent(id) + '/earnings').then((e) => {
      const t = e.totals;
      const lines = e.lines.map((l) => `<tr><td>${esc(dateOf(l.createdAt))}</td><td>#${esc(l.orderId.slice(-6).toUpperCase())}</td><td>${money(l.gross)}</td><td>${money(l.commission)}</td><td class="fw-semibold">${money(l.net)}</td><td>${pill(E_STATE, l.state)}</td></tr>`).join('');
      const payouts = e.payouts.map((p) => `<li class="list-group-item d-flex justify-content-between"><span>${esc(dateOf(p.createdAt))} - ${esc(p.orders)} order(s)${p.note ? ' - ' + esc(p.note) : ''}</span><strong>${money(p.amount)}</strong></li>`).join('');
      const payBox = can('vendor.edit') && t.payableNow > 0
        ? `<div class="card card-body bg-light mb-3"><div class="mb-2">Pay <strong>${money(t.payableNow)}</strong> to this seller (delivered orders not paid before${t.clawback > 0 ? ', after taking off ' + money(t.clawback) + ' for orders cancelled after an earlier payout' : ''}). Send the money first (bank transfer, mobile banking...), then record it here.</div>
           <div class="input-group"><input type="text" class="form-control" id="payoutNote" maxlength="300" placeholder="Note, e.g. bank transfer reference"><button type="button" class="btn btn-success" id="payoutBtn" data-id="${esc(id)}">Record payout</button></div></div>`
        : '';
      $id('vendorModalBody').innerHTML = `
        <div class="row g-2 mb-3 text-center">
          <div class="col-4"><div class="border rounded p-2"><div class="small text-muted">Payable now</div><div class="fw-bold">${money(t.payableNow)}</div></div></div>
          <div class="col-4"><div class="border rounded p-2"><div class="small text-muted">On its way</div><div class="fw-bold">${money(t.pending)}</div></div></div>
          <div class="col-4"><div class="border rounded p-2"><div class="small text-muted">Paid out</div><div class="fw-bold">${money(t.paidOut)}</div></div></div>
        </div>${payBox}
        ${t.clawback > 0 && !(can('vendor.edit') && t.payableNow > 0) ? `<div class="alert alert-warning py-2 small">This seller owes ${money(t.clawback)} for orders cancelled after they were paid. It is taken off their next payout once enough is payable.</div>` : ''}
        ${e.linesTotal > e.linesShown ? `<p class="small text-muted">Showing the newest ${esc(e.linesShown)} of ${esc(e.linesTotal)} orders. The totals include all of them.</p>` : ''}
        ${e.lines.length ? `<div class="table-responsive mb-3"><table class="table table-sm align-middle"><thead><tr><th>Date</th><th>Order</th><th>Sales</th><th>Commission</th><th>Seller earns</th><th></th></tr></thead><tbody>${lines}</tbody></table></div>` : '<p class="text-muted">No paid orders yet.</p>'}
        ${e.payouts.length ? `<h6>Payouts</h6><ul class="list-group">${payouts}</ul>` : ''}`;
    }).catch((err) => { $id('vendorModalBody').innerHTML = ''; setMsg($id('vendorModalMsg'), msgOf(err, 'Could not load the earnings.'), 'error'); });
  }

  function initVendors() {
    const table = $id('vendorsTable');
    if (!table) return;
    table.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const id = btn.getAttribute('data-id');
      const act = btn.getAttribute('data-act');
      if (act === 'status') {
        const status = btn.getAttribute('data-status');
        if (status === 'suspended' && !window.confirm('Suspend this shop? Its products disappear from the store and cannot be bought until you reinstate it.')) return;
        changeVendor(id, { status }, status === 'approved' ? 'Shop approved.' : 'Shop suspended.');
      } else if (act === 'commission') {
        const input = table.querySelector(`input[data-commission-for="${id}"]`);
        changeVendor(id, { commissionPercent: input ? input.value : '' }, 'Commission saved. It applies to new orders.');
      } else if (act === 'earnings') {
        openEarnings(id, btn.getAttribute('data-name') || 'Seller');
      }
    });
    $id('vendorModal').addEventListener('click', (e) => {
      const btn = e.target.closest('#payoutBtn');
      if (!btn) return;
      const id = btn.getAttribute('data-id');
      if (!window.confirm('Record this payout? Only do this after the money has been sent.')) return;
      btn.disabled = true;
      jsonRequest('/admin/vendors/' + encodeURIComponent(id) + '/payouts', 'POST', { note: ($id('payoutNote') || {}).value || '' })
        .then((r) => { setMsg($id('vendorModalMsg'), `Payout of ${money(r.amount)} recorded.`, 'success'); openEarnings(id, $id('vendorModalName').textContent.replace(/, earnings$/, '')); })
        .catch((err) => { btn.disabled = false; setMsg($id('vendorModalMsg'), msgOf(err, 'Could not record the payout.'), 'error'); });
    });
  }

  // admin.js calls this once the admin is logged in and permissions are known.
  window.onAdminReady = function () {
    $id('importCsvBtn').classList.toggle('d-none', !(can('product.create') || can('product.edit')));
    apiGet('/admin/2fa/status')
      .then((s) => $id('securityBtn').classList.toggle('d-none', !s.featureEnabled))
      .catch(() => {});
    // The Vendors page exists only when the marketplace is on (the server answers 404 otherwise).
    if (can('vendor.view')) {
      apiGet('/admin/vendors').then(() => { $id('vendorsNavLink').style.display = ''; }).catch(() => {});
    }
  };

  document.addEventListener('DOMContentLoaded', () => { initImport(); initTwoFactor(); initVendors(); });
})();
