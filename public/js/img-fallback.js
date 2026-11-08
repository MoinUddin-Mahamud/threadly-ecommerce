// A picture that fails to load is replaced by the logo. One listener for the whole page,
// because the Content-Security-Policy does not allow inline onerror attributes.
(function () {
  function useFallback(img) {
    if (img && img.tagName === 'IMG' && img.dataset && img.dataset.fallbackSrc && !img.dataset.fallbackUsed) {
      img.dataset.fallbackUsed = '1';
      img.src = img.dataset.fallbackSrc;
    }
  }
  document.addEventListener('error', function (ev) { useFallback(ev.target); }, true);
  // An image that already failed before this script ran.
  document.querySelectorAll('img[data-fallback-src]').forEach(function (img) {
    if (img.complete && img.naturalWidth === 0) useFallback(img);
  });
})();
