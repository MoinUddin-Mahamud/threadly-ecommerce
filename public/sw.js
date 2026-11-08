// Service worker: makes the store installable and keeps it usable on a bad connection.
// One cache with a fixed name. Scripts and style sheets are fetched network first and the offline page is
// fetched again on every install, so a new copy of the shop never keeps serving old files.
const CACHE = 'store-static';
const OFFLINE_URL = '/offline.html';
const NEVER = /^\/(api|admin|socket\.io|uploads|product|payment|vendor|manifest)/;

// Decides what to do with a request: 'images' (cache first), 'assets' (network first, cached copy
// when offline), 'page' (network first, offline page when the network is down) or null (leave it
// alone).
function routeFor(method, url, mode) {
  if (method !== 'GET') return null;
  let u;
  try { u = new URL(url); } catch (e) { return null; }
  if (typeof self !== 'undefined' && self.location && u.origin !== self.location.origin) return null;
  if (u.search && /[?&](token|code|key)=/i.test(u.search)) return null;
  if (NEVER.test(u.pathname)) return null;
  if (mode === 'navigate') return /\.html$|\/$/.test(u.pathname) && !/^\/(admin|vendor|payment)/.test(u.pathname) ? 'page' : null;
  if (u.pathname.startsWith('/img/')) return 'images';
  if (u.pathname.startsWith('/css/') || u.pathname.startsWith('/js/')) return 'assets';
  return null;
}

// Only complete, successful, same-site answers are ever kept.
function cacheable(response) {
  if (!response || response.status !== 200 || response.type !== 'basic') return false;
  const cc = String(response.headers.get('Cache-Control') || '');
  return !/no-store|private/i.test(cc);
}

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE).then((cache) => cache.add(OFFLINE_URL)).then(() => self.skipWaiting()));
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil(
      caches.keys()
        .then((names) => Promise.all(names.filter((n) => n.startsWith('store-static') && n !== CACHE).map((n) => caches.delete(n))))
        .then(() => self.clients.claim())
    );
  });

  self.addEventListener('fetch', (event) => {
    const request = event.request;
    const kind = routeFor(request.method, request.url, request.mode);
    if (!kind) return;   // not ours: the browser handles it as usual

    if (kind === 'page') {
      event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
      return;
    }
    if (kind === 'images') {
      event.respondWith(caches.open(CACHE).then((cache) => cache.match(request).then((hit) => hit || fetch(request).then((res) => {
        if (cacheable(res)) cache.put(request, res.clone());
        return res;
      }))));
      return;
    }
    // Scripts and style sheets: network first, so an update shows at once. The cached copy is used
    // only when offline.
    event.respondWith(caches.open(CACHE).then((cache) => fetch(request).then((res) => {
      if (cacheable(res)) cache.put(request, res.clone());
      return res;
    }).catch(() => cache.match(request).then((hit) => hit || Response.error()))));
  });
}

if (typeof module !== 'undefined') module.exports = { routeFor, cacheable, NEVER };
