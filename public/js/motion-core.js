// Logic behind the stock badge flash and the product grid placeholders. motion.js wires it to the
// page; it lives here so node:test can run it against a minimal fake DOM.
(function (root) {
  'use strict';

  var LOAD_FAILED = 'Could not load products. Please refresh the page.';

  function flash(badge) {
    badge.classList.remove('ui-flash'); void badge.offsetWidth; badge.classList.add('ui-flash');
  }

  // Remembers the last text of each badge by product id. app.js redraws the cards, so the element
  // changes while the product stays the same. The first value seen for a product never flashes.
  function stockWatcher(onChange) {
    var last = {};
    var fire = onChange || flash;
    return function check(badge) {
      var id = badge.getAttribute('data-product-id');
      if (!id) return false;
      var text = String(badge.textContent).trim();
      var changed = Object.prototype.hasOwnProperty.call(last, id) && last[id] !== text;
      last[id] = text;
      if (changed) fire(badge);
      return changed;
    };
  }

  // Grey cards while the grid is empty. Once real cards arrive they are removed; if nothing
  // arrives before the delay, they are replaced by a short message.
  function skeletonGrid(grid, env) {
    env = env || {};
    var doc = env.doc || document;
    var Observer = env.Observer || MutationObserver;
    var later = env.setTimeout || setTimeout;
    var cancel = env.clearTimeout || clearTimeout;
    var delay = env.delay || 10000;
    if (!grid || grid.children.length) return null;

    var temp = function (c) { return c.hasAttribute('data-ui-skel') || c.hasAttribute('data-ui-msg'); };
    var hasContent = function () { return [].some.call(grid.children, function (c) { return !temp(c); }); };
    var clean = function () { [].slice.call(grid.children).filter(temp).forEach(function (n) { n.remove(); }); };

    for (var i = 0; i < 6; i++) {
      var s = doc.createElement('div');
      s.className = 'col-md-4 col-sm-6 col-lg-4';
      s.setAttribute('data-ui-skel', '1'); s.setAttribute('aria-hidden', 'true');
      s.innerHTML = '<div class="ui-skeleton" style="height:230px"></div><div class="ui-skeleton mt-3" style="height:18px;width:70%"></div><div class="ui-skeleton mt-2" style="height:14px;width:45%"></div>';
      grid.appendChild(s);
    }
    var timer;
    var watch = new Observer(function () {
      if (hasContent()) { clean(); watch.disconnect(); cancel(timer); }
    });
    watch.observe(grid, { childList: true });
    timer = later(function () {
      if (hasContent()) return;
      clean();
      var msg = doc.createElement('div');
      msg.setAttribute('data-ui-msg', '1');
      msg.className = 'col-12 text-center text-muted py-5';
      msg.textContent = LOAD_FAILED;
      grid.appendChild(msg);
    }, delay);
    return { clean: clean };
  }

  var api = { flash: flash, stockWatcher: stockWatcher, skeletonGrid: skeletonGrid, LOAD_FAILED: LOAD_FAILED };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.UIMotionCore = api;
})(typeof window !== 'undefined' ? window : this);
