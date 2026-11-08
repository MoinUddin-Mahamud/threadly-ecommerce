// Optional dark mode for the storefront. Light stays the default, so nothing changes unless a
// visitor clicks the toggle.
(function () {
  var KEY = 'threadly-theme';
  function read() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function write(value) {
    try { localStorage.setItem(KEY, value); } catch (e) { /* storage unavailable */ }
  }
  function apply(theme) {
    if (theme === 'dark') document.documentElement.setAttribute('data-bs-theme', 'dark');
    else document.documentElement.removeAttribute('data-bs-theme');
  }
  function current() {
    return document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'dark' : 'light';
  }

  apply(read()); // apply before first paint to avoid a flash

  document.addEventListener('DOMContentLoaded', function () {
    var nav = document.querySelector('#navContent .navbar-nav');
    if (!nav) return;

    var li = document.createElement('li');
    li.className = 'nav-item';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'themeToggle';
    btn.className = 'nav-link theme-toggle';

    function paint() {
      var dark = current() === 'dark';
      btn.innerHTML = dark ? '<i class="bi bi-sun me-1"></i>Light' : '<i class="bi bi-moon-stars me-1"></i>Dark';
      btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    }
    btn.addEventListener('click', function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      apply(next);
      write(next);
      paint();
    });

    paint();
    li.appendChild(btn);
    nav.appendChild(li);
  });
})();
