# Threadly - Real-Time E-Commerce Platform with AI Chatbot

A real-time, self-hosted e-commerce platform and multi-vendor clothing marketplace with an AI chatbot, built with Node.js, Express and MongoDB.

This guide is also available as one page: `docs/index.html`.

It is a complete marketplace: independent sellers open shops, shoppers fill one cart from several
shops and pay once, and each seller ships their own items. It includes real-time
stock updates, seven payment options (SSLCommerz, Stripe, PayPal, Flutterwave, Mollie, Cash on Delivery and manual transfer), a seller dashboard with commissions and
payouts, a full admin panel and an AI support chatbot.

> "Threadly" is a placeholder brand name. Change the name, colours and logo in
> minutes (see *Customizing* below), and check that any name you choose is free
> to use before you launch.

It also runs as a normal single-seller clothing store: leave
`MULTIVENDOR_ENABLED` off and nothing marketplace-related is shown.

---

## Quick start (try it on your computer in 5 minutes)

You need **Node.js 24 LTS** (recommended; Node.js 22.12 or newer also works) and a MongoDB database (a free MongoDB Atlas
cluster is fine). No MongoDB? Use the Docker route below.

1. Copy the example settings: `cp .env.example .env`
2. Open `.env` and set:
   - `NODE_ENV=development` is already set in the example file, so the shop starts
     with the placeholder `SESSION_SECRET`. **Set `NODE_ENV=production` before you go live**
     (secure cookies, HSTS, strict CORS, and the server refuses to start without a real
     `SESSION_SECRET`; see *Environment Variables* and *Security Notes* below).
   - `MONGODB_URI=` your MongoDB address, for example `mongodb://localhost:27017`.
   - Leave `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH` empty. They are optional: you create the owner
     account in the browser in step 6. (To set the admin in `.env` instead, make the hash with
     `node scripts/hash-password.js "YourChosenPassword"` and paste the printed line exactly as
     printed, single quotes included.)
3. Install: `npm install`
4. Add the demo shops and 40 products (optional): `npm run seed` (demo prices are sample numbers: set your own `CURRENCY_CODE` and edit `seed/catalog.js`)
5. Start: `npm start`
6. Open **http://localhost:3000/setup** and create the owner account (a username and a password).
   Then open **http://localhost:3000** (the shop) and **http://localhost:3000/admin.html** (the admin
   panel) and log in with the account you just made. See *Languages, first-run setup and demo mode*.
7. To see the marketplace: set `MULTIVENDOR_ENABLED=true` in `.env`, run `npm run seed`
   (it adds the demo shops and skips anything already there), and restart.

**Your first admin** is the owner you create at `/setup` (or the one defined in `.env`, if you chose
that); the admin panel stays closed until one exists. To add more people: `npm run create-admin -- <username> <password> owner`
(`owner` = full access, `staff` = the default staff role, or the name of a role you
made under *Roles & Access*). It uses `MONGODB_URI` from `.env`.

**With Docker instead** (no Node or MongoDB needed on your machine):

```bash
cp .env.example .env
# make a SESSION_SECRET:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   (or: openssl rand -hex 32)
# edit .env: SESSION_SECRET=<the secret>, and, only for trying it on http://localhost, COOKIE_SECURE=false
# then open http://localhost:3000/setup to create the owner account (or, instead, make a hash with
#   docker compose run --rm --no-deps app node scripts/hash-password.js "YourChosenPassword"
# and set ADMIN_USERNAME and ADMIN_PASSWORD_HASH='<the hash>' in .env, keeping the quotes)
docker compose up --build
docker compose exec app npm run seed                                      # optional demo data
docker compose exec app node scripts/create-admin.js jane StrongPassword123 staff   # optional extra admin
```

Docker always runs the production setting, so a real `SESSION_SECRET` is needed
there. Then open http://localhost:3000. More detail follows in *Installation*
and *Run with Docker*.

---

## Features

- **Multi-vendor marketplace** - sellers apply, you approve; each seller has a
  shop page, a dashboard (products, orders, earnings) and a commission rate you
  control. See *Marketplace* below.
- **Storefront** - browse clothing by category (Men / Women / Kids / Accessories), view
  product detail, add to cart, and checkout. Responsive, with dark mode.
- **Stock per size and several pictures** - a seller can keep stock for each size
  (a sold-out size cannot be bought) and show up to 6 pictures per product. See
  *Sizes and product pictures* below.
- **Customer reviews** - customers rate and review a product after it was
  delivered; you can hide or delete reviews in the admin panel (*Reviews*).
  Stars appear on product cards, and the product page and search-engine data
  include the rating.
- **Installable store** - a web app manifest, app icons and a conservative service
  worker let customers add the store to their phone's home screen. Orders,
  accounts and payments are never kept offline.
- **Real-time updates** - product and order changes push instantly to every
  connected browser via Socket.IO (no page refresh needed).
- **Secure checkout** - five online gateways: **SSLCommerz** (cards and mobile
  banking; it covers Bangladeshi mobile banking such as bKash), **Stripe**, **PayPal**,
  **Flutterwave** and **Mollie** for international payments, plus **Cash on Delivery** and
  **manual bank or mobile-banking transfer**. You switch on the ones you want in `.env`; the
  customer chooses among the enabled methods at checkout, and a method that is not set up is
  never offered.
- **Customer accounts** - registration, login, session-based auth, and order
  history, with rate-limited auth endpoints to resist brute force.
- **Admin dashboard** - a separate, password-protected panel with its own
  navigation (Products, Orders, Statistics, each its own linkable view):
  add, edit and delete products; manage orders and update their status;
  view clickable statistics (total products, total orders, low-stock items,
  total revenue); and a printable, invoice-style order detail page.
  Protected by CSRF tokens and a login rate limiter.
- **AI support chatbot** - a built-in chat widget answers customer questions
  about products, sizing, shipping, and orders using the AI provider you choose (Gemini, OpenAI, Anthropic or any OpenAI-compatible service),
  grounded in your live product catalog so it doesn't invent answers.
- **SEO basics** - meta tags, Open Graph and Twitter cards on the storefront,
  `robots.txt`, `sitemap.xml`, and a read-only page for every product at
  `/product/<id>` with Product structured data, so shoppers and search engines
  can find and share individual products. Admin pages are never indexed.
- **Coupons** - discount codes (percent or fixed) with minimum order, maximum
  discount, dates and usage limit, managed in the admin panel and entered in the
  cart. The server works out the discount; the discounted total is what the
  payment gateway charges.
- **Cash on Delivery (optional)** - turn on `COD_ENABLED` and customers can
  place an order and pay the courier in cash. Stock is reserved, the order is
  placed (status **PLACED**) for staff to confirm, and the admin marks it as paid
  when the cash is received.
- **Manual payment (optional)** - turn on `MANUAL_PAYMENT_ENABLED` for bank or
  mobile-banking transfers. The customer sees your `MANUAL_PAYMENT_INSTRUCTIONS`,
  can send a payment reference from the success page (orders that share a
  reference are flagged for you, not refused). An order **without** a reference is cancelled automatically
  (stock and coupon returned) after `MANUAL_PAYMENT_HOURS`. An order **with** a
  reference is not cancelled: it gets the red-yellow **Payment unconfirmed**
  badge so you can check your bank or wallet, and stays reserved for another
  `MANUAL_PAYMENT_REVIEW_HOURS` (default 72). If you have not confirmed it by
  then it is cancelled and flagged **Refund due**, so money that did arrive is
  never lost from view and a made-up reference cannot hold stock forever.
  Confirming it records the payment.
- **Only working payment methods are offered** - checkout shows a method only
  when it is set up (`GET /api/payment-options`).
- **Wishlist** - a heart on every product; guests keep a list in their browser
  and it moves to their account when they log in.
- **CSV product import (admin)** - upload a spreadsheet exported as CSV, preview
  what will happen, then add or update up to 500 products at once.
- **Shipping rates (optional)** - a flat fee, an optional rate for your home
  city, and free shipping above an amount you choose (`SHIPPING_ENABLED`).
- **Two-factor admin login (optional)** - authenticator-app codes and backup
  codes for admin accounts (`ADMIN_2FA_ENABLED`).
- **No currency in the interface** - prices are plain numbers; you set one
  machine-readable code in `.env` (`CURRENCY_CODE`) for the payment gateways.
- **Order email notifications** - customers are emailed automatically when
  their order status changes.
- **Security hardening included** - bcrypt password hashing, CSRF protection
  on all admin mutations, rate limiting on auth and public endpoints,
  session fixation prevention, and input sanitization throughout.

---

## Tech Stack

| Layer         | Technology                                   |
|---------------|-----------------------------------------------|
| Backend       | Node.js, Express 5                            |
| Database      | MongoDB with Mongoose                         |
| Real-time     | Socket.IO                                     |
| Auth/Sessions | express-session + connect-mongo               |
| Payments      | SSLCommerz (`sslcommerz-lts`) + optional Stripe, PayPal, Flutterwave, Mollie |
| Email         | Nodemailer                                    |
| AI Chatbot    | Gemini, OpenAI, Anthropic or OpenAI-compatible (your choice) |
| Frontend      | Plain HTML/CSS/JS with jQuery and Bootstrap 5 (loaded from a CDN with integrity hashes; no build step) |

---

## Requirements

- Node.js 24 LTS recommended (Node.js 22.12 or newer is supported); `.nvmrc` selects 24 for nvm and fnm
- A MongoDB database (local install, or a free MongoDB Atlas cluster)
- An account with at least one payment gateway you want to use (SSLCommerz,
  Stripe, PayPal, Flutterwave or Mollie; a free sandbox account is enough for
  testing). Cash on Delivery and manual transfer need no account.
- An API key from your chosen AI provider (Gemini has a free tier) if you want the chatbot
  feature active
- An SMTP email account (Gmail app password, Brevo, Mailgun, etc.). **Email
  setup is required for a working store:** order confirmations, status updates
  and customer email verification all go out by email. Without it the server
  prints a warning at start-up, order emails are skipped, and customers cannot
  verify their address, so they cannot see orders they placed as a guest. The
  link in the verification email only opens the shop; the page then confirms it
  with a second request, so mail scanners that open links cannot verify an
  address. Set `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USER` and `EMAIL_PASS` in `.env` before
  going live. The example values in `.env.example` (`smtp.example.com`,
  `your-email@example.com`...) count as "not set". Port 465 is detected
  automatically as a secure (SSL/TLS) connection; use 587 for STARTTLS.

