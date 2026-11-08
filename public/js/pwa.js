// Registers the service worker (public/sw.js) so the store can be installed and opens its offline
// page when the connection is down.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () { /* the store works without it */ });
  });
}
