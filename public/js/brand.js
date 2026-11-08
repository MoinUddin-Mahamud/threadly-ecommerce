// Fills in the shop name from SITE_NAME (GET /api/site-info); until then the default below is
// shown. data-brand element text becomes the name data-brand-text="Sell on {name}". The footer
// year (#footerYear) is set to the current year; the year written in the HTML is the fallback.
(function () {
  'use strict';

  var FALLBACK = 'Threadly';
  var KEY = 'shop_name';
  var name = FALLBACK;
  try {
    var saved = window.sessionStorage.getItem(KEY);   // the answer from an earlier page, so the name does not flicker
    if (saved) name = saved;
  } catch (e) { /* storage can be blocked */ }
  window.SITE_NAME = name;

  // Decimals of the shop's prices (0, 2 or 3), from /api/site-info. Never a currency sign or name.
  var DEC_KEY = 'shop_decimals';
  var decimals = 2;
  try {
    var savedDec = window.sessionStorage.getItem(DEC_KEY);
    if (savedDec !== null && /^[0-3]$/.test(savedDec)) decimals = Number(savedDec);
  } catch (e) { /* storage can be blocked */ }
  function toNumber(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  window.TLMoney = {
    decimals: function () { return decimals; },
    // plain text, no thousands separators
    fixed: function (v) { return toNumber(v).toFixed(decimals); },
    // for display, with thousands separators
    format: function (v) {
      var n = toNumber(v);
      try { return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }); }
      catch (e) { return n.toFixed(decimals); }
    }
  };

  function fill(template) {
    return String(template).replace(/\{name\}/g, window.SITE_NAME);
  }

  // Only textContent and setAttribute are used, so a name can not add markup.
  function apply(root) {
    var scope = root || document;
    var each = function (selector, fn) { Array.prototype.forEach.call(scope.querySelectorAll(selector), fn); };
    each('[data-brand]', function (el) { el.textContent = window.SITE_NAME; });
    each('#footerYear', function (el) { el.textContent = String(new Date().getFullYear()); });
    each('[data-brand-text]', function (el) { el.textContent = fill(el.getAttribute('data-brand-text')); });
    each('[data-brand-alt]', function (el) { el.setAttribute('alt', fill(el.getAttribute('data-brand-alt'))); });
    each('meta[data-brand-content]', function (el) { el.setAttribute('content', fill(el.getAttribute('data-brand-content'))); });
    var title = document.querySelector('title[data-brand-title]');
    if (title) document.title = title.getAttribute('data-brand-title') + ' - ' + window.SITE_NAME;
  }
  window.applyBrand = apply;

  function onReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }
  onReady(function () { apply(); });

  if (typeof window.fetch !== 'function') return;
  window.fetch('/api/site-info', { headers: { Accept: 'application/json' } })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (info) {
      var fresh = info && typeof info.name === 'string' ? info.name.trim() : '';
      var decimalsChanged = false;
      if (info && Number.isInteger(info.currencyDecimals) && info.currencyDecimals >= 0 && info.currencyDecimals <= 3) {
        try { window.sessionStorage.setItem(DEC_KEY, String(info.currencyDecimals)); } catch (e) { /* storage can be blocked */ }
        // Prices drawn before the answer came used the old decimals; brand:ready tells the pages to draw them again.
        if (info.currencyDecimals !== decimals) {
          decimals = info.currencyDecimals;
          decimalsChanged = true;
        }
      }
      window.SITE_NAME = fresh || FALLBACK;
      try {
        if (fresh) window.sessionStorage.setItem(KEY, fresh); else window.sessionStorage.removeItem(KEY);
      } catch (e) { /* storage can be blocked */ }
      onReady(function () {
        apply();
        document.dispatchEvent(new CustomEvent('brand:ready', { detail: { name: window.SITE_NAME, decimalsChanged: decimalsChanged } }));
      });
    })
    .catch(function () { /* keep the name that is already shown */ });
}());
