// Policy pages: fills in the store's own contact details (from .env through /api/site-info).
(function () {
  var year = document.getElementById('footerYear');
  if (year) year.textContent = String(new Date().getFullYear());
  var list = document.getElementById('legalContactList');
  if (!list) return;
  fetch('/api/site-info').then(function (r) { return r.json(); }).then(function (info) {
    var rows = [];
    if (info.supportEmail) rows.push(['bi-envelope', 'Email', info.supportEmail, 'mailto:' + info.supportEmail]);
    if (info.supportPhone) rows.push(['bi-telephone', 'Phone', info.supportPhone, null]);
    if (info.supportAddress) rows.push(['bi-geo-alt', 'Address', info.supportAddress, null]);
    var box = document.getElementById('legalContact');
    var none = document.getElementById('legalNoContact');
    if (!rows.length) { if (none) none.classList.remove('d-none'); return; }
    rows.forEach(function (row) {
      var li = document.createElement('li');
      var icon = document.createElement('i'); icon.className = 'bi ' + row[0] + ' me-2';
      li.appendChild(icon);
      li.appendChild(document.createTextNode(row[1] + ': '));
      if (row[3]) { var a = document.createElement('a'); a.href = row[3]; a.textContent = row[2]; li.appendChild(a); }
      else li.appendChild(document.createTextNode(row[2]));
      list.appendChild(li);
    });
    if (box) box.classList.remove('d-none');
  }).catch(function () { if (document.getElementById('legalNoContact')) document.getElementById('legalNoContact').classList.remove('d-none'); });
})();
