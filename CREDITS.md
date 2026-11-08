# Credits and third-party licenses

Product: Threadly - Real-Time E-Commerce Platform with AI Chatbot

A real-time, self-hosted e-commerce platform and multi-vendor clothing marketplace with an AI chatbot, built with Node.js, Express and MongoDB.

This file lists everything in the package that was not written for it, and
the license it comes with. Nothing here needs attribution on your website;
it is listed so you know exactly what you are redistributing.

## Artwork and text (original)

- **Product pictures** (`public/img/products/*.svg`), **logo**
  (`public/img/logo.svg`), **homepage picture** (`public/img/hero.svg`), **app icons**
  (`public/img/icon-192.png`, `public/img/icon-512.png`) and **share image**
  (`public/img/og-default.png`) are original work, drawn in code by
  `scripts/generate-clothing-images.js`, `scripts/generate-brand-assets.js`,
  `scripts/generate-pwa-icons.js` and `scripts/generate-store-assets.js` (the share image is
  the PNG export of the picture that last script draws). They contain no stock photos, no
  third-party artwork and no real brands. You can replace them freely.
- The demo shops, product names and descriptions in `seed/catalog.js` are
  invented sample content. Any resemblance to real shops is accidental.
- **Fonts:** no text fonts are bundled or downloaded. The site uses the visitor's own
  system fonts (a serif stack for headings, the system sans-serif for text). The only font
  file that is loaded is the icon font of Bootstrap Icons, from the CDN (see below).
- "Threadly" is a **placeholder brand name** used for this package. Choose your
  own name (see README, "Rebranding in five minutes"). Check that the name is
  free to use (trademark and domain search) before you launch.

## Browser libraries (loaded from a CDN, pinned to an exact version with integrity hashes)

| Library | Version | License | Used for |
|---|---|---|---|
| Bootstrap | 5.3.3 | MIT | Layout and components |
| Bootstrap Icons | 1.11.3 | MIT | Icons |
| jQuery | 3.7.1 | MIT | Storefront and admin scripts |
| Socket.IO client | 4.x (served by the `socket.io` package at `/socket.io/`) | MIT | Live stock updates |

## Server packages (installed with `npm install`)

| Package | License |
|---|---|
| bcrypt | MIT |
| connect-mongo | MIT |
| cors | MIT |
| dotenv | BSD-2-Clause |
| express | MIT |
| express-rate-limit | MIT |
| express-session | MIT |
| helmet | MIT |
| mongoose | MIT |
| morgan | MIT |
| nodemailer | MIT-0 |
| socket.io | MIT |
| sslcommerz-lts | ISC |
| stripe | MIT |
| supertest (development only) | MIT |
| bootstrap (development only, used by a test that checks the integrity hashes) | MIT |

Each package's full license text is in its own folder under `node_modules/`
after you install. The exact versions are fixed in `package-lock.json`.

## Services (not included; you use your own accounts)

Every outside service the item can connect to needs your own account, under that
service's own terms of service. They are reached over HTTPS with **your** keys,
and their names and logos belong to their owners. The services are:

- Payment gateways: SSLCommerz, Stripe, PayPal, Flutterwave and Mollie.
- E-mail: an SMTP provider of your choice.
- AI chatbot: Google Gemini, OpenAI, Anthropic, or any OpenAI-compatible service.

Node.js and MongoDB are required software and are not included.
