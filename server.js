require('dotenv').config({ quiet: true });
const path = require('path');
const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const { redactUrl } = require('./services/logRedact');
const { ensureUploadDir, uploadDir, storageMode, sweepOrphanUploads, UPLOAD_FILE } = require('./services/uploads');
const { fixPaymentReferenceIndex } = require('./services/paymentReference');
const { corsOrigin } = require('./services/origins');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const connectDB = require('./config/db');
const Order = require('./models/Order');
const { startPendingOrderCleanup } = require('./services/orderService');
const { sessionSecretProblem } = require('./config/sessionSecret');
const { adminEnvWarning } = require('./services/adminEnv');
const { isEmailConfigured } = require('./services/emailService');
const { chatConfig } = require('./services/llm/config');
const { dailyLimitWarning } = require('./services/chatPolicy');
const apiRoutes = require('./routes/api');
const { router: setupRoutes, setupNeeded } = require('./routes/setup');
const demoMode = require('./middleware/demoMode');
const adminRoutes = require('./routes/admin');
const seoRoutes = require('./routes/seo');
const { isNoindexPath } = require('./services/seo');
const userRoutes = require('./routes/users');
const { vendorRouter, shopsRouter } = require('./routes/vendor');

const app = express();
const server = http.createServer(app);

const isProduction = process.env.NODE_ENV === 'production';

// Refuse to start in production without a real session secret.
const secretProblem = sessionSecretProblem(process.env.SESSION_SECRET);
if (isProduction && secretProblem) {
  console.error(
    `SESSION_SECRET ${secretProblem}. Refusing to start in production.\n` +
    'Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n' +
    'and put it in .env as SESSION_SECRET=...'
  );
  process.exit(1);
}

// Behind a reverse proxy the app must trust X-Forwarded-* headers, or secure cookies and per-IP
// rate limits fail.
const trustProxyRaw = process.env.TRUST_PROXY;
const trustProxyHops = trustProxyRaw !== undefined && trustProxyRaw !== '' ? Number(trustProxyRaw) : 0;
if (Number.isInteger(trustProxyHops) && trustProxyHops > 0) {
  app.set('trust proxy', trustProxyHops);
}
else {
  // Not trusting a proxy, yet a request arrives with X-Forwarded-For: a reverse
  // proxy is probably in front. Every visitor would then share the proxy's IP
  // and the per-IP rate limits could lock the whole site out. Warn once.
  let warnedProxy = false;
  app.use((req, res, next) => {
    if (!warnedProxy && req.headers['x-forwarded-for'] && process.env.NODE_ENV !== 'test') {
      warnedProxy = true;
      console.warn(
        'WARNING: requests carry X-Forwarded-For but TRUST_PROXY is 0. Behind nginx or a ' +
        'load balancer, set TRUST_PROXY=1 (or the real number of proxies), or all visitors ' +
        'will share one IP and one rate limit.'
      );
    }
    next();
  });
}

