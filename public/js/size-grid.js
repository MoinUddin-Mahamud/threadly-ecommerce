// Stock per size for the product forms (admin panel and seller area).
(function () {
  var SIZES = [];
  var ready = fetch('/api/sizes').then(function (res) { return res.ok ? res.json() : { sizes: [] }; })
    .then(function (data) { SIZES = Array.isArray(data.sizes) ? data.sizes : []; })
    .catch(function () { SIZES = []; });
  var key = function (s) { return String(s).replace(/\s+/g, ''); };
  var counter = 0;

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function mount(container, stockInput) {
    counter += 1;
    var toggleId = 'sizeGridToggle' + counter;
    var previous = null;           // the sizeStock the form was opened with (null = one stock number)
    container.textContent = '';

    var wrap = el('div', { class: 'mb-2' });
    var check = el('div', { class: 'form-check' });
    var toggle = el('input', { type: 'checkbox', class: 'form-check-input', id: toggleId });
    var label = el('label', { class: 'form-check-label fw-semibold', for: toggleId }, 'Keep stock for each size');
    check.appendChild(toggle); check.appendChild(label);
    var help = el('div', { class: 'form-text' }, 'Customers can only pick the sizes you fill in. Leave a size empty if you do not sell it; 0 shows it as sold out.');
    var row = el('div', { class: 'row g-2 mt-1', hidden: 'hidden' });
    var inputs = {};
    var built = false;
    var waiting = null;            // a set() that came before the sizes were loaded
    function build() {
      SIZES.forEach(function (s) {
        var col = el('div', { class: 'col-4 col-md-3' });
        var lab = el('label', { class: 'form-label small mb-0' }, s);
        var inp = el('input', { type: 'number', min: '0', max: '100000', step: '1', class: 'form-control form-control-sm', placeholder: 'not sold', 'aria-label': 'Stock for size ' + s });
        inputs[s] = inp;
        col.appendChild(lab); col.appendChild(inp); row.appendChild(col);
        inp.addEventListener('input', refresh);
      });
      built = true;
      if (waiting) { api.set(waiting.value); waiting = null; }
    }
    ready.then(build);
    var total = el('div', { class: 'small text-muted mt-1', hidden: 'hidden' });
    wrap.appendChild(check); wrap.appendChild(help); wrap.appendChild(row); wrap.appendChild(total);
    container.appendChild(wrap);

    function values() {
      var out = {}; var any = false;
      SIZES.forEach(function (s) {
        var v = inputs[s].value.trim();
        if (v !== '') { out[key(s)] = v; any = true; }
      });
      return any ? out : null;
    }
    function sum() {
      var n = 0;
      SIZES.forEach(function (s) { n += parseInt(inputs[s].value, 10) || 0; });
      return n;
    }
    function refresh() {
      var on = toggle.checked;
      row.hidden = !on; total.hidden = !on;
      if (on) {
        total.textContent = 'Total stock: ' + sum();
        if (stockInput) { stockInput.value = String(sum()); stockInput.disabled = true; stockInput.required = false; }
      } else if (stockInput) {
        stockInput.disabled = false;
      }
    }
    toggle.addEventListener('change', refresh);

    var api = {
      set: function (sizeStock) {
        if (!built) { waiting = { value: sizeStock }; return; }
        previous = sizeStock && typeof sizeStock === 'object' && Object.keys(sizeStock).length ? Object.assign({}, sizeStock) : null;
        SIZES.forEach(function (s) {
          var v = previous ? previous[key(s)] : undefined;
          inputs[s].value = v === undefined || v === null ? '' : String(v);
        });
        toggle.checked = !!previous;
        refresh();
      },
      payload: function (isUpdate) {
        if (toggle.checked) {
          var v = values();
          if (!v) return { ok: false, message: 'Enter the stock of at least one size, or turn off "Keep stock for each size".' };
          var body = { sizeStock: v };
          if (isUpdate) body.previousSizeStock = previous || {};
          return { ok: true, usesSizes: true, body: body };
        }
        // Switched off on a product that had sizes: stop keeping stock per size (the total stays as it is).
        if (isUpdate && previous) return { ok: true, usesSizes: false, body: { sizeStock: {} } };
        return { ok: true, usesSizes: false, body: {} };
      }
    };
    return api;
  }

  window.SizeGrid = { mount: mount };
})();
