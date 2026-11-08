// Small i18n layer (no dependencies). English text already in the pages is the source:
// /locales/en.json maps each key to that English text, and the other locale files map the same
// keys to translations. Text that has no key stays English, so a missing key never breaks a page.
(function () {
  'use strict';
  var LANGS = { en: 'English', bn: 'বাংলা', ar: 'العربية', es: 'Español', fr: 'Français', hi: 'हिन्दी' };
  var RTL = { ar: true };
  // Bootstrap 5.3.3 from jsDelivr. The integrity values are the sha384 of the files published in
  // the bootstrap@5.3.3 npm package.
  var BS_BASE = 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/';
  var BS_CSS = {
    ltr: { href: BS_BASE + 'bootstrap.min.css', integrity: 'sha384-QWTKZyjpPEjISv5WaRU9OFeRpok6YctnYmDr5pNlyT2bRjXh0JMhjY6hW+ALEwIH' },
    rtl: { href: BS_BASE + 'bootstrap.rtl.min.css', integrity: 'sha384-dpuaG1suU0eT09tx5plTaGMLBsfDLzUCCUXOY2j/LSvXYuG6Bqs43ALlhIqAJVRb' }
  };
  var en = {}, cur = {}, reverse = {}, patterns = [], lang = 'en', applying = false, seen = [], titleOrig = null, titleDone = null;

  function save(l) { try { localStorage.setItem('lang', l); } catch (e) { /* ignore */ } document.cookie = 'lang=' + l + ';path=/;max-age=31536000;SameSite=Lax'; }
  function detect() {
    var s; try { s = localStorage.getItem('lang'); } catch (e) { /* ignore */ }
    if (!s) { var m = document.cookie.match(/(?:^|; )lang=([a-z]{2})/); s = m && m[1]; }
    var n = s || (navigator.language || 'en').slice(0, 2);
    return LANGS[n] ? n : 'en';
  }
  // Points the page at the left-to-right or right-to-left Bootstrap build. The new link goes in
  // first and the old one leaves once it has loaded, so the page is never unstyled.
  function swapBootstrap(doc, rtl) {
    var want = BS_CSS[rtl ? 'rtl' : 'ltr'];
    var link = doc.querySelector('link[href*="bootstrap@5.3.3/dist/css/bootstrap"]');
    if (!link || link.getAttribute('href') === want.href) return;
    var next = doc.createElement('link');
    next.setAttribute('rel', 'stylesheet');
    next.setAttribute('href', want.href);
    next.setAttribute('integrity', want.integrity);
    next.setAttribute('crossorigin', 'anonymous');
    next.addEventListener('load', function () { if (link.parentNode) link.parentNode.removeChild(link); });
    link.parentNode.insertBefore(next, link);
  }

  // t(key, fallback, vars): the text for a key in the current language. {name} in the text is
  // replaced by vars.name, so a translator can move the value to wherever the language needs it.
  function t(key, fallback, vars) {
    var s = cur[key] || en[key] || fallback || key;
    return vars ? s.replace(/\{([a-zA-Z]+)\}/g, function (m, n) { return vars[n] === undefined ? m : String(vars[n]); }) : s;
  }
  // English text that contains {name} is a pattern: "Only {n} left" also matches "Only 3 left".
  function buildReverse() {
    reverse = {}; patterns = [];
    Object.keys(en).forEach(function (k) {
      var v = en[k];
      if (!/\{[a-zA-Z]+\}/.test(v)) { reverse[v] = k; return; }
      var names = [], src = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{([a-zA-Z]+)\\\}/g, function (m, n) { names.push(n); return '(.+?)'; });
      patterns.push({ key: k, names: names, re: new RegExp('^' + src + '$'), size: v.replace(/\{[a-zA-Z]+\}/g, '').length });
    });
    patterns.sort(function (a, b) { return b.size - a.size; });
  }
  // A value inside a pattern may itself be a known message ("Coupon removed: {reason}"): it is
  // translated too, one level deep.
  function find(text, inner) {
    if (reverse[text]) return { key: reverse[text] };
    for (var i = 0; i < patterns.length; i++) {
      var m = text.match(patterns[i].re);
      if (m) {
        var vars = {};
        patterns[i].names.forEach(function (n, j) {
          var v = m[j + 1], h = inner ? null : find(v, true);
          vars[n] = h ? t(h.key, null, h.vars) : v;
        });
        return { key: patterns[i].key, vars: vars };
      }
    }
    return null;
  }
  // Translates a whole English message (a server error, a notice) and leaves unknown text alone.
  function tr(text) {
    if (lang === 'en' || text == null) return text;
    var h = find(String(text).trim());
    return h ? t(h.key, null, h.vars) : text;
  }

  // Names and titles typed by shops and customers are marked translate="no" and are left alone.
  function userText(el) { return !!(el && el.closest && el.closest('[translate="no"]')); }

  function swap(node) {               // translate one text node, remembering its English
    var raw = node.nodeValue, trimmed = raw.trim();
    if (!trimmed || userText(node.parentNode)) return;
    var hit = find(trimmed);
    if (!hit) { var o = node.__uiOrig, h2 = o && find(o.trim()); if (h2 && trimmed !== t(h2.key, null, h2.vars)) node.__uiOrig = null; return; }
    node.__uiOrig = raw; seen.push(node);
    var text = t(hit.key, null, hit.vars);
    var next = raw.replace(trimmed, function () { return text; });
    if (next !== raw) node.nodeValue = next;   // a write of the same text would queue another mutation and loop forever
  }
  function walk(root) {
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentNode;
        if (!p || /^(SCRIPT|STYLE|TEXTAREA)$/.test(p.nodeName)) return 3;
        return userText(p) ? 3 : 1;
      }
    }), n; while ((n = w.nextNode())) swap(n);
  }
  var ATTRS = ['placeholder', 'aria-label', 'title'], attrEls = [];
  function swapAttrs(root) {
    var els = root.querySelectorAll ? [].slice.call(root.querySelectorAll('[placeholder],[aria-label],[title]')) : [];
    if (root.matches && root.matches('[placeholder],[aria-label],[title]')) els.push(root);
    els.forEach(function (el) {
      ATTRS.forEach(function (a) {
        var v = el.getAttribute(a), hit = v && !userText(el) && find(v.trim());
        if (!hit) return;
        el.__uiAttr = el.__uiAttr || {}; if (!(a in el.__uiAttr)) el.__uiAttr[a] = v;
        el.setAttribute(a, t(hit.key, null, hit.vars)); attrEls.push(el);
      });
    });
  }
  function apply(root) {
    if (lang === 'en') return;
    applying = true; try { walk(root || document.body); swapAttrs(root || document.body); } finally { applying = false; }
  }
  function restore() {
    applying = true;
    seen.forEach(function (n) { if (n.isConnected && n.__uiOrig != null) n.nodeValue = n.__uiOrig; n.__uiOrig = null; });
    attrEls.forEach(function (el) { var o = el.__uiAttr || {}; Object.keys(o).forEach(function (a) { el.setAttribute(a, o[a]); }); el.__uiAttr = null; });
    attrEls = []; seen = []; applying = false;
  }

  function swapTitle() {
    if (typeof document.title !== 'string') return;
    if (titleOrig == null || document.title !== titleDone) titleOrig = document.title;
    var h = lang === 'en' ? null : find(titleOrig.trim());
    titleDone = h ? t(h.key, null, h.vars) : titleOrig;
    if (document.title !== titleDone) document.title = titleDone;
  }

  function setLang(l) {
    if (!LANGS[l]) l = 'en';
    return fetch('/locales/' + l + '.json').then(function (r) { return r.json(); }).catch(function () { return {}; }).then(function (d) {
      restore(); lang = l; cur = d; save(l);
      buildReverse();
      document.documentElement.lang = l; document.documentElement.dir = RTL[l] ? 'rtl' : 'ltr';
      swapBootstrap(document, !!RTL[l]);
      apply(document.body); swapTitle();
      try { window.dispatchEvent(new CustomEvent('ui:lang', { detail: { lang: l } })); } catch (e) { /* ignore */ }
      var sel = document.getElementById('uiLang'); if (sel) sel.value = l;
    });
  }
  function num(n) { try { return new Intl.NumberFormat(lang).format(n); } catch (e) { return String(n); } }
  function date(d) { try { return new Intl.DateTimeFormat(lang, { dateStyle: 'medium' }).format(new Date(d)); } catch (e) { return String(d); } }

  function switcher() {
    var nav = document.querySelector('.navbar-nav'); if (!nav || document.getElementById('uiLang')) return;
    var li = document.createElement('li'); li.className = 'nav-item ms-lg-2';
    var sel = document.createElement('select'); sel.id = 'uiLang'; sel.className = 'form-select form-select-sm'; sel.setAttribute('aria-label', t('lang.label', 'Language'));
    Object.keys(LANGS).forEach(function (k) { var o = document.createElement('option'); o.value = k; o.textContent = LANGS[k]; sel.appendChild(o); });
    sel.addEventListener('change', function () { setLang(sel.value); });
    li.appendChild(sel); nav.appendChild(li);
  }

  window.UI18n = { translateNode: swap, swapBootstrap: swapBootstrap, bootstrapCss: BS_CSS, t: t, tr: tr, setLang: setLang, getLang: function () { return lang; }, formatNumber: num, formatDate: date, langs: LANGS };
  swapBootstrap(document, !!RTL[detect()]);   // before the strings arrive, so Arabic pages do not wait for them
  fetch('/locales/en.json').then(function (r) { return r.json(); }).then(function (d) {
    en = d; switcher();
    new MutationObserver(function (ms) {            // translate content the app draws later
      if (applying || lang === 'en') return;
      applying = true;
      try { ms.forEach(function (m) {
        if (m.type === 'characterData') swap(m.target);
        else m.addedNodes.forEach(function (n) { if (n.nodeType === 3) swap(n); else if (n.nodeType === 1 && n.id !== 'uiLang') { walk(n); swapAttrs(n); } });
      }); } finally { applying = false; }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    return setLang(detect());
  }).catch(function () {});
})();