// Security headers with a Content-Security-Policy: scripts only from this site, cdn.jsdelivr.net
// and code.jquery.com (CDN files carry integrity hashes), no framing, no cross-site form posts, no
// plugins.
function websocketOrigin() {
  try {
    const u = new URL(process.env.BASE_URL || '');
    return `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}`;
  } catch (e) {
    return null;
  }
}
const cspDisabled = String(process.env.CSP_DISABLED || '').trim().toLowerCase() === 'true';
app.use(helmet({
  contentSecurityPolicy: cspDisabled ? false : {
    useDefaults: false,
    directives: {
      'default-src':     ["'self'"],
      'script-src':      ["'self'", 'https://cdn.jsdelivr.net', 'https://code.jquery.com'],
      'style-src':       ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      'font-src':        ["'self'", 'https://cdn.jsdelivr.net', 'data:'],
      'img-src':         ["'self'", 'data:', 'https:'],
      'connect-src':     ["'self'", ...(websocketOrigin() ? [websocketOrigin()] : [])],
      'object-src':      ["'none'"],
      'base-uri':        ["'self'"],
      'form-action':     ["'self'"],
      'frame-ancestors': ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: isProduction
}));

// Admin pages and the admin API must never show up in search results.
app.use((req, res, next) => {
  if (isNoindexPath(req.path)) res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

const io = new Server(server, {
  cors: {
    origin: corsOrigin(isProduction, process.env.ALLOWED_ORIGIN),
    methods: ['GET', 'POST']
  }
});

app.use(cors({
  origin: corsOrigin(isProduction, process.env.ALLOWED_ORIGIN),
  credentials: true
}));

// Stripe webhook goes before express.json() because it needs the raw body.
// Responds 400 unless STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set.
app.post('/api/payment/stripe-webhook', apiRoutes.paymentCallbackLimiter, express.raw({ type: 'application/json' }), apiRoutes.stripeWebhookHandler);

morgan.token('safe-url', (req) => redactUrl(req.originalUrl || req.url));
app.use(morgan(':method :safe-url :status :response-time ms - :res[content-length]'));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
// Express 5 leaves req.body undefined when a request has no body; routes
// read fields from it, so give them an empty object (they answer 400, not 500).
app.use((req, res, next) => {
  if (req.body === undefined || req.body === null) req.body = {};
  next();
});

// Outside production a missing or weak secret is replaced by a random one (logins end on restart);
// production refuses to start.
let sessionSecret = process.env.SESSION_SECRET;
if (secretProblem && !isProduction) {
  sessionSecret = require('crypto').randomBytes(32).toString('hex');
  if (process.env.NODE_ENV !== 'test') {
    console.warn(`WARNING: SESSION_SECRET ${secretProblem}. Using a random secret for this run only: everyone is logged out when the server restarts. Set a real SESSION_SECRET in .env before deploying.`);
  }
}

// Secure cookies are only sent over HTTPS. In production that is the right
// default, but a production server reached over plain HTTP (a test deployment, an
// IP address) would silently drop every login, so COOKIE_SECURE can override it.
const cookieSecureEnv = String(process.env.COOKIE_SECURE || '').trim().toLowerCase();
const cookieSecure = cookieSecureEnv === 'true' ? true : cookieSecureEnv === 'false' ? false : isProduction;
if (isProduction && !cookieSecure) {
  console.warn('COOKIE_SECURE=false: session cookies are sent over plain HTTP. Use HTTPS in production.');
}

app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  // NODE_ENV=test uses the default in-memory store so the test suite needs no database.
  store: process.env.NODE_ENV === 'test' ? undefined : MongoStore.create({
    mongoUrl:       process.env.MONGODB_URI || 'mongodb://localhost:27017',
    dbName:         process.env.DB_NAME || 'ecommerce',
    collectionName: 'sessions',
    ttl:            24 * 60 * 60
  }),
  cookie: {
    secure:   cookieSecure,
    httpOnly: true,
    // 'lax' (not 'strict') so the session cookie is sent when the customer arrives
    // from the emailed verification link; cross-site POSTs still don't carry it.
    sameSite: 'lax',
    maxAge:   24 * 60 * 60 * 1000
  }
}));

// Applied to /api and /admin only, so static pages and assets are never limited. Login and chat
// have their own, stricter limiters. API_RATE_LIMIT_MAX raises or lowers it (default 300 requests per
// IP address per 15 minutes); raise it when many of your customers share one address.
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Math.min(10000, Math.max(30, parseInt(process.env.API_RATE_LIMIT_MAX, 10) || 300)),
  standardHeaders: true,
  legacyHeaders: false,
  // Payment gateways call these themselves (server to server or via the
  // customer's browser); throttling them could drop a real payment.
  skip: (req) => req.path.startsWith('/payment/'),
  message: { message: 'Too many requests, please try again later.' }
});

// SEO pages (home with meta tags, robots.txt, sitemap.xml, /product/:id). Mounted before the static
// files so "/" gets its meta tags instead of the plain file.
app.use(seoRoutes);

// Uploaded product pictures (UPLOAD_DIR, see services/uploads.js). Only files with the names this app makes (32 hex characters + a picture extension) are served,
// as plain pictures.
app.use('/uploads', (req, res, next) => (UPLOAD_FILE.test(req.path.slice(1)) ? next() : res.status(404).end()),
  express.static(uploadDir(), {
    index: false, dotfiles: 'ignore', maxAge: '30d', immutable: true,
    setHeaders: (res) => {
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    }
  }));

// setup.html is served only by the /setup route below.
app.get('/setup.html', (req, res) => res.redirect('/setup'));
// Pictures change rarely: browsers may keep them for a week.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/[\\/]img[\\/][^\\/]+\.(png|jpe?g|webp|svg|gif)$/i.test(filePath) && !/logo\.svg$/i.test(filePath)) res.set('Cache-Control', 'public, max-age=604800');
    else res.set('Cache-Control', 'no-cache');
  }
}));

// /api/users is mounted under /api, so the one limiter below counts each of its requests once.
app.use('/api', globalLimiter);
app.use(['/admin', '/api/vendor'], demoMode);
app.use('/api/setup', setupRoutes);
app.get('/setup', async (req, res) => {
  try { if (await setupNeeded()) return res.sendFile(path.join(__dirname, 'public', 'setup.html')); } catch (e) { /* fall through */ }
  return res.redirect('/');
});
app.use('/api/users', userRoutes);
app.use('/api/shops', shopsRouter);
app.use('/api/vendor', vendorRouter);
app.use('/api', apiRoutes);
app.use('/admin', globalLimiter, adminRoutes);

io.on('connection', (socket) => {
  socket.on('disconnect', () => {});
});

app.set('io', io);

// Client errors (bad JSON, body too large) keep their 4xx status and a plain message; other errors
// are logged only.
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 400 && status < 500) {
    const message = err.type === 'entity.parse.failed' ? 'The request body is not valid JSON.'
      : err.type === 'entity.too.large' ? 'The request is too large.'
      : 'Bad request.';
    return res.status(status).json({ message });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ message: isProduction ? 'Internal server error' : 'Internal server error (see the server log).' });
});

