# Testing guide

## Run the automated tests

You need Node.js 24 LTS (Node.js 22.12 or newer also works).

```bash
npm ci
npm test
```

`npm test` runs every file in `tests/` with Node's built-in test runner (about a minute). No MongoDB, payment gateway, e-mail server or AI provider is needed: the database models, gateways and the chatbot's network calls are replaced by in-memory fakes. The tests therefore prove the shop's own logic, not your accounts with those services; see *Test these yourself* below.

Run one file: `node --test tests/llm.test.js`. Check the dependencies for known problems with `npm audit`, which should report 0 vulnerabilities.

## What each test file covers

| File | Covers |
|------|--------|
| `admin.test.js`, `permissions.test.js`, `roles.test.js` | Admin login, CSRF tokens, owner / staff / audit roles and what each may do |
| `api.test.js`, `orders.test.js`, `limits.test.js` | Products and orders API, size limits, the order rate limit, escaping in e-mails |
| `order-safety.test.js`, `order-flow.test.js`, `review-payments.test.js`, `product-rules.test.js` | Stock on cancel and reopen, late payments, gateway failures, transaction ids, product and price rules, seller order handling |
| `cod.test.js` | Cash on Delivery rules, stock, admin handling |
| `coupons.test.js`, `coupon-client.test.js` | Coupon rules and atomic use counting; the exact payload the storefront sends to check a coupon |
| `currencies.test.js`, `currency-decimals.test.js` | Money in currencies with 0, 2 and 3 decimals: rounding, totals, coupons, commission, payouts, refunds, card amounts and the smallest card charge |
| `customers.test.js` | Customer accounts, e-mail verification, My Orders |
| `intl-gateways.test.js`, `intl-routes.test.js`, `paypal-whole-units.test.js` | PayPal, Flutterwave and Mollie, with fake gateway replies; PayPal whole-unit currencies |
| `marketplace.test.js` | Multi-vendor rules: visibility, applying, seller products, commissions, payouts, clawbacks |
| `money-rules.test.js` | The optional money rules, tested with each flag off and on |
| `llm.test.js`, `chat-retry-safety.test.js` | The chatbot for every provider (fake fetch): requests, retries, backoff, fallback models, errors, no keys in URLs or logs |
| `same-origin.test.js`, `checkout-origin.test.js` | Cross-site write protection, directly and through the app, including the exempt payment callbacks |
| `escaping.test.js`, `plain-text.test.js` | Scan of the browser scripts (dynamic text is escaped or set as text); title and shop-name cleaning, the CSV formula guard, gateway order descriptions |
| `late-payments.test.js`, `checkout-contact.test.js` | Late payments and refunds, the online-payment phone and address rules, and a whole-tree scan for currency text |
| `frontend-backend.test.js` | The pages and the server agree: every address a script calls exists with the same method, every element id a script looks up exists, every linked file exists, and the fields the browser reads from the order and payment-status replies are present |
| `payment-reference.test.js` | Duplicate payment references, checkout replay, brand name, payment pages, phone rule, docs and package consistency |
| `session-secret.test.js`, `startup.test.js`, `hardening.test.js`, `two-factor-key.test.js` | Start-up checks, the session secret, e-mail settings, the two-factor key, dependency overrides |
| `login-limits-and-mail-caps.test.js` | Login lockout, e-mail caps, chat limits and cookie, COD limits, picture fallback, noindex pages |
| `env-docs.test.js` | Every environment variable used in the code is documented in `.env.example` and the README |
| `setup-owner.test.js`, `setup-i18n-demo.test.js`, `demo-mode.test.js`, `security-rules.test.js` | First-run setup, the `.env` admin states, the owner claim, the `/setup` token rule, demo mode and the demo reset script |
| `rtl-stylesheet.test.js`, `motion-core.test.js`, `locale-keys.test.js`, `i18n-behaviour.test.js` | Right-to-left stylesheet swap, stock flash and placeholders, locale files, the language switch run against a fake DOM |
| `palette.test.js` | One colour palette for light and dark mode, the payment page icons, and the product page's use of the shared styles |
| `own-shop.test.js` | The store's own products next to the marketplace, and a seller shop owned by a customer account |
| `pictures.test.js`, `images.test.js` | Picture files and uploads, the 300-file limit, address rules, link-preview images |
| `pwa.test.js` | Web app manifest and service worker |
| `reviews.test.js` | Product reviews and ratings |
| `size-stock.test.js`, `size-stock-routes.test.js` | Stock per size: the rules, the admin and seller edit routes, the 409 on a plain stock edit |
| `models.test.js`, `seo.test.js`, `seo-routes.test.js`, `extras.test.js` | Model rules, bundled images, SEO pages, wishlist and shipping |
| `docs.test.js`, `pack.test.js` | The one-page guide (self-contained, links resolve, same sections as the README) and `threadly.zip` (what it leaves out, a valid single-folder zip) |

`fakeDb.js` and `helpers.js` are shared test helpers, not tests.

## Test these yourself

The automated tests cannot reach the outside world. Before going live, check each of these once:

