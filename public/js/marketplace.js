// Storefront marketplace features: sellers grid, "sold by" on cards, shop pages
// (/?shop=name) and the seller application.
(function () {
  const shopSlug = (new URLSearchParams(window.location.search).get('shop') || '').toLowerCase().slice(0, 60);
  let marketplaceOn = false;
  let myVendor = null;

  $('#footerYear').text(new Date().getFullYear());

  // Shop pages: /?shop=<slug> shows one shop's products
  window.filterLoadedProducts = function (products) {
    if (!shopSlug) return products;
    return products.filter((p) => p.vendor && p.vendor.slug === shopSlug);
  };

  function showShopBanner() {
    if (!shopSlug) return;
    fetch('/api/shops/' + encodeURIComponent(shopSlug)).then((r) => (r.ok ? r.json() : null)).then((shop) => {
      const banner = $('<div class="mk-shop-banner"></div>');
      if (shop) {
        banner.append($('<div class="mk-avatar mb-0"></div>').text(shop.name.charAt(0).toUpperCase()));
        banner.append($('<div class="flex-grow-1"></div>')
          .append($('<h3 class="h5 mb-1" translate="no"></h3>').text(shop.name))
          .append((shop.description
            ? $('<div class="text-muted small"></div>').text(shop.description)
            : $('<div class="text-muted small"></div>').attr('data-brand-text', 'Independent seller on {name}').text('Independent seller on ' + (window.SITE_NAME || 'this store')))));
      } else {
        banner.append($('<div class="flex-grow-1"></div>').text('We could not find that shop.'));
      }
      banner.append('<a href="/#products" class="btn btn-outline-ink btn-sm">Show all products</a>');
      $('#products').prepend(banner);
    }).catch(() => {});
  }

  // "Sold by" on product cards (runs for every card the store draws)
  const drawHeart = window.addWishlistHeart;
  window.addWishlistHeart = function (col, product) {
    if (typeof drawHeart === 'function') drawHeart(col, product);
    if (!marketplaceOn || !product.vendor) return;
    const link = $('<a class="mk-seller"><i class="bi bi-shop"></i></a>')
      .attr('href', '/?shop=' + encodeURIComponent(product.vendor.slug) + '#products')
      .append($('<span translate="no"></span>').text(product.vendor.name));
    col.find('.card-title').first().after(link);
  };

  function drawShops(shops) {
    const grid = $('#shopGrid').empty();
    if (!shops.length) { $('#shops').addClass('d-none'); return; }
    shops.forEach((s) => {
      const count = Number(s.productCount) || 0;
      const card = $('<div class="col-sm-6 col-lg-3"><a class="mk-shop"></a></div>');
      card.find('a').attr('href', '/?shop=' + encodeURIComponent(s.slug) + '#products')
        .append($('<div class="mk-avatar"></div>').text(s.name.charAt(0).toUpperCase()))
        .append($('<h3 translate="no"></h3>').text(s.name))
        .append($('<p></p>').text(s.description || 'Independent seller'))
        .append($('<span class="mk-shop-meta"></span>').text(count + (count === 1 ? ' product' : ' products')));
      grid.append(card);
    });
  }

  function openApply() {
    if (typeof currentUser === 'undefined' || !currentUser) {
      showNotification('Please log in or create an account first, then apply to sell.', 'info');
      bootstrap.Modal.getOrCreateInstance('#authModal').show();
      return;
    }
    fetch('/api/vendor/me').then((r) => (r.ok ? r.json() : null)).then((me) => {
      if (me && me.vendor) { window.location.href = '/vendor.html'; return; }
      $('#applyShopMsg').text('');
      $('#applyShopForm').removeClass('d-none');
      $('#applyShopDone').addClass('d-none');
      bootstrap.Modal.getOrCreateInstance('#applyShopModal').show();
    }).catch(() => showNotification('Something went wrong. Please try again.', 'error'));
  }

  function sendApplication() {
    const btn = $('#applyShopBtn').prop('disabled', true);
    const msg = $('#applyShopMsg').removeClass('text-danger').text('');
    fetch('/api/vendor/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopName: $('#shopName').val(), description: $('#shopDescription').val(), phone: $('#shopPhone').val() })
    }).then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.message || 'Could not send your application.');
      myVendor = data.vendor;
      $('#applyShopForm').addClass('d-none');
      $('#applyShopDone').removeClass('d-none');
      refreshSellerMenu();
    }).catch((err) => msg.addClass('text-danger').text(err.message))
      .finally(() => btn.prop('disabled', false));
  }

  // The account menu says "Seller dashboard" for sellers, "Sell on ..." for everyone else.
  function refreshSellerMenu() {
    if (!marketplaceOn || typeof currentUser === 'undefined' || !currentUser) return;
    fetch('/api/vendor/me').then((r) => (r.ok ? r.json() : null)).then((me) => {
      myVendor = me && me.vendor;
      if (myVendor) $('#navSellerText').removeAttr('data-brand-text').text('Seller dashboard');
      else $('#navSellerText').attr('data-brand-text', 'Sell on {name}').text('Sell on ' + (window.SITE_NAME || 'this store'));
      $('#navSellerLink').attr('href', myVendor ? '/vendor.html' : '#');
    }).catch(() => {});
  }

  const afterLogin = window.onShopLogin;
  window.onShopLogin = function () { if (typeof afterLogin === 'function') afterLogin(); refreshSellerMenu(); };

  $(function () {
    fetch('/api/shops').then((r) => (r.ok ? r.json() : null)).then((shops) => {
      if (!shops) return;                       // marketplace is off: the page stays a plain shop
      marketplaceOn = true;
      $('.js-marketplace').removeClass('d-none');
      drawShops(shops);
      showShopBanner();
      refreshSellerMenu();
      // cards drawn before this answer arrived get their "sold by" line now
      if (typeof applyFilters === 'function' && typeof allProducts !== 'undefined' && allProducts.length) {
        applyFilters();
        if (typeof renderFeaturedProducts === 'function') renderFeaturedProducts(allProducts);
      }
    }).catch(() => {});

    $('#sellCta').on('click', openApply);
    $('#navSellerLink').on('click', function (e) { if ($(this).attr('href') === '#') { e.preventDefault(); openApply(); } });
    $('#applyShopBtn').on('click', sendApplication);
  });
})();
