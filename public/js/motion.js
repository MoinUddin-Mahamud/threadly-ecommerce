// Motion helpers for the storefront. They do not read or change app data, and every effect
// is skipped for visitors who prefer reduced motion.
(function () {
  'use strict';
  var UIMotionCore = window.UIMotionCore;
  var calm = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  var nav = document.querySelector('.navbar');
  function onScroll() { if (nav) nav.classList.toggle('ui-scrolled', window.scrollY > 24); }
  window.addEventListener('scroll', onScroll, { passive: true }); onScroll();
  if (calm) return;

  // Staggered reveal for cards and sections, including ones app.js renders later
  var SEL = '.card, .mk-tile, .mk-step, .mk-section > .container > *, .section-header';
  var io = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('ui-in'); io.unobserve(e.target); } });
  }, { threshold: 0.12 }) : null;
  function prep(root) {
    if (!io || !root.querySelectorAll) return;
    var nodes = root.matches && root.matches(SEL) ? [root] : [];
    nodes = nodes.concat([].slice.call(root.querySelectorAll(SEL)));
    nodes.forEach(function (el, i) {
      if (el.dataset.uiSeen || el.closest('.modal, .chat-widget-panel')) return;
      el.dataset.uiSeen = '1';
      el.style.setProperty('--ui-d', Math.min(i, 8) * 70 + 'ms');
      el.classList.add('ui-reveal'); io.observe(el);
    });
  }
  prep(document.body);
  new MutationObserver(function (muts) {
    muts.forEach(function (m) { m.addedNodes.forEach(function (n) { if (n.nodeType === 1) prep(n); }); });
  }).observe(document.body, { childList: true, subtree: true });

  document.addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('.btn');
    if (!b) return;
    var r = b.getBoundingClientRect(), s = Math.max(r.width, r.height), d = document.createElement('span');
    d.className = 'ui-ripple';
    d.style.cssText = 'width:' + s + 'px;height:' + s + 'px;left:' + (ev.clientX - r.left - s / 2) + 'px;top:' + (ev.clientY - r.top - s / 2) + 'px';
    b.appendChild(d); setTimeout(function () { d.remove(); }, 600);
  });

  // Bump the cart counter when its number changes
  var cnt = document.querySelector('.nav-count');
  if (cnt) new MutationObserver(function () {
    cnt.classList.remove('ui-bump'); void cnt.offsetWidth; cnt.classList.add('ui-bump');
  }).observe(cnt, { childList: true, characterData: true, subtree: true });

  // Flash a stock badge when its text changes (matched by product id, see motion-core.js).
  var checkBadge = UIMotionCore.stockWatcher();
  new MutationObserver(function (muts) {
    muts.forEach(function (m) {
      var found = [];
      if (m.type === 'characterData') { var p = m.target.parentElement && m.target.parentElement.closest('.stock-badge'); if (p) found.push(p); }
      else {
        var own = m.target.closest && m.target.closest('.stock-badge'); if (own) found.push(own);
        m.addedNodes.forEach(function (n) {
          if (n.nodeType !== 1) return;
          if (n.matches('.stock-badge')) found.push(n); else [].push.apply(found, n.querySelectorAll('.stock-badge'));
        });
      }
      found.forEach(checkBadge);
    });
  }).observe(document.body, { childList: true, characterData: true, subtree: true });

  // Grey placeholder cards while the product grid is empty.
  UIMotionCore.skeletonGrid(document.getElementById('productGrid'));
})();