1. **MongoDB:** start the app against your real database, register, place an order, and restart the app to confirm sessions and data persist. Place a few orders at once for the last unit of a product and confirm only as many succeed as there is stock.
2. **Each payment gateway you enable:** one full payment and one cancelled payment in the gateway's sandbox; confirm the order status and the stock afterwards.
3. **The chatbot:** run `node scripts/chat-check.js "Do you ship?"` with your key and model, then ask a question in the shop. Switch `CHAT_PROVIDER` to confirm the provider you chose.
4. **E-mail:** send a test order e-mail and a password reset through your real mail server.
5. **Behind your proxy:** log in as a customer and as a seller and save something from the real address. If a save answers "Cross-site request refused", set `BASE_URL` or `ALLOWED_ORIGIN` to the public address. Set `TRUST_PROXY` to the number of proxies in front of the shop, and raise `API_RATE_LIMIT_MAX` if many customers share one address.
6. **Optional money rules,** only if you turn them on: place, ship and cancel a test order with two sellers and check the earnings in the seller dashboard and the payout plan.
7. **Currency check (not verified against the gateways):** if your shop sells in a currency without decimals (JPY, KRW, VND ...) or with three (KWD, BHD ...), place one card test order in the gateway's sandbox and confirm that the gateway page shows exactly the order total. With PayPal in HUF or TWD, the PayPal page must show a whole amount (no decimals), while Stripe, Mollie and Flutterwave show two decimals. These currency rules are **unverified against the gateways**: the automated tests cannot confirm them, so check the HUF/TWD handling, the three-decimal currencies (KWD, BHD and similar) and the no-decimal currencies in each gateway's sandbox. For Stripe, also check the smallest charge for your currency against `services/stripeMinCharge.json`.
8. **Payout hold:** earnings become payable 7 days after a seller marks their part delivered (`PAYOUT_HOLD_DAYS`). Set it to the number of days you want before you go live.
9. **Password reset:** request a reset, open the emailed link (the token is after a `#`), set a new password, and confirm that a second browser that was logged in is logged out.
10. **Size stock:** on a real MongoDB, create a product with sizes S, M and L, place an order for size M, cancel it, then edit the product while an order is being placed, and confirm the product's `stock` always equals the sum of its sizes. The automated tests use a fake for the database and cannot check this.
11. **Login, e-mail and order limits:** with a real mail server, ask for a password reset four times in an hour for one address and confirm the fourth does not send a new link (the third link still works). Type a wrong password 10 times for one test account and confirm the 11th try answers 429 even with the right password. Place six Cash on Delivery orders from one address in an hour and confirm the sixth is refused. Open a product page whose picture address is broken and confirm the logo shows instead. Start the app with MongoDB switched off and confirm one clear line is printed, not a stack trace.
12. **Cross-site check:** on your live HTTPS address, place one normal order from the storefront and confirm it works. Then run `curl -i -X POST https://YOUR-SHOP/api/orders -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -d '{}'` and confirm the answer is 403 "Cross-site request refused." If real checkouts are refused with 403 behind your proxy, set `BASE_URL` (and `ALLOWED_ORIGIN`) to your public address.

## Setup page, languages and demo mode

The tests in `setup-owner.test.js`, `setup-i18n-demo.test.js`, `demo-mode.test.js`, `rtl-stylesheet.test.js`, `motion-core.test.js`, `locale-keys.test.js`, `i18n-behaviour.test.js` and `security-rules.test.js` cover:

- the setup token rule, the three states of the `.env` admin (missing or template, valid, malformed) and the one-owner claim with two router instances sharing one fake database;
- the blocked demo routes and the demo reset script's refusals and purge list;
- the Bootstrap right-to-left stylesheet swap and its integrity hashes, checked against the `bootstrap@5.3.3` dev dependency;
- the stock flash and the grid placeholders, with a small DOM stub;
- the locale files.

None of this runs in a browser, so check the points below yourself.

- Open `/setup` on a fresh database with a public `BASE_URL`. It must ask for the token and refuse a wrong one. Create the owner, log in at `/admin.html`, then confirm `/setup` redirects home.
- Keep the `.env.example` lines `ADMIN_USERNAME=admin` and the placeholder hash, create an owner at `/setup`, then try to sign in as `admin` with the password `no-env-admin`. It must be refused.
- Run the app on a server with the default `.env` (not production) and open `/setup` from another computer. It must ask for `SETUP_TOKEN`.
- Set `ADMIN_PASSWORD_HASH` to a value with quotes around it. The server must print one warning and `/setup` must stay closed.
- Start two server processes against one empty database and post to `/setup` from both at once. One must answer 201 and the other 409.
- Switch each language on the home, shop and payment pages. Arabic must mirror the layout, arrows and spacing, and the page must load `bootstrap.rtl.min.css` without an integrity error in the console.
- With `DEMO_MODE=true`, try deleting a product, adding a staff account, changing a password, editing a vendor, recording a payout and marking an order refunded. All must be refused.
- Run `npm run demo:reset -- --yes` on a throwaway database whose name contains `demo`. Orders, coupons, reviews, payouts and customer accounts must be gone and the products reseeded. Run it against a database without `demo` in its name and confirm it refuses.
- Stop the database and open the shop. The grey placeholders must turn into a message after 10 seconds.
- Change a product's stock in the admin panel while the shop is open in another browser. Only that product's badge should flash.