---

## Installation

1. **Extract the package** and open a terminal in the project folder.

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Create your environment file** by copying the example and filling in
   your own values:
   ```bash
   cp .env.example .env
   ```
   See the [Environment Variables](#environment-variables) section below
   for what each value means and where to get it.

4. **Generate your admin password hash** (never store a plain-text password):
   ```bash
   node scripts/hash-password.js "YourChosenPassword"
   ```
   Copy the printed line into your `.env` file **exactly as printed, including
   the single quotes**: a hash is full of `$` signs, and Docker Compose would
   otherwise read them as variables and silently corrupt the hash (the server
   warns at start-up if the hash looks wrong). The quotes are only for the
   `.env` file. If you set `ADMIN_PASSWORD_HASH` somewhere else (a hosting
   dashboard's environment-variable form, or `docker run --env-file`), paste
   the hash **without** the quotes, because those places keep them as part of
   the value.

5. **(Optional) Seed the demo marketplace** - adds 4 demo shops and 40
   products (Men / Women / Kids clothing and Accessories) with bundled illustrations, so you have
   something to look at immediately:
   ```bash
   npm run seed
   ```
   This is safe on a database that already has products: it only adds demo
   products whose title is missing and never deletes or edits anything. To
   replace the store's own products and the demo shops' products with the demo
   set (**fresh or throw-away databases only**), run
   `npm run seed -- --reset --yes`. Real sellers' shops and products are never
   touched, and a demo shop that orders or payouts already refer to is kept.

   Demo prices are sample numbers; set your own `CURRENCY_CODE` and edit the prices in `seed/catalog.js`.

6. **Start the server:**
   ```bash
   npm start
   ```
   or, for auto-restart during development:
   ```bash
   npm run dev
   ```

7. **Open the app:**
   - Storefront: `http://localhost:3000`
   - Admin panel: `http://localhost:3000/admin.html`

---

## Run with Docker (one command)

If you have Docker installed, you don't need Node or MongoDB on your machine:

```bash
cp .env.example .env     # then fill in your values (see Environment Variables)
docker compose up --build
```

The app starts on `http://localhost:3000` (or the `PORT` in your `.env`) with
a MongoDB container wired up automatically - `MONGODB_URI` in `.env` is
ignored in this mode. The database and the uploaded product pictures are kept in
Docker volumes between restarts (`mongo-data` and `uploads-data`).
Keep `ADMIN_PASSWORD_HASH` in single quotes in `.env` (see step 4 of the
installation above); `docker compose` would otherwise mangle the `$` signs.
`TRUST_PROXY` defaults to `0`; set `TRUST_PROXY=1` in `.env` if you put nginx or
another reverse proxy in front.

Load the demo products (adds missing ones only; it never deletes products):

```bash
docker compose exec app npm run seed
```

**The container always runs in production mode** (`NODE_ENV=production` is set in
the `Dockerfile` and in `docker-compose.yml`). That means:

- `SESSION_SECRET` must be a real random string of 32+ characters, otherwise the
  app refuses to start. (Generate one with
  `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.)
- Session cookies are marked **Secure**, so they only travel over HTTPS. Browsers
  accept this for `http://localhost`, but **Safari and any plain-HTTP address
  (for example `http://192.168.1.20:3000`) will silently refuse to keep you logged
  in.** For local testing only, add `COOKIE_SECURE=false` to `.env`. Never do
  that on a live site.
- Cross-site requests are blocked unless you list your site in `ALLOWED_ORIGIN` (one origin, or several separated by commas).

For a live deployment, put the app behind HTTPS (a reverse proxy such as nginx
or Caddy) and set `TRUST_PROXY=1`.

---

## Running the tests

```bash
npm install
npm test
```

The whole suite runs in under a minute and needs no database or API keys. They cover model validation, admin
login and roles, CSRF protection, input validation, security headers, the
production startup check, and the order flow (payment verification, stock
reservation, cancellation and expiry of unpaid orders), the SEO pages
(meta tags, structured data, robots.txt, sitemap.xml, noindex on admin), and
Cash on Delivery (checkout rules, stock, expiry, cancelling, marking cash as
received), and coupons (rules, atomic use counting, discounted totals, giving
uses back, admin permissions).

After you edit this README, run `npm run docs` to rebuild the one-page copy in
`docs/index.html`.

---

## Roles & Access (admin accounts and permissions)

Log in to the admin panel and open **Roles & Access** in the sidebar. From
there an Admin can:

- **Create and delete roles** (for example "Manager" or "Packer").
- **Set what each role can do** with the **Permission** button, which opens a
  matrix of View / Details / Create / Edit / Delete for each item
  (Product, Order, Coupon). A dash means that action doesn't exist for that item
  (orders are created by customers at checkout and are never deleted here).
- **Add and remove staff accounts** (user name + password + starting role).
- **Add a role to a user, list a user's roles, and remove a role from a user.**
  A user can have several roles; they get the combined permissions.

What the permissions control:

| Permission | Lets the person... |
|------------|------------------|
| Product: View | See the product list |
| Product: Create | Add products |
| Product: Edit | Edit products, and quick-save price/stock |
| Product: Delete | Delete products |
| Order: View | See the order list |
| Order: Details | Open a single order / invoice |
| Order: Edit | Change an order's status, confirm orders, mark Cash on Delivery orders as paid and mark refunds as processed |
| Coupon: View | See the coupon list |
| Coupon: Create | Create coupons |
| Coupon: Edit | Edit a coupon, switch it on or off |
| Coupon: Delete | Delete coupons |
| Audit: View | See the audit log of staff actions |
| Vendor: View | See shops and their earnings (marketplace) |
| Vendor: Edit | Approve / suspend shops, set commissions and record payouts (marketplace) |

Notes:

- **Admin** (built-in) always has every permission and is the only role that
  can open Roles & Access. The admin defined in your `.env`
  (`ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH`) always has the Admin role and is
  not listed as a staff account.
- **Staff** (built-in) is the default role: manage products (except delete)
  and orders, and view coupons. You can change its permissions but not delete it.
- Changes apply **immediately**, even to people who are already logged in.
  Removing an account signs that person out on their next click.
- Statistics needs Order: View (the figures are order figures; the product counts on the same page come along with it). Someone with no role
  sees a "no permissions yet" message.
- The server checks every request. Hiding buttons in the page is only a
  convenience.

You can also create accounts from the command line:

```bash
npm run create-admin -- jane StrongPassword123 staff
npm run create-admin -- ali StrongPassword123 "Order Manager"   # any role you created
npm run create-admin -- sam StrongPassword123 owner              # the Admin role
# with Docker:
docker compose exec app node scripts/create-admin.js jane StrongPassword123 staff
```

Running it again for the same user name resets that person's password.

---

## Coupons

Open **Coupons** in the admin sidebar and press **New Coupon**:

| Field | Meaning |
|-------|---------|
| Code | 3-32 characters: letters, numbers, `-` and `_`. Saved in capitals, unique, can not be changed later |
| Type / Value | Percent (above 0, up to 100) of the cart total, or a fixed amount |
| Minimum order | The cart must be worth at least this much (optional) |
| Maximum discount | Caps a percent coupon (optional) |
| Starts / Ends | The coupon only works between these times (optional) |
| Usage limit | How many orders may use it (optional) |
| Per-customer limit | How many orders one customer may use it on (optional). Customers are told apart by email address; `+tag` suffixes and Gmail dots count as the same address. A customer with a genuinely different mailbox is a different customer |
| Active | Switch off to stop new orders using it without deleting it |

How it works:

- Customers type the code in the cart. The server prices the cart from the
  database, checks the rules and shows the new total. Nothing the browser says
  about prices or discounts is trusted.
- The order records the coupon and the discount. The discounted total is what
  SSLCommerz or Stripe charges and what payment verification compares against.
- A discount never takes an order below **the minimum order total** (`MIN_ORDER_TOTAL`, default 0 = no minimum, **in your own currency**; an order total of 0 is always refused), the smallest payment the
  gateways accept.
- One use is counted when the order is placed, with a single atomic update, so a
  coupon can not be used more often than its limit even when many customers
  order at once. The use is **given back** when the order fails, is cancelled
  before it ships, or expires unpaid. Reopening a cancelled order takes it again.
- Disabling a coupon does not affect orders that already used it. Deleting a
  coupon keeps the discount on those orders.
- A code that does not exist and a disabled one give the same message, and the
  cart box allows 30 attempts per 10 minutes per IP, so codes can not be guessed.

---

## Cash on Delivery (optional)

Cash on Delivery (COD) is off by default. To offer it, set in `.env`:

```
COD_ENABLED=true
COD_MAX_AMOUNT=10000      # optional: largest order total payable in cash
```

Restart the app and a **Cash on Delivery** button appears next to the other
payment methods. `COD_MAX_AMOUNT` is a plain amount; leave it empty (or `0`) for no
limit. The server checks both settings again when the order is placed, using the
total it works out itself from the product prices.

How a COD order behaves:

- It needs a valid **phone number** and a **delivery address** (street and city).
- Its stock is reserved straight away (the same atomic update as other orders).
- It is **placed (PLACED)** with no payment gateway, and stays that way until
  staff confirm it (`COD_CONFIRM_HOURS` is the window; after it the order is
  cancelled and its stock returned). The customer gets a confirmation email,
  which also says how much to pay in cash.
- It is never "pending", so the unpaid-order timer does not cancel it.
  Cancelling it in the admin panel returns its stock once, like any other
  order that has not shipped.
- The order list and the invoice show **COD / unpaid**. Once the order is
  **DELIVERED**, use **Mark cash received** to record the cash; the badge turns
  to **COD / paid**. This needs the **Order: Edit** permission, works once per
  order, and only for COD orders that are delivered.
- **Revenue** - one rule everywhere (dashboard cards, Revenue page, API): an order
  counts once it is **paid** and while it is **not cancelled**. A COD order counts
  after its cash has been received; a manual order after you confirm it.
- **Status changes** follow a fixed path: PLACED, then CONFIRMED, then SHIPPED,
  then DELIVERED, a cancel from any live status, and a reopen of a cancelled order.
  An unpaid online (PENDING) order is confirmed by its payment, not by hand.
  Cancelling any paid order flags it **Refund Due**.

---

## Wishlist

Nothing to set up. Every product card has a heart. A visitor who is not logged in
keeps the list in their browser; when they log in, it is merged into their
account and then follows them to any device (up to 200 products). Out-of-stock
and deleted products are handled: deleted ones drop out of the list.

---

## CSV product import (admin)

In the admin panel, open **Products** and then **Import CSV** (needs the *product create* and/or
*edit* permission, depending on the mode).

1. Download the template from the dialog (or use your own file; `Name`, `Qty` and
   `Image` also work as column names).
2. Choose the file and a mode: **add new only**, **update existing only**, or
   **update existing and add new**. Products are matched by **title**, ignoring
   capitals.
3. Press **Preview**. Nothing is saved yet; every row is shown as New, Update,
   Skipped or Error, with the reason.
4. Press **Import**.

Columns: `title` (required), `price`, `stock`, `category`,
`description`, `imageUrl` (an address, not an embedded picture) and `sizes`
(optional, stock per size written like `S:5;M:3;L:2`; the product's total stock
then becomes their sum and the `stock` cell is ignored). A new product
needs a price. In update mode an empty cell keeps the current value. Limits: 500
rows and 1 MB per file. Comma, semicolon and tab separated files all work, and
so do files saved by Excel (UTF-8 with a BOM). Each import is written to the
audit log.

---

## Sizes and product pictures

**Stock per size.** In the product form (admin panel and seller area) tick
**Keep stock for each size** and fill in the units of every size you sell. Leave a
size empty if you do not sell it; `0` shows it as *sold out*. Customers can only
pick the sizes you filled in, a sold-out size cannot be chosen, and an order takes
its units from that size. The product's total stock is always the sum of its sizes,
so lists, the low-stock report and the chatbot keep working. Products without this
option keep one stock number, exactly as before, and you can switch a product between
the two ways in its edit form. Cancelling an order puts the units back into the size
they came from. Saving the form changes each size only by the amount you changed it,
so units sold while the form was open stay sold. Switching a product from one stock
number to sizes while orders are being placed can briefly miscount; do it at a quiet moment.

**Pictures.** A product has one main picture and up to 5 more. Uploaded files are stored in
`UPLOAD_DIR` (default `uploads/`) under random names and served from `/uploads/`; the
product keeps only the short address. In Docker the folder is a volume (see
`docker-compose.yml`). Back it up together with the database. Pictures uploaded in a form that
is never saved are deleted after a day, and a product's files are deleted with the product
(unless another product uses the same file). Each shop, and the store's own products, can
hold at most 300 picture files: the ones its products use plus unused uploads from the last
day. Past that, uploads are refused until pictures are removed. The main picture can also still be an address
(`https://...`; plain `http://` addresses are refused because the page's security policy would block them). The product page (`/product/<id>`) shows the extra pictures and adds them to
the search-engine data.

On hosting without a persistent disk set `UPLOAD_STORAGE=database`: pictures then stay inside
the product record (the older way) and only one picture per product is possible.

**Pictures stored inside the product record** (the database storage mode) keep working. To move them to files, run
`npm run migrate-images` (it only reports what it would do) and then
`npm run migrate-images -- --apply`. Make a database backup first.

---

## Shipping rates (optional)

Off by default. In `.env`:

```
SHIPPING_ENABLED=true
SHIPPING_FLAT_RATE=60       # every address (example; the shipped default is 0)
SHIPPING_FREE_OVER=5000     # goods (after coupon) at or above this ship free; 0 = never
SHIPPING_HOME_CITY=Dhaka    # optional special rate for one city...
SHIPPING_HOME_RATE=60       # ...(capitals and extra spaces do not matter)
```

The customer sees the fee in the cart (it updates when they type their city) and
a hint such as "Add 350.00 more for free shipping". The server works out the fee
itself and adds it **after** the coupon, so the gateway charges the full total,
the Cash on Delivery limit counts it, and invoices and emails show a Shipping
line. If you change the rates while someone is checking out, their order is
refused with the usual "price changed" message and the cart refreshes.

---

## Two-factor admin login (optional)

Off by default. Set `ADMIN_2FA_ENABLED=true` and restart. Each admin then clicks
**2FA** in the admin top bar, adds the key to an authenticator app (Google
Authenticator, Microsoft Authenticator, Authy, 1Password...), types the first
code, and saves the 8 one-time **backup codes** that are shown once. From then on
that account must give a code at login. Accounts that have not set it up keep
logging in with their password only, so you cannot lock anyone out by switching
the feature on.

Safety details: a code cannot be used twice, 10 wrong codes in a row pause the
account for 15 minutes, and turning it off needs the password plus a code. The
secrets are stored encrypted with `TWO_FACTOR_ENCRYPTION_KEY` (or, when that is
empty, a key derived from `SESSION_SECRET`), so changing the key makes them
unreadable and each admin must set 2FA up again. Admin logins and failed logins are written to the audit log (the
username only). If an admin loses the phone and the backup codes, run this on
the server:

```
node scripts/reset-2fa.js <username>            # the admin from .env
node scripts/reset-2fa.js <username> staff      # an account made in the panel
```

---

## Currency

The store shows **plain numbers only**: no currency sign, code or name appears
on any page, email, invoice or in the admin panel. Two things in `.env` still need a
machine-readable code, and neither is ever shown to customers:

```
CURRENCY_CODE=        # 3-letter ISO 4217 code of your prices, sent to payment gateways and search engines
MIN_ORDER_TOTAL=0     # smallest order total for any payment method (a plain number in YOUR currency)
```

Online payment methods are switched off until `CURRENCY_CODE` is set. Card
gateways charge in the same currency unless you set `CARD_CURRENCY` (and a
`CARD_RATE`, how many card-currency units 1 price unit is worth). The rate is
not fetched from the internet. If your cards are charged in a different
currency, say so in your Terms page.

**How amounts are kept.** Money is stored and added up in whole units of the smallest piece of your own
currency, so totals never pick up rounding errors. That piece follows `CURRENCY_CODE`:

- **Two decimals** (most currencies, and any code that is not listed below): prices, coupon amounts, shipping and
  limits can have up to two decimals.
- **No decimals** (BIF, CLP, DJF, GNF, JPY, KMF, KRW, MGA, PYG, RWF, VND, VUV, XAF, XOF and XPF): prices, coupon
  amounts and fees must be whole numbers, and every total is a whole number. A percentage coupon or commission is
  rounded to a whole unit.
- **Three decimals** (BHD, JOD, KWD, OMR and TND): up to three decimals.
- A **percentage** (coupon, commission) always has up to two decimals, whatever the currency.
- With no `CURRENCY_CODE` the shop works in hundredths, as for two-decimal currencies.

**What a gateway is sent.** Card gateways charge in `CARD_CURRENCY` (default `CURRENCY_CODE`) at `CARD_RATE`, in the
decimals that currency has: whole units for the no-decimal currencies, three decimals for the three-decimal ones
(rounded once to a multiple of 10 thousandths, as Stripe asks), two for everything else. ISK and UGX stay at two
decimals, as Stripe expects. PayPal also wants whole amounts in HUF and TWD, so PayPal uses whole units there while
Stripe, Flutterwave and Mollie keep two decimals.

**Smallest order and smallest card charge.** An order total can never be 0: the smallest total any payment method
accepts is one smallest unit of your currency (or `MIN_ORDER_TOTAL`, if that is higher), so a 100% coupon leaves that
one unit to pay. For Stripe, the smallest charge per currency is the amount Stripe publishes for 31 currencies
(`services/stripeMinCharge.json`, for example 50 in JPY). Stripe applies the minimum of your account's
settlement currency, which the shop cannot see, so the table is used for the card currency: check it if your Stripe
account settles in a different currency. PayPal, Flutterwave and Mollie use one flat minimum (0.50 in a two-decimal
currency, or 500 thousandths in a three-decimal one), and each of them still applies its own limits and refuses a
payment that is too small.

**Not verified against the gateways.** The amount rules follow each gateway's published currency rules, but the tests
only use fakes for the gateways, so none of them has been confirmed against a live or sandbox gateway. Test each one
in that gateway's sandbox before you sell in that currency, especially HUF and TWD, the three-decimal currencies
(check the amount the gateway shows) and the no-decimal currencies.

---

## Marketplace (multi-vendor)

Off by default. Turn it on in `.env` and restart:

```
MULTIVENDOR_ENABLED=true
MARKETPLACE_COMMISSION_PERCENT=10     # what a new shop starts with
```

**How it works**

1. A shopper creates an account and clicks **Sell with us**, then sends an
   application (shop name, description, phone).
2. In the admin panel, **Vendors**, you **Approve** the shop. Only approved shops
   can add products, and only their products are visible and buyable.
3. The seller manages everything from `/vendor.html` (**Seller dashboard**):
   products (with pictures), orders that contain their items, earnings and
   their shop details. They never see other sellers' items or the buyer's email.
4. A shopper can put items from several shops in one cart and pay once. The
   order remembers which seller sold each item and the commission that applied
   *at that moment*, so changing a commission later never rewrites past orders.
5. Each seller ships their own items and marks them **shipped** and then
   **delivered**, step by step, with an optional tracking note. The order must be
   paid first, and a cash / transfer order must be **confirmed by the store**
   (status CONFIRMED) before sellers can ship it; unpaid, unconfirmed or cancelled
   orders cannot be shipped, and customer details are shown to a seller only from
   CONFIRMED on. When every seller of an order has shipped, the order becomes
   SHIPPED; when every seller has delivered, DELIVERED (an order that also contains
   the store's own items is moved by staff). Setting an order SHIPPED or DELIVERED
  by hand also moves every seller's part that is not delivered yet.
   Categories are **Men, Women, Kids and Accessories** (the same list in the seller
   form, the storefront filter and the seed). Sizes are XS to XXL plus *One Size*
   for accessories. A customer always chooses a size at checkout, so an accessory keeps its stock
   under the single size *One Size* (the demo accessories do this).
6. Delivered orders become **payable** once the hold is over (`PAYOUT_HOLD_DAYS`, default **7** days after the seller
   marked their part delivered; a seller marks their own part, so the hold is your window for returns, disputes and card
   chargebacks). You pay the seller outside the app (bank,
   mobile banking, ...) and then press **Record payout** under *Vendors*, then *Earnings*. A
   payout covers whole orders and the database refuses to pay the same order to
   the same seller twice, even if two admins click at once.

**The money rules**

- A seller earns the price of their items **minus the commission percent** of
  each item. Example: 2 x 899 at 10% gives sales of 1,798.00, commission 179.80, the
  seller earns 1,618.20.
- Coupon discounts and shipping fees stay with the marketplace (the seller's
  share is never reduced by a coupon). **Business risk:** because of this, a
  coupon is paid out of your own share (commission + shipping + your own items).
  To make sure you never pay out more than the customer paid, checkout and the
  coupon preview **refuse a coupon that would push your share below zero** (for
  example a 100% coupon on a seller's item). A coupon that is merely larger than
  the commission is still allowed when shipping or your own items cover it, so
  keep percent coupons modest. Gateway fees are not counted.
- **Admin figures.** *Sales* is everything customers paid on paid, not
  cancelled orders (it includes the sellers' shares and shipping). With the
  marketplace on, the dashboard also shows *Commissions*, the sellers' share, and
  *Store revenue* = your own items + commission + shipping - coupon discounts
  (that is, sales minus the sellers' share). They use the same rounding as the
  payouts, so the dashboard and the payouts agree.
- Only paid orders that are not cancelled count, the same rule as the admin
  revenue statistics. The one exception: with `SELLER_KEEPS_SHIPPED_ON_CANCEL=true`, what the sellers keep on cancelled
  orders is shown as its own line and taken off *Store revenue* (the store pays it while the customer is refunded).
- **Shipped goods are never restocked.** If an order is cancelled after a seller has shipped their part, that part's
  items are not added back to the stock (they left the building). Add them back by hand when the parcel returns. This
  does not depend on whether the seller keeps their earnings.
- **Clawback.** If an order is cancelled *after* you paid the seller for it, that
  amount is owed back. It shows as "Refund due" in the seller's earnings and is
  taken off their next payout automatically. If it is as large as what is payable,
  no payout is recorded and it stays against future earnings. (Refunding the
  customer's money is still done outside the app.)
- Earnings and payouts always cover **every** order of a seller, however many
  there are (orders are read in batches, so memory stays flat). The screens show
  the newest 200 lines; the totals include all of them.

**Suspending a shop** hides its products everywhere (store, search engines'
sitemap, wishlists, the chatbot, and the product pictures) and refuses new orders
for them, immediately. A suspended seller can still read their items and earnings
(to settle up) but **no longer sees customers' names, phone numbers or
addresses**, and cannot ship or edit anything. That includes orders paid before the
suspension: the store marks them shipped under *Orders*, or the seller does once
the shop is reinstated. Reinstating brings everything back. Nothing is deleted.

**Not included** (plan for these before selling to marketplaces that need them):
automatic split payments (payouts are manual), per-seller shipping fees (one
shipping fee applies to the whole order and stays with the marketplace),
seller-specific coupons, seller e-mail notifications, and a seller-facing refund flow.
(Customer reviews are included; see *Reviews*.)

**Demo shops.** `npm run seed` creates four sample shops with no login, already
**approved**. On a live marketplace they would earn commission and could be paid
out, so delete or suspend them under *Vendors* (or seed with `--no-shops`).
`npm run seed -- --reset --yes` removes the store's own products and the demo
shops (matched by slug, no owner) and never touches real sellers. To try
the seller side, register a normal account on the store, apply to sell, then
approve yourself under *Vendors* in the admin panel.

**Permissions.** Admin accounts see *Vendors* only with the `vendor` permission
(view to see shops and earnings, edit to approve, change commission and record
payouts). It is part of the built-in *Admin* role and can be added to custom
roles under *Roles & Access*.

---

## Reviews

A logged-in customer can review a product once, after an order that contains it has the
status **Delivered** (guest orders count once the customer has verified the e-mail address).
In **My orders** a *Review* button appears for each delivered product: 1 to 5 stars and an
optional text of up to 1,000 characters, stored as plain text. Reviews show the customer's first
name and the initial of the last name, never the e-mail address. The product's average rating and
review count are shown on product cards, on the product page (`/product/<id>`, with the latest 10
reviews) and in the search-engine data.

Staff with the *product view* permission see **Reviews** in the admin panel; with *product edit*
they can **Hide** a review (it disappears from the store and from the average) or **Delete** it. Both
are written to the audit log. Deleting a product deletes its reviews.

---

## Installable store (PWA)

The store has a web app manifest (`/manifest.webmanifest`, named after `SITE_NAME`), app icons
(`public/img/icon-192.png` and `icon-512.png`, drawn by `node scripts/generate-pwa-icons.js`; replace
them with your own artwork, same names and sizes) and a service worker (`public/sw.js`). On a phone the
browser then offers *Add to Home screen*. The worker only keeps the store's own pictures, style sheets
and scripts for faster visits and shows `offline.html` when the network is down. It never stores or
answers `/api`, `/admin`, the seller and payment pages, product pages, uploaded pictures or any request
that is not a plain GET. Browsers only run service workers on `https://` addresses and on `localhost`.
Pictures are cached by browsers for a week. Pages, scripts and style sheets are loaded from the network first (the saved copy is used only when the visitor is offline). When you change the version in `package.json`, change `VERSION` in `public/sw.js` too; a test checks that they match.
Compression is not built in: your reverse proxy (nginx, Caddy, Cloudflare) should provide gzip or brotli.

---

## Dark mode

The storefront has an optional dark theme. Visitors switch it with the
Dark/Light button in the navbar and the choice is remembered in their
browser. Light stays the default.

---

## Environment Variables

All configuration lives in `.env` (see `.env.example` for the full template
with inline comments).

| Variable                     | Required | Description                                              |
|-------------------------------|----------|------------------------------------------------------------|
| `MONGODB_URI`                 | Yes      | Your MongoDB connection string                             |
| `DB_NAME`                     | No       | Database name (default: `ecommerce`)                       |
| `PORT`                        | No       | Server port (default: `3000`)                              |
| `NODE_ENV`                    | No       | `development` (shipped in `.env.example`) or `production`. Set `production` before you go live: it needs a real `SESSION_SECRET` and HTTPS cookies. Docker always runs `production` |
| `ALLOWED_ORIGIN`               | Prod only| Your live address as an origin (https://www.example.com; a comma separated list works too): CORS lock-down, and counted as this site by the cross-site write protection |
| `SESSION_SECRET`               | Yes      | Random string (32+ characters) used to sign session cookies |
| `ADMIN_USERNAME`               | Optional | Admin panel login username. Leave empty and create the owner at `/setup` instead |
| `ADMIN_PASSWORD_HASH`          | Optional | Output of `scripts/hash-password.js` - never a plain password. Only with `ADMIN_USERNAME` |
| `EMAIL_HOST` / `PORT` / `USER` / `PASS` | Recommended | SMTP credentials for order-status and email-verification emails. Optional for the server to start, but without them emails are skipped and customers cannot verify their address |
| `EMAIL_FROM`                   | No       | Sender shown on emails (default: `Threadly <EMAIL_USER>`) |
| `EMAIL_SECURE`                 | No       | `true` / `false` (any capitalisation) to force SSL/TLS on or off. Default: on for port 465, off otherwise |
| `SSLCOMMERZ_STORE_ID`          | Optional      | From your SSLCommerz merchant dashboard. Leave unset and SSLCommerz is not offered at checkout |
| `SSLCOMMERZ_STORE_PASSWORD`    | Optional      | From your SSLCommerz merchant dashboard                     |
| `SSLCOMMERZ_IS_LIVE`           | Optional      | `false` for sandbox testing, `true` for real transactions    |
| `MANUAL_PAYMENT_ENABLED`       | No       | `true` offers bank / mobile-banking transfer at checkout (default: off) |
| `MANUAL_PAYMENT_INSTRUCTIONS`  | No       | What the customer sees about where to send the money        |
| `MANUAL_PAYMENT_HOURS`         | No       | Hours before an unpaid manual order is cancelled (default 24) |
| `MANUAL_PAYMENT_REVIEW_HOURS`  | No       | Extra hours an order with a payment reference waits for you to check it, before it is cancelled and flagged *Refund due* (default 72) |
| `SUPPORT_EMAIL` / `SUPPORT_PHONE` / `SUPPORT_ADDRESS` | No | Contact details shown in the footer and on the policy pages; empty ones are not shown |
| `STRIPE_SECRET_KEY`            | Optional | From dashboard.stripe.com - enables the international card option |
| `STRIPE_WEBHOOK_SECRET`        | Optional | From your Stripe webhook endpoint settings                  |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | Optional | From developer.paypal.com (REST app) - enables PayPal at checkout |
| `PAYPAL_IS_LIVE`               | Optional | `false` for the PayPal sandbox, `true` for real money         |
| `PAYPAL_WEBHOOK_ID`            | Optional | Id of a PayPal webhook (events `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`) for `/api/payment/paypal-webhook`; settles orders whose customer paid but did not return to the shop. Unset: the URL answers 400 |
| `FLUTTERWAVE_SECRET_KEY`       | Optional | From dashboard.flutterwave.com - enables Flutterwave at checkout |
| `FLUTTERWAVE_WEBHOOK_HASH`     | Optional | The "secret hash" you set for the Flutterwave webhook          |
| `MOLLIE_API_KEY`               | Optional | `test_...` or `live_...` key from my.mollie.com - enables Mollie at checkout |
| `BASE_URL`                     | Yes      | Public URL of your app, e.g. `https://yourshop.com` (no trailing slash needed). Used for payment redirect callbacks **and** for the canonical links, `sitemap.xml` and `robots.txt`, so set it to your real domain before going live |
| `SITE_NAME`                    | No       | Store name used in page titles, Open Graph tags and structured data (default: `Threadly`, max 60 characters) |
| `SITE_DESCRIPTION`             | No       | Short description for the home page meta description and link previews (default: a generic clothing-marketplace sentence, max 300 characters) |
| `COD_ENABLED`                  | No       | `true` offers Cash on Delivery at checkout (any capitalisation). Default: off |
| `COD_MAX_AMOUNT`               | No       | Largest order total that can be paid in cash; empty or `0` = no limit |
| `COD_CONFIRM_HOURS`            | No       | Hours an unconfirmed Cash on Delivery order stays open before it is cancelled automatically (default: `24`) |
| `COD_MAX_OPEN_ORDERS`          | No       | Most open (not yet final) COD orders per customer email or phone (default: `2`) |
| `COD_MAX_QUANTITY_PER_LINE`    | No       | Most units of one item on a COD order (default: `3`). This and the two COD settings above fall back to their defaults when the value is out of range |
| `COD_ORDER_RATE_LIMIT_MAX`     | No       | Cash on Delivery orders one address may place per hour (default: `5`). It is checked before any stock is reserved, so fake COD orders cannot lock up inventory |
| `COOKIE_SECURE`                | No       | Session cookies are Secure (HTTPS only) in production. Set `false` only when running a production build over plain HTTP (a test server, an IP address); leave empty otherwise |
| `CSP_DISABLED`                 | No       | `true` turns off the Content-Security-Policy. Only for deployments that must load scripts from a host other than this site, `cdn.jsdelivr.net` and `code.jquery.com` |
| `TRUST_PROXY`                  | No       | Number of reverse proxies in front of the app (default: `0`; set `1` behind one proxy) |
| `PENDING_ORDER_TTL_MINUTES`    | No       | Minutes an unpaid order keeps its stock reserved (default: `60`, minimum `30`); a 10 minute grace period is added before it is cancelled |
| `CHAT_ENABLED`                 | No       | `false` switches the chatbot off and hides the chat bubble (default: on when a key is set) |
| `CHAT_PROVIDER`                | No       | `gemini` (default), `openai`, `anthropic` or `openai-compatible` |
| `CHAT_API_KEY`                 | Only for chatbot | Your own API key for the chosen provider. Instead you may set the provider's own variable below |
| `GEMINI_API_KEY`               | Only for chatbot | Google Gemini key (used when `CHAT_PROVIDER=gemini` and `CHAT_API_KEY` is empty) |
| `OPENAI_API_KEY`               | Only for chatbot | OpenAI key (used only when `CHAT_PROVIDER=openai` and `CHAT_API_KEY` is empty; `openai-compatible` uses `CHAT_API_KEY` only) |
| `ANTHROPIC_API_KEY`            | Only for chatbot | Anthropic key (used when `CHAT_PROVIDER=anthropic` and `CHAT_API_KEY` is empty) |
| `CHAT_MODEL`                   | For chatbot | Model name, required for every provider (there is no default; check the provider's model list) |
| `CHAT_BASE_URL`                | Only for `openai-compatible` | Base address of the compatible service (HTTPS) |
| `CHAT_MAX_TOKENS`              | No       | Longest answer, in tokens (Anthropic default `1024`) |
| `CHAT_TEMPERATURE`             | No       | Creativity from `0` to `2` |
| `CHAT_TIMEOUT_MS`              | No       | Time allowed for one request to the provider |
| `CHAT_ANTHROPIC_VERSION`       | No       | `anthropic-version` header value used for Anthropic |
| `CHAT_FALLBACK_MODELS`         | No       | Comma-separated models to try if the main one keeps failing (default: none). Only models your key can use |
| `CHAT_MAX_RETRIES`             | No       | Retries per model for temporary errors such as 429 or 503 (default: `2`, max `5`) |
| `CHAT_RETRY_BASE_MS`           | No       | Starting wait between retries, doubled each time with a little randomness |
| `CHAT_TOTAL_TIMEOUT_MS`        | No       | Longest a customer waits for one chatbot answer (default: `30000`) |
| `GEMINI_MODEL`                 | No       | Older name for `CHAT_MODEL` (Gemini only; still works) |
| `GEMINI_FALLBACK_MODELS`       | No       | Older name for `CHAT_FALLBACK_MODELS` (Gemini only; still works) |
| `GEMINI_MAX_RETRIES`           | No       | Older name for `CHAT_MAX_RETRIES` (Gemini only; still works) |
| `GEMINI_RETRY_BASE_MS`         | No       | Older name for `CHAT_RETRY_BASE_MS` (Gemini only; still works) |
| `GEMINI_TOTAL_TIMEOUT_MS`      | No       | Older name for `CHAT_TOTAL_TIMEOUT_MS` (Gemini only; still works) |
| `SELLER_KEEPS_SHIPPED_ON_CANCEL` | No     | `true`: when a whole order is cancelled, a seller who already shipped their part keeps that earning. Off by default, see "Optional money rules" |
| `COUPON_SPLIT_PRO_RATA`        | No       | `true`: a coupon is shared across sellers in proportion to their items, and commission is taken on the price after the coupon. Off by default |
| `MARKETPLACE_FUNDS_COUPONS`    | No       | `true`: keeps the older rule where the marketplace pays for coupons (wins over `COUPON_SPLIT_PRO_RATA`) |
| `UPLOAD_STORAGE`               | No       | `disk` (default): uploaded product pictures are files in `UPLOAD_DIR` and a product can have up to 6 pictures. `database`: pictures stay in the product record (one picture per product), for hosting without a persistent disk |
| `UPLOAD_DIR`                   | No       | Folder for the picture files (default: `uploads/` in the project folder). It must be writable and backed up with the database. With Docker it is the volume mounted at `/app/uploads` |
| `CHAT_DAILY_LIMIT`             | No       | Most chatbot messages per day for the whole shop (default: `2000`, `0` = no limit). The count is kept **per server process**: it starts again at zero when the server restarts, and with several instances each has its own count. The server prints a warning at start-up if it is `0` while the chatbot is on |
| `CHAT_DAILY_LIMIT_PER_IP`      | No       | Each visitor address gets its own daily share of the chatbot limit, so one abuser cannot use up the shop-wide limit (default: `100`, `0` = no per-visitor limit). Also kept per server process |
| `CURRENCY_CODE`                | With any online payment | 3-letter ISO code of your prices, used only for gateways and search data (never shown). Online payment stays off until it is set |
| `CARD_CURRENCY`                | No       | Currency card gateways charge in (default: `CURRENCY_CODE`). Amounts are sent in that currency's own units (JPY and KRW have no decimals, KWD and BHD have three) |
| `CARD_RATE`                    | If the card currency differs | Card-currency units per 1 price unit; production refuses to start without it when the currencies differ |
| `MIN_ORDER_TOTAL`              | No       | Smallest order total for any payment method (default 0 = no minimum, in the shop's currency; a total of 0 is always refused) |
| `ORDER_RATE_LIMIT_MAX`         | No       | Most orders per IP address per 15 minutes (default: `20`) |
| `API_RATE_LIMIT_MAX`           | No       | Most `/api` and `/admin` requests per IP address per 15 minutes (default: `300`, allowed `30` to `10000`). Raise it if many customers share one address. Payment gateway callbacks are never limited |
| `PAYOUT_HOLD_DAYS`             | No       | Marketplace: days delivered earnings stay pending before they can be paid out (default: `7`, max `90`; `0` = no hold) |
| `MULTIVENDOR_ENABLED`         | No       | `true` turns the store into a multi-vendor marketplace (default: off) |
| `MARKETPLACE_COMMISSION_PERCENT` | No    | Commission a new shop starts with, 0 to 90 (default: `10`)  |
| `SHIPPING_ENABLED`            | No       | `true` adds a delivery fee at checkout (default: off)      |
| `SHIPPING_FLAT_RATE`          | No       | Fee for every address, a plain number in your shop's currency (default 0; set your own amount before turning shipping on) |
| `SHIPPING_FREE_OVER`          | No       | Goods total (after coupon) at or above which shipping is free; `0` = never |
| `SHIPPING_HOME_CITY` / `SHIPPING_HOME_RATE` | No | Optional special fee for one city                |
| `ADMIN_2FA_ENABLED`           | No       | `true` lets admins turn on authenticator-app login (default: off) |
| `TWO_FACTOR_ENCRYPTION_KEY`   | No       | Key that encrypts the two-factor secrets. When empty, a key is derived from `SESSION_SECRET`. Choose it once: changing it later means each admin sets 2FA up again |

> **Payment gateways, customer's choice:** every gateway is optional and is
> shown at checkout only when it is configured. SSLCommerz (cards and mobile
> banking, including Bangladeshi mobile banking) needs `SSLCOMMERZ_STORE_ID` and `SSLCOMMERZ_STORE_PASSWORD`; leave
> them empty and it is hidden. **Stripe is optional**
> - leave `STRIPE_SECRET_KEY` empty and Stripe simply does not appear at checkout; the other methods keep
> working exactly as before. You never edit `public/index.html` to switch a payment method on or off: set or
> clear its keys in `.env` and restart. (If someone sends a Stripe order to the server anyway while it is
> not configured, the server refuses it with a clear message.) Add Stripe whenever you want to serve
> international customers, without touching any other code.
>
> **Setting up Stripe (optional):**
> 1. Create a free account at [stripe.com](https://dashboard.stripe.com/register),
>    grab your **test** secret key (starts `sk_test_`) from
>    [dashboard.stripe.com/apikeys](https://dashboard.stripe.com/apikeys), and
>    put it in `STRIPE_SECRET_KEY`.
> 2. Set `CURRENCY_CODE` (and, only if cards are charged in another currency,
>    `CARD_CURRENCY` and `CARD_RATE`; the rate is a static number you update).
> 3. For the webhook (recommended, not required for testing): install the
>    [Stripe CLI](https://docs.stripe.com/stripe-cli), run
>    `stripe listen --forward-to localhost:3000/api/payment/stripe-webhook`,
>    and copy the printed webhook signing secret into `STRIPE_WEBHOOK_SECRET`.
>    In production, add a real webhook endpoint in the Stripe Dashboard
>    pointing at `https://yourdomain.com/api/payment/stripe-webhook` instead.
> 4. Switch to live keys (`sk_live_...`) only once you're ready for real
>    transactions - the same sandbox-to-live step as SSLCommerz.

### More international gateways: PayPal, Flutterwave, Mollie (optional)

Each gateway appears at checkout **only when its keys are in `.env`** - leave
them empty and nothing changes. All three charge in `CARD_CURRENCY` (default `CURRENCY_CODE`) at `CARD_RATE`
(the exact amount is stored on the order and checked again when the
customer comes back; a payment for a different amount or currency is never
confirmed). Restart the server after editing `.env`, then open
`/api/payment-options` to see which gateways are on.

**PayPal**
1. Create a REST app at [developer.paypal.com](https://developer.paypal.com/dashboard/applications)
   (the Sandbox tab first).
2. Put its Client ID and Secret in `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`,
   keep `PAYPAL_IS_LIVE=false`.
3. Pay with a PayPal *sandbox personal* account. For real money, use the Live
   keys and set `PAYPAL_IS_LIVE=true`.
4. A webhook is optional: the money is taken when the customer returns to the
   shop, and never for an order that was cancelled or has expired. To also
   settle customers who paid but closed the page, add a webhook for
   `CHECKOUT.ORDER.APPROVED` and `PAYMENT.CAPTURE.COMPLETED` pointing at
   `/api/payment/paypal-webhook` and put its id in `PAYPAL_WEBHOOK_ID`.

**Flutterwave**
1. Turn on Test mode in [dashboard.flutterwave.com](https://dashboard.flutterwave.com)
   and copy the secret key into `FLUTTERWAVE_SECRET_KEY`.
2. Optional: under Settings, then Webhooks, set the URL to
   `https://yourdomain.com/api/payment/flutterwave-webhook` and put the same
   secret hash in `FLUTTERWAVE_WEBHOOK_HASH`. This confirms orders even if the
   customer closes the page before returning. Without the hash, the webhook
   refuses every call.
3. Flutterwave's test cards are listed in its documentation.

**Mollie**
1. Copy a `test_...` API key from [my.mollie.com](https://my.mollie.com/dashboard/developers/api-keys)
   into `MOLLIE_API_KEY`.
2. The webhook address is sent with each payment, but only when `BASE_URL` is a
   public `https` address; on localhost Mollie cannot reach the shop, so orders
   are confirmed when the customer returns. Use `live_...` for real payments.

Which currencies and countries each gateway accepts depends on your merchant
account with that gateway - check it with them before you promise a gateway to
your customers. These three integrations follow each gateway's documented
REST flow and are covered by automated tests that use fake gateway replies;
test each one once with your own sandbox keys before going live.

> **The AI chatbot needs your own API key:** the chatbot will not
> work until you add a valid key for the provider in `CHAT_PROVIDER` (Gemini by
> default; see [ai.google.dev](https://ai.google.dev/gemini-api/docs)). Usage
> costs are your own, separate from this product's price. Without a key, or with
> `CHAT_ENABLED=false`, the chat bubble hides itself. Check your key and model
> with `node scripts/chat-check.js "Hello"`. Set `CHAT_MODEL` to a model from
> the provider's current list; there is no built-in default. Reliability
> (retries with backoff, `Retry-After`, fallback models, a daily limit, a clear
> "temporarily unavailable" answer) applies to every provider.

---

## Policy pages (before you launch)

The store ships with six policy pages: `/privacy.html`, `/terms.html`,
`/returns.html` (returns and refunds), `/shipping.html`, `/faq.html` and
`/contact.html`. They are linked from the footer and listed in `sitemap.xml`.
The contact details on them come from `SUPPORT_EMAIL`, `SUPPORT_PHONE` and
`SUPPORT_ADDRESS` in `.env` (nothing is shown for an empty one). The chatbot is
told to point customers to these pages and never to invent a return window or
delivery time, so keep `returns.html` as the one place those rules live.

> **These pages are templates, not legal advice.** Replace every
> `[PLACEHOLDER]` (business name, return days, delivery areas, jurisdiction,
> dates) and have the wording checked for your country before you go live.

**Other things to know before you launch**

- `MIN_ORDER_TOTAL` is 0 (no minimum) by default. Set it to a number in your own currency if tiny orders cost you more than they earn.
- The per-customer coupon limit counts one customer per normalised email address (case, `+tag` and Gmail dots are ignored). A shopper with a completely different address gets a fresh allowance.
- Rate limits, account lockouts, email caps and chat budgets are kept in the server's memory. A restart clears them and several server instances do not share them.
- See *Tested and untested* below for what you should try once on your own accounts before you go live.

## Payments that need a person to look at them

Some payments cannot be confirmed by the software alone. They show a yellow
**Payment unconfirmed** badge (or a red/yellow **Refund due** one) in the admin
order list:

| Badge | Meaning | What to do |
|---|---|---|
| Payment unconfirmed (manual transfer) | The customer sent a payment reference but you have not verified the transfer. | Check your bank or wallet, then **Payment received, confirm**. If you do nothing, the order is cancelled after `MANUAL_PAYMENT_REVIEW_HOURS` and becomes *Refund due*. |
| Payment unconfirmed (online) | SSLCommerz accepted the payment but marked it risky (`risk_level` 1), so the order stays PENDING and is **not** cancelled by the unpaid-order timer. | Check it in the SSLCommerz panel, then **Payment checked, confirm** (it counts as paid from then on) or cancel it (it then shows *Refund due*). |
| Paid after cancellation | A payment arrived for an order that was already cancelled. | Reopen the order (status CONFIRMED) or refund the customer, then press **Mark Refunded**. |
| Refund due | An order that was paid, or that the customer said they paid, was cancelled. | Check the money, refund it outside the app if needed, then press **Mark Refunded** (a refunded order cannot be reopened). |

## SEO (search engines and link previews)

Set `BASE_URL` (your real public address), `SITE_NAME` and `SITE_DESCRIPTION`
in `.env` and restart. The server then provides:

| Address | What it is |
|---------|-----------|
| `/` | The storefront, with title, description, canonical link, Open Graph and Twitter card tags, plus Organization and WebSite structured data |
| `/product/<id>` | A read-only page per product (own title, description, Open Graph tags and Product structured data with the price and availability). Each product card on the storefront links to it. An unknown id shows a 404 page |
| `/sitemap.xml` | The home page and every product page, built from the database each time it is requested |
| `/robots.txt` | Allows crawling, blocks `/api/`, `/admin/` and `/socket.io/`, and points to the sitemap |

After going live, submit `https://yourshop.com/sitemap.xml` in Google Search
Console (and Bing Webmaster Tools).

Good to know:
- Canonical links and the sitemap always use `BASE_URL`, never the address in
  the visitor's request.
- Admin pages (`/admin.html` and the `/admin/...` API) are marked `noindex`
  in the HTML and with an `X-Robots-Tag` header. `/admin.html` is left out of
  `robots.txt`: a crawler that is not allowed to open it could
  never see the `noindex`.
- Link previews (Open Graph / Twitter) need a public PNG, JPG or WebP image
  address. Product pictures in those formats, on this site or at an `https://`
  address, are used. Uploaded pictures, SVG pictures (including the bundled
  product pictures) and anything else fall back to `public/img/og-default.png`
  in previews; they still show on the product page.
- `/product/<id>` and `/sitemap.xml` have their own limit of 120 requests per
  minute per visitor; the storefront, `robots.txt` and static files are not
  limited.

---

## Project Structure

```
|-- config/                  # db.js (MongoDB), sessionSecret.js and envCheck.js (start-up checks)
|-- models/                  # Mongoose schemas (Product, Order, User, Admin, AdminTwoFactor, Role, Coupon, CouponRedemption, Vendor, Payout, AuditLog, SetupLock)
|-- middleware/
|   |-- sameOrigin.js         # Cross-site write protection for /admin, /api/users, /api/vendor and checkout, coupon, chat and payment-reference writes
|   `-- demoMode.js           # DEMO_MODE: refuses deletes and changes to staff, roles, passwords, 2FA, vendors, payouts and refund marks
|-- routes/
|   |-- api.js                # Public storefront + payment + chat endpoints
|   |-- admin.js               # Admin-only product/order management
|   |-- adminExtras.js        # CSV product import and two-factor setup (attached to admin.js)
|   |-- seo.js                  # Home page meta tags, robots.txt, sitemap.xml, /product/:id
|   |-- setup.js               # First-run /setup page API (token rule, owner claim)
|   |-- vendor.js              # Marketplace: public shops and the seller's own area
|   `-- users.js                # Customer registration/login/orders
|-- services/
|   |-- emailService.js       # Order, status and email-verification emails
|   |-- orderService.js        # Stock reserve/release, cancel and reopen orders, expiry of unpaid orders
|   |-- cod.js                  # Cash on Delivery settings and checkout rules
|   |-- marketplace.js        # Marketplace rules: visibility, commission, earnings, payouts, revenue split
|   |-- money.js                # Integer-minor money helpers
|   |-- productRules.js        # One set of product rules (price and stock) for admin, CSV and sellers
|   |-- images.js               # Product picture address rules and serving
|   |-- uploads.js              # Picture files on disk (UPLOAD_DIR), clean-up of unused files
|   |-- sizes.js                # Sizes and stock per size
|   |-- stock.js                # Atomic stock changes (whole stock and per size)
|   |-- productUpdate.js       # The part of a product edit that the admin and seller routes share (stock plan, pictures)
|   |-- categories.js          # The category list (Men, Women, Kids, Accessories) and name matching
|   |-- brand.js                # The shop name (SITE_NAME) for server-side text
|   |-- reviews.js              # Review rules (who may review), cleaning, rating summary
|   |-- orderStatus.js         # Which status changes an admin may make
|   |-- paymentConfig.js       # Which payment methods are configured / offered
|   |-- paymentReference.js    # Flags orders that share a manual-payment reference; drops the old unique index
|   |-- logRedact.js           # Blanks secrets (tokens, keys, transaction ids) in access-log addresses
|   |-- origins.js             # ALLOWED_ORIGIN as one origin or a comma separated list (CORS, Socket.IO)
|   |-- passwordRules.js       # One password rule for customers and staff
|   |-- sessions.js            # Ends a customer's other sessions after a password change or reset
|   |-- loginGuard.js          # Locks one account for a while after too many wrong passwords
|   |-- mailBudget.js          # Caps how many order emails and verification or reset links one address receives per hour
|   |-- chatClients.js         # Chat history under the tl_chat cookie and the daily chat share per visitor address
|   |-- intlGateways.js        # PayPal, Flutterwave and Mollie
|   |-- auditService.js        # Audit log writer
|   |-- shipping.js            # Shipping rates (flat, home city, free over a limit)
|   |-- csvImport.js           # CSV reading and the import plan
|   |-- totp.js / twoFactor.js # Authenticator-app codes and the 2FA login check
|   |-- coupons.js              # Coupon rules (plain functions)
|   |-- couponService.js        # Atomic coupon use counting
|   |-- permissions.js         # Permission catalog and built-in roles
|   |-- adminEnv.js            # Tells a missing, valid and malformed .env admin apart
|   |-- seo.js                  # SEO settings, meta tags, JSON-LD, sitemap and product page rendering
|   |-- chatPolicy.js          # chatbot instructions
|   |-- llm/                   # chatbot: index.js (request, retries, fallback models), config.js (settings from .env)
|   |   |-- retry.js            # Retry-After parsing and back-off delays
|   |   `-- providers/          # gemini.js, openai.js, anthropic.js and openaiCompatible.js (OpenAI-style servers)
|   `-- plainText.js           # strips markup characters from titles and names
|-- public/                   # Storefront + admin frontend (HTML/CSS/JS); img/ holds the bundled SVG artwork;
|                             #   js/brand.js puts SITE_NAME into every page; js/i18n.js switches language and the Bootstrap RTL build;
|                             #   js/motion-core.js holds the stock flash and placeholder logic; css/payment.css styles the payment result pages
|   `-- privacy / terms / returns / shipping / faq / contact .html   # Policy pages (templates: replace the [PLACEHOLDERS])
|-- seed/seed.js               # Demo seeding script; seed/catalog.js holds the demo shops and products
|-- scripts/hash-password.js   # Admin password hash generator
|-- scripts/create-admin.js    # Create extra admin accounts from the command line
|-- scripts/migrate-images.js  # Move pictures stored in the database to files (npm run migrate-images)
|-- scripts/generate-pwa-icons.js  # Draws the app icons (public/img/icon-192.png, icon-512.png)
|-- scripts/chat-check.js      # Send one test message to your chatbot provider (checks key and model)
|-- scripts/generate-store-assets.js  # Draws a 200 x 200 icon and a 1600 x 800 preview as SVG files in store-assets/
|-- scripts/pack.js            # Builds threadly.zip, one top-level folder named threadly (npm run pack)
|-- docs/index.html            # This README as one self-contained page with a table of contents
|-- scripts/reset-2fa.js       # Turn off two-factor login for a locked-out admin
|-- scripts/demo-reset.js      # Puts a demo site back to its starting state (npm run demo:reset -- --yes); lib/ holds its guard and purge
|-- scripts/generate-*.js      # Build the bundled brand and product SVG artwork (lib/garments.js)
|-- tests/                     # Automated tests (npm test)
|-- Dockerfile / docker-compose.yml   # One-command Docker setup
|-- server.js                  # App entry point
|-- CREDITS.md / LICENSE.txt   # Image credits and licence
`-- .env.example                # Environment variable template
```

---

## Tested and untested

The automated tests (`npm test`) run against a fake database and mocked payment gateways, email and AI services, so they need no internet and no accounts. They check the shop's own rules thoroughly: money in whole minor units, stock, coupons, orders, payouts, permissions and security. They cannot show how real services behave. Before you go live, try these once yourself (`TESTING_GUIDE.md` has the steps):

- **MongoDB.** The atomic stock, coupon and order updates are tested against the fake database only. Run a few real orders (including two buyers racing for the last item) on your own MongoDB.
- **Payment gateways.** Make one sandbox payment on every gateway you switch on. Currencies with unusual decimals need extra care: **HUF** and **TWD** (whole units on PayPal), **three-decimal currencies** such as BHD and KWD, and **ISK** and **UGX** (kept at two decimals, as Stripe expects). The amounts follow each provider's published rules, but only a sandbox payment proves your account accepts them.
- **Email and AI chat.** Send one real order email and one chat message with your own provider keys.
- **Languages.** The storefront, cart, checkout, payment result pages, customer messages and the seller dashboard are available in English, Bengali, Arabic, Spanish, French and Hindi (about 590 phrases per language). The five translations are AI-drafted: have a native speaker check them before you advertise them. The admin panel, the policy pages (privacy, terms, returns, shipping, FAQ, contact), e-mails and the offline page stay English.

---

## Limits to know before you launch

- **No currency sign.** Prices are shown as plain numbers. Online payments stay off until `CURRENCY_CODE` is set.
- **Refunds are manual.** Cancelling a paid order flags it `REFUND_DUE`. You send the money back yourself in your payment provider's dashboard.
- **Payouts are manual.** Seller earnings and payouts are recorded in the admin panel, but the app does not move money. You pay sellers yourself.
- **Translations.** The five translations are AI-drafted. The admin panel, policy pages, emails and the offline page are English only.

---

## Security Notes

- Admin credentials are never stored in plain text - only a bcrypt hash.
- All admin write operations require both an authenticated session **and**
  a CSRF token, issued via `/admin/csrf-token` after login.
- Login endpoints are rate-limited (5 attempts / 15 minutes for admin, 10 /
  15 minutes for customer auth) to resist brute-force attempts.
- Sessions are regenerated on login to prevent session fixation.
- An admin session stays valid for 1 hour of inactivity, refreshed on every
  admin action - no need to log in again just for browsing the store and
  coming back. Leaving it untouched for over an hour asks for the password
  again.
- Security headers are added with `helmet`.
- Payments are confirmed only after the gateway itself verifies them: the
  SSLCommerz redirect and IPN both call the validation API and check that the
  payment belongs to the order and covers its full amount.
- Order lists and customer details are never public. Customers see only their
  own orders after logging in, and real-time events carry no customer data.
- **Email verification:** a customer sees orders placed while logged in right
  away, but guest orders placed with their email address only after they click
  the link we email them (anyone can type any email when registering). "My
  Orders" is shown only to the signed-in owner and returns the items, status, totals, coupon code,
  payment method, delivery address, date and order reference; it never returns the phone number or a
  manual payment reference. Without email settings in `.env` no verification or password
  reset email is sent, and the links are not written to the server log.
- Stock is reserved with an atomic update when an order is placed, so the last
  unit cannot be sold twice. Orders that are never paid are cancelled
  `PENDING_ORDER_TTL_MINUTES` + 10 minutes after they were placed and their
  stock is released.
- **Stock and the admin panel:** cancelling an order that has not shipped
  returns its stock (once); cancelling a shipped or delivered order does not.
  Reopening a cancelled order takes the stock again, and is refused when there
  is not enough.
- **Paid after cancellation:** if a verified payment arrives for an order that
  was already cancelled, the customer is told to contact you, the order gets a
  red *Paid after cancellation* badge in the admin panel, and a line starting
  `[ACTION NEEDED]` is written to the server log. Set its status back to
  *Confirmed* to reopen it (stock is taken again) or refund the payment from
  your gateway.
- **Coupons** are checked and priced on the server only. Using one is a single
  conditional database update (all rules in the filter), and the cart box is
  rate limited. Coupon codes are escaped in pages and emails.
- **Cash on Delivery** orders are priced and checked on the server like all
  others (phone, address and `COD_MAX_AMOUNT` included), are rate limited with
  the other orders, and can only be marked as paid by a logged-in admin with a
  CSRF token and the `order.edit` permission.
- The chatbot endpoint has its own rate limit (10 messages per minute per IP), and each visitor address has a daily share of the shop-wide chat limit (`CHAT_DAILY_LIMIT_PER_IP`). Chat history is kept in server memory under a random `tl_chat` cookie, not in the session store.
- A customer or admin account refuses further logins for 15 minutes after 10 wrong passwords in 15 minutes, on top of the per-IP limit. The count lives in server memory, so a restart clears it, and someone who knows an account name can lock that account for a short while; resetting the password lifts the lock for a customer.
- One email address receives at most 5 order emails and 3 verification or reset links per hour, so a stranger's address typed at checkout cannot be flooded.
- Cash on Delivery checkouts have their own limit (`COD_ORDER_RATE_LIMIT_MAX`, default 5 per hour per address).
- Order creation is rate limited (20 accepted orders per 15 minutes per IP by default, `ORDER_RATE_LIMIT_MAX`),
  and an order is limited to 20 lines, 10 of one item per line, and bounded
  lengths for name, email, phone and address. This stops one visitor from
  tying up the stock with unpaid orders. Customer-supplied text is escaped in
  all emails.
- **Rate limits are per IP address.** Shoppers who share one IP (mobile carrier
  networks, offices, shared Wi-Fi) share the limits, e.g. 20 orders per 15
  minutes, 5 sign-ups per hour and 300 API calls per 15 minutes. `/api/payment/*`
  skips the global limit so payment callbacks are never dropped.
- **Reverse proxy:** if nginx or a load balancer sits in front and `TRUST_PROXY`
  is `0`, every visitor looks like the same IP and the whole site can lock
  itself out. The server prints a warning at start-up when this looks likely.
- Every order or stock event makes each open storefront reload the product
  list (400 ms debounced). The list is fetched in pages of 200 products, but the page
  loads every page again after each event. That is fine for a small catalogue; for a very large
  catalogue or heavy traffic, load only the visible category or page.
- Behind nginx or a hosting platform, set `TRUST_PROXY=1` (or the real
  number of proxies) so secure cookies and rate limits see the right client.
  The default is `0`, which is right when the app is exposed directly.
- Set `NODE_ENV=production` and a real `ALLOWED_ORIGIN` before deploying
  live - this locks down CORS and enables secure cookies. In production the
  server refuses to start unless `SESSION_SECRET` is set to a real random value
  of at least 32 characters (the placeholder from `.env.example` is rejected).
  Outside production a missing or weak secret gives a random per-run secret and
  a warning (everyone is logged out at each restart); there is no built-in secret.
- **Cross-site writes:** every state-changing request under `/api/users`,
  `/api/vendor` and the storefront's own writes (`POST /api/orders`, `/api/coupons/validate`,
  `/api/chat` and `/api/orders/:id/payment-reference`) is refused with 403 when its `Origin` is another site or the
  opaque `null`. Payment callbacks and webhooks are exempt (gateways call them
  from elsewhere). The admin API uses its own per-session CSRF token. Behind a
  proxy that rewrites the Host header, set `BASE_URL` or `ALLOWED_ORIGIN`.
- Product titles and shop names lose `<`, `>` and control characters; CSV import
  always drops a leading `=` or `@` (and leading spaces or tabs), and drops a leading `+` or `-` unless the
  rest is plain words and numbers (so "-20% Sale Tee" is kept), so a spreadsheet never runs a cell as a formula.
- Online payment needs a valid phone number and a full delivery address.
- The manual-payment reference route is rate limited (20 requests per 15 minutes per IP address). A reference is
  never refused, because anyone could copy a stranger's real reference to block that customer. When two orders carry
  the same reference, both are flagged *Same payment reference on another order* in the admin panel (for accounts that
  may see payment references). You check the transfer in your bank or wallet and confirm only the order it belongs to.
- Access logs blank every query value whose name looks secret (tokens, keys, codes, transaction ids). The password reset
  link puts its token after a `#`, which a browser never sends to the server. Changing or resetting a password logs the
  customer out of their other devices.
- Amounts follow the currency's own decimals (see *Currency*): whole units for JPY, KRW, VND and similar, three
  decimals for KWD, BHD and similar, two for everything else, in prices, totals and card amounts alike.

## Optional money rules

Three rules change who is paid what. All are **off** by default. Decide them with your sellers first.
With all three off, earnings follow the standard rules above: the payout hold (`PAYOUT_HOLD_DAYS`, 7 days by
default) applies, and a cancelled order never puts a shipped seller's goods back in the stock.

- `SELLER_KEEPS_SHIPPED_ON_CANCEL=true`: a seller who already shipped their part
  keeps that earning when the whole order is cancelled (shipped goods are never
  restocked, with or without this rule; only the other items are), and reopening the
  order leaves the kept part alone.
- `COUPON_SPLIT_PRO_RATA=true`: a coupon is shared across the sellers' items in
  proportion to their value (in whole minor units, remainder to the largest
  line). Commission and earnings are worked out on the price after the coupon,
  so a coupon larger than the commission is not refused.
- `MARKETPLACE_FUNDS_COUPONS=true`: the marketplace pays for the coupon, and the
  sellers' earnings are worked out on the full price. It wins if both are set.

A cancelled-then-reopened order that was already settled is reversed with a
generation number.

---

## Languages, first-run setup and demo mode

**Languages.** The Bengali, Arabic, Spanish, French and Hindi texts were drafted with the help of AI and have not been reviewed by native speakers. Have each language you sell in checked before you rely on it, especially the checkout, payment and policy wording. The picker is in the navbar. Files are in `public/locales/`. The page text is matched to keys by its English wording, so only text that has a key is translated; everything else stays English. Covered: navigation, shop, product cards, cart, checkout, form errors, order history, wishlist, reviews, payment result pages, server messages shown to customers and sellers (matched by their English text, with `{name}` placeholders for values), and the seller dashboard. Not covered: the admin panel, the policy pages, e-mails, the offline page, the example values in form fields, and anything sellers or customers type. Text with a value in it is written as `Only {n} left` in `en.json`; a translation may move the placeholder, and it must keep the same placeholders. Server messages are translated in the browser from their English wording, so a new message needs a new key. Names and titles that users enter are never translated. To add a language, copy `en.json`, translate the values, add it to `LANGS` in `public/js/i18n.js`, and to `RTL` if it reads right to left. Arabic loads Bootstrap's own right-to-left stylesheet (`bootstrap.rtl.min.css` 5.3.3, with its integrity hash) in place of the normal one. The translations are AI-drafted: have a native speaker review `bn.json`, `ar.json`, `es.json`, `fr.json` and `hi.json`, and look at each page in Arabic.

**First-run setup.** With no real admin in `.env` and none in the database, open `/setup`. It creates the owner account (username and password) and nothing else. Store name, currency and payment gateways are set in `.env`.

- `SETUP_TOKEN` (16 or more characters, entered on the page) is required, except for a plain local run. That means all of these: `NODE_ENV` is not `production`, `BASE_URL` is `localhost` or `127.0.0.1`, `TRUST_PROXY` is unset or 0, the request has no proxy headers, its `Host` is local, and it comes from the same machine. If `SETUP_TOKEN` is set it is always checked.
- `/setup` answers 404 once an admin exists, and `/setup.html` redirects to `/setup`.
- A half-finished `.env` admin keeps `/setup` closed. If `ADMIN_PASSWORD_HASH` is set but is not a clean bcrypt hash (quotes kept around it, or a hash cut short by Docker Compose), the server prints a warning at start. To recover, fix the value in `.env`, or run `npm run create-admin <username> <password> owner`. A missing hash or the template placeholder leaves `/setup` open.
- The `.env` template values (`ADMIN_USERNAME=admin` and the placeholder hash) never count as an admin and can never be used to log in.
- The owner is claimed with one database document (collection `setuplocks`, `_id` `owner`), so several server processes starting together create one owner. The loser gets 409. A claim older than five minutes is treated as left by a crashed process. If `/setup` keeps answering 409 and no admin exists, delete that document or use `npm run create-admin`.

**Demo mode.** Set `DEMO_MODE=true` to:

- refuse deletes, and changes to staff, roles, passwords and 2FA;
- refuse edits to vendors, vendor payouts and refund marks;
- send no email at all.

Products, coupons, reviews and order status stay editable, so reset the site regularly. Nothing resets by itself. Run `npm run demo:reset -- --yes` from cron, for example nightly. It removes all orders, coupons (and their redemptions), reviews, payouts and customer accounts, reseeds the store's and demo shops' products, and recreates the demo owner. Without `--yes` (or `CONFIRM=yes`) it only prints what it would remove. It refuses to run unless `DEMO_MODE=true`, `DEMO_ADMIN_PASSWORD` is set (no default) and `DB_NAME` contains `demo`. `DEMO_ALLOW_ANY_DB=true` skips the name check on a database you know is disposable. Shops that visitors applied for are not removed. The seed creates sample shops and products, but no seller or customer logins; only the demo owner can sign in. Use sandbox keys for every payment gateway on a demo site.

Environment variables: `SETUP_TOKEN`, `DEMO_MODE`, `DEMO_ADMIN_USER`, `DEMO_ADMIN_PASSWORD`, `DEMO_ALLOW_ANY_DB`, `CONFIRM`, `CREATE_ADMIN_PASSWORD` (set by the demo reset script; see `.env.example`).

---

## Customizing

### Rebranding in five minutes

1. `.env`: set `SITE_NAME` (page titles, link previews) and `SITE_DESCRIPTION`.
2. That is all for the name. The pages, the seller dashboard, the admin panel, the payment pages, e-mails and the
   chatbot all show `SITE_NAME`: `public/js/brand.js` reads it once from `/api/site-info` and fills in every element
   marked `data-brand`, `data-brand-text` or `data-brand-alt`. Without `SITE_NAME` the pages show the default name
   exactly as before. The default is set in one place, `FALLBACK` in `public/js/brand.js` (and `DEFAULT_SITE_NAME` in
   `services/seo.js` and `services/brand.js` for the server). To put the name into a page you add yourself, give the
   element a `data-brand` attribute (or `data-brand-text="Sell on {name}"`) and load `/js/brand.js` before your other
   scripts. The footer contact lines come from `.env`: set `SUPPORT_EMAIL`, `SUPPORT_PHONE` and `SUPPORT_ADDRESS`.
   Any line you leave empty is not shown, so the footer never displays placeholder text.
3. Colours: edit the variables at the top of `public/css/marketplace.css`
   (`--mk-ink`, `--mk-accent`, ...).
4. Logo and homepage picture: replace `public/img/logo.svg` and
   `public/img/hero.svg` (or edit and re-run `scripts/generate-brand-assets.js`),
   and replace `public/img/og-default.png`.

- **Change or add a payment gateway:** SSLCommerz and Stripe are integrated
  in `routes/api.js`; PayPal, Flutterwave and Mollie are in
  `services/intlGateways.js` (plain HTTPS calls, no extra packages). To add
  another gateway, copy the pattern of one of those three: create the payment,
  save its reference on the order, and confirm it only after asking the
  gateway what happened.
- **Change the chatbot's tone or scope:** edit `systemPrompt()` in
  `services/chatPolicy.js`.
- **Add product fields:** extend `models/Product.js`, then update the admin
  form in `public/js/admin.js` and the storefront rendering in
  `public/js/app.js`.

---

## Image Credits

All images in this package are original artwork created for it, so there are
no third-party photo licenses to worry about:

- `public/img/logo.svg` is the logo (navbar, chat button, admin panel, invoice)
  and `public/img/hero.svg` is the homepage hero picture.
- `public/img/products/` holds one illustration for each demo product in
  `seed/catalog.js`. They are drawn in code: run `node scripts/generate-clothing-images.js`
  to redraw them and `node scripts/generate-brand-assets.js` to redraw the logo and
  homepage artwork. `public/img/icon-192.png` and `icon-512.png` are the app icons (redraw them with
  `node scripts/generate-pwa-icons.js`). `public/img/og-default.png` is the link-preview picture shown
  when the site is shared; replace it with your own 1200x630 image.

They are demo artwork, drawn as simple vector illustrations. Before running a
live store, replace the logo and hero with your own branding (keep the same file
names, or edit the `<img>` tags in `public/index.html` and `public/admin.html`)
and add your own product photos. There are two ways:

1. **Upload in the admin panel** (PNG, JPG, WebP or GIF, up to 2 MB). By default
   the picture is saved as a file in `UPLOAD_DIR` (default `uploads/`) and served from `/uploads/`, so that
   folder must be writable and kept across restarts and deployments (see *Sizes and product pictures*).
   With `UPLOAD_STORAGE=database` it is stored in the database instead and served from
   `/api/products/<id>/image`, so no folder is needed.
2. **Put the files in a folder.** Copy them into `public/img/products/` and use
   an address like `/img/products/my-shirt.jpg` as the product's image (in the
   admin panel, or in `seed/seed.js` if you use the seed script). Photos placed
   directly in `public/img/` are not bundled by the project's own tests; keep
   them in `public/img/products/`.

SVG uploads are refused (an SVG can carry scripts); SVG files you ship in
`public/img/` are fine.

---

## License

See `LICENSE.txt` for the license terms that apply to your purchase
(Regular or Extended, per the license selected at checkout).

---

## Support

**How to get help:** use the support / comments section of the item page on the
marketplace you bought it from (this is the only support channel; please do not
send private messages with passwords or keys).

**What to include** so the problem can be reproduced quickly:

1. Whether you run it with Docker or directly, and on which operating system.
2. Your Node.js version (`node -v`) and MongoDB version (or Atlas).
3. The exact steps you took, what you expected, and what happened instead.
4. The error text from the terminal or the browser console (F12). **Remove any
   passwords, API keys and your `.env` contents first.**

**What support covers:** installing and starting the package as described in
this README, bugs in the code that ships, and questions about its settings.

**What it does not cover:** custom development or design changes, setting up
your own accounts with payment providers, email, or AI services, hosting and
server administration, and problems caused by changes you made to the code.

If you find a security problem, say so in the support request without posting
details publicly, and it will be handled first.