// An order must not store clientRequestId: null: the unique index on that field treats all nulls as
// the same value, so only one such order could exist. Remove any null value that is already stored.
async function cleanLegacyOrderData() {
  try {
    const r = await Order.updateMany({ clientRequestId: null }, { $unset: { clientRequestId: 1 } });
    if (r && r.modifiedCount) console.log(`Cleaned clientRequestId on ${r.modifiedCount} older orders.`);
  } catch (err) {
    console.error('Could not clean older order data:', err.message);
  }
}

const PORT = process.env.PORT || 3000;

// Only listen when run directly; the tests import the app without booting it.
if (require.main === module) {
  // Online payment needs a machine-readable currency code (CURRENCY_CODE). If the card currency
  // differs from it, a rate (CARD_RATE) is needed too.
  const pay = require('./services/paymentConfig');
  const rateProblem = pay.cardRateProblem();
  if (rateProblem) {
    if (isProduction) {
      console.error(`Refusing to start in production: ${rateProblem}.`);
      process.exit(1);
    }
    console.warn(`CARD_RATE: ${rateProblem}. A rate of 1 is used for development.`);
  }
  const wantsOnlinePay = ['SSLCOMMERZ_STORE_ID', 'STRIPE_SECRET_KEY', 'PAYPAL_CLIENT_ID', 'FLUTTERWAVE_SECRET_KEY', 'MOLLIE_API_KEY']
    .some((k) => pay.isRealValue(process.env[k]));
  if (wantsOnlinePay && !pay.currencyCode()) {
    console.warn('CURRENCY_CODE is not set (a 3-letter ISO code such as in your gateway account). Online payment methods stay switched off until it is.');
  }
  // The session store opens its own connection. When MongoDB cannot be reached that failure used to
  // end the process with a raw stack trace; one clear line is more useful. Anything else is
  // thrown again, which ends the process exactly as before.
  process.on('unhandledRejection', (err) => {
    const mongoDown = err && (/^Mongo/.test(String(err.name)) || ['ECONNREFUSED', 'ENOTFOUND'].includes(err.code));
    if (!mongoDown) throw err;
    console.error(`Cannot reach MongoDB (${err.message}). Check MONGODB_URI in .env and that the database is running.`);
    process.exit(1);
  });
  connectDB()
    .then(async () => {
      await cleanLegacyOrderData();
      await fixPaymentReferenceIndex(Order);
      startPendingOrderCleanup(io);
      // Pictures uploaded in a product form that was never saved are removed after a day.
      const sweepUploads = () => sweepOrphanUploads().catch((err) => console.error('Upload clean-up failed:', err.message));
      setTimeout(sweepUploads, 60 * 1000).unref();
      setInterval(sweepUploads, 6 * 60 * 60 * 1000).unref();
      server.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
        console.log(`Mode: ${isProduction ? 'production' : 'development'}`);
        if (storageMode() === 'disk') {
          if (ensureUploadDir()) console.log(`Uploaded pictures are kept in ${uploadDir()} (back this folder up; on hosting without a persistent disk set UPLOAD_STORAGE=database).`);
        } else {
          console.log('Uploaded pictures are kept in the database (UPLOAD_STORAGE=database). Only one picture per product is possible.');
        }
        if (!isEmailConfigured()) {
          console.warn('Email is not configured (set real values for EMAIL_HOST, EMAIL_USER, EMAIL_PASS; the example values do not count). Order, verification and password reset emails are skipped, so customers cannot verify their address or see their guest orders.');
        }
        // Payment gateways send customers back to BASE_URL, and the sitemap and social links use it.
        if (isProduction) {
          const base = String(process.env.BASE_URL || '').trim();
          if (!base || /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(base)) {
            console.warn('BASE_URL is not set to your public address (for example https://shop.example.com). Payment gateways would send customers back to localhost, and the sitemap and social links would be wrong.');
          }
        }
        // A buyer who set a chatbot key but got a setting wrong would otherwise see a chat bubble
        // that never appears.
        const chat = chatConfig();
        const chatIntent = ['CHAT_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CHAT_PROVIDER', 'CHAT_MODEL', 'CHAT_BASE_URL']
          .some((k) => String(process.env[k] || '').trim() !== '');
        if (!chat.enabled && chatIntent && process.env.CHAT_ENABLED !== 'false') {
          console.warn(`The AI chatbot is switched off: ${chat.reason} The chat bubble stays hidden until this is fixed (check with: node scripts/chat-check.js).`);
        }
        const limitWarning = dailyLimitWarning(process.env, chat);
        if (limitWarning) console.warn(limitWarning);
        const adminWarning = adminEnvWarning(process.env);
        if (adminWarning) console.warn(adminWarning);
      });
    })
    .catch((err) => {
      console.error('Failed to connect to MongoDB:', err.message);
      process.exit(1);
    });
}

module.exports = { app, server };
