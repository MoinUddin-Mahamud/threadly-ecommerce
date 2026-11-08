// "More pictures" editor for the product forms (admin panel and seller area). Up to 5 extra
// pictures besides the main one.
(function () {
  var MAX = 5;
  var MAX_BYTES = 2 * 1024 * 1024;
  var TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text !== undefined) e.textContent = text;
    return e;
  }
  // Only addresses this app accepts are ever put into an <img> (no javascript: or other schemes).
  var SAFE_SRC = /^(https?:\/\/[^\s<>"'\\]+|\/(?![\/\\])[^\s<>"'\\]*)$/i;

  function mount(container, upload) {
    var items = [];
    container.textContent = '';
    var wrap = el('div', { class: 'mb-3' });
    var title = el('div', { class: 'fw-semibold mb-1' }, 'More pictures');
    var help = el('div', { class: 'form-text mb-2' }, 'Up to ' + MAX + ' extra pictures (PNG, JPG, WebP or GIF, 2 MB each). The first picture above stays the main one.');
    var list = el('div', { class: 'd-flex flex-wrap gap-2 mb-2' });
    var controls = el('div', { class: 'd-flex flex-wrap gap-2 align-items-center' });
    var file = el('input', { type: 'file', accept: TYPES.join(','), multiple: 'multiple', class: 'form-control form-control-sm', style: 'max-width:260px', 'aria-label': 'Add pictures' });
    var addr = el('input', { type: 'text', class: 'form-control form-control-sm', style: 'max-width:240px', placeholder: 'or a picture address (https://...)', 'aria-label': 'Picture address', maxlength: '500' });
    var addBtn = el('button', { type: 'button', class: 'btn btn-sm btn-outline-secondary' }, 'Add address');
    var msg = el('div', { class: 'small text-danger mt-1', role: 'status' });
    controls.appendChild(file); controls.appendChild(addr); controls.appendChild(addBtn);
    wrap.appendChild(title); wrap.appendChild(help); wrap.appendChild(list); wrap.appendChild(controls); wrap.appendChild(msg);
    container.appendChild(wrap);

    function say(text) { msg.textContent = text || ''; }

    function render() {
      list.textContent = '';
      items.forEach(function (src, i) {
        var box = el('div', { class: 'border rounded p-1 text-center bg-white', style: 'width:96px' });
        var img = el('img', { alt: 'Picture ' + (i + 1), width: '84', height: '84', style: 'object-fit:cover' });
        if (SAFE_SRC.test(src)) img.setAttribute('src', src);
        var row = el('div', { class: 'd-flex justify-content-between mt-1' });
        [['\u25C0', 'Move left', -1], ['\u25B6', 'Move right', 1]].forEach(function (b) {
          var btn = el('button', { type: 'button', class: 'btn btn-sm btn-light py-0 px-1', 'aria-label': b[1], title: b[1] }, b[0]);
          btn.disabled = (b[2] < 0 && i === 0) || (b[2] > 0 && i === items.length - 1);
          btn.addEventListener('click', function () { var j = i + b[2]; var t = items[i]; items[i] = items[j]; items[j] = t; render(); });
          row.appendChild(btn);
        });
        var del = el('button', { type: 'button', class: 'btn btn-sm btn-light text-danger py-0 px-1', 'aria-label': 'Remove picture', title: 'Remove' }, '\u2715');
        del.addEventListener('click', function () { items.splice(i, 1); render(); });
        row.appendChild(del);
        box.appendChild(img); box.appendChild(row); list.appendChild(box);
      });
      var full = items.length >= MAX;
      file.disabled = full; addr.disabled = full; addBtn.disabled = full;
    }

    function readFile(f) {
      return new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onload = function () { resolve(r.result); };
        r.onerror = function () { reject(new Error('Could not read the file.')); };
        r.readAsDataURL(f);
      });
    }

    file.addEventListener('change', function () {
      say('');
      var chosen = Array.prototype.slice.call(file.files || []);
      file.value = '';
      var chain = Promise.resolve();
      chosen.forEach(function (f) {
        chain = chain.then(function () {
          if (items.length >= MAX) return;
          if (TYPES.indexOf(f.type) === -1) { say('Pictures must be PNG, JPG, WebP or GIF.'); return; }
          if (f.size > MAX_BYTES) { say('A picture is larger than 2 MB: ' + f.name); return; }
          return readFile(f).then(upload).then(function (url) { items.push(url); render(); });
        }).catch(function (err) { say(err && err.message ? err.message : 'Upload failed.'); });
      });
    });
    addBtn.addEventListener('click', function () {
      say('');
      var v = addr.value.trim();
      if (!v) return;
      if (!/^https:\/\/[^\s<>"'\\]+$/i.test(v)) { say('The address must start with https://'); return; }
      if (items.indexOf(v) === -1 && items.length < MAX) items.push(v);
      addr.value = ''; render();
    });

    render();
    return {
      set: function (images) { items = Array.isArray(images) ? images.filter(function (s) { return typeof s === 'string' && s; }).slice(0, MAX) : []; say(''); render(); },
      get: function () { return items.slice(); }
    };
  }

  window.GalleryEditor = { mount: mount };
})();
