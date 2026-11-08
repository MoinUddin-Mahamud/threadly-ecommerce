// First-run setup page: only usable while no admin exists.
(function () {
  var form = document.getElementById('setupForm'), msg = document.getElementById('setupMsg');
  function say(text, ok) { msg.textContent = text; msg.className = 'alert ' + (ok ? 'alert-success' : 'alert-danger'); }
  fetch('/api/setup/status').then(function (r) { return r.json(); }).then(function (d) {
    if (!d.needed) return location.replace('/');
    if (d.tokenRequired) document.getElementById('suTokenWrap').classList.remove('d-none');
    if (d.tokenMissing) say('Set SETUP_TOKEN (16+ characters) in the server environment, restart, then reload this page.', false);
  }).catch(function () {});
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var p = document.getElementById('suPass').value;
    if (p !== document.getElementById('suPass2').value) return say('Passwords do not match.', false);
    fetch('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: document.getElementById('suUser').value, password: p, setupToken: (document.getElementById('suToken') || {}).value || '' }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.success) { say('Done. Redirecting to the admin login...', true); setTimeout(function () { location.href = '/admin.html'; }, 900); }
        else say(d.message || 'Setup failed.', false);
      }).catch(function () { say('Network error. Try again.', false); });
  });
})();
