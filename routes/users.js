const crypto = require('crypto');
const loginGuard = require('../services/loginGuard');
const mailBudget = require('../services/mailBudget');
const bcrypt = require('bcrypt');
const { passwordProblem } = require('../services/passwordRules');
const { endUserSessions } = require('../services/sessions');
const express = require('express');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Review = require('../models/Review');
const Vendor = require('../models/Vendor');
const reviews = require('../services/reviews');
const { publicProduct } = require('../services/images');
const marketplace = require('../services/marketplace');
const emailService = require('../services/emailService');
const sameOrigin = require('../middleware/sameOrigin');

const router = express.Router();
// Writes must come from this site (see middleware/sameOrigin.js).
router.use(sameOrigin);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  skipSuccessfulRequests: true,
  message: { message: 'Too many attempts. Try again in 15 minutes.' }
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { message: 'Too many registrations from this IP. Try again in an hour.' }
});

const resendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { message: 'Too many verification emails requested. Try again later.' }
});

const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { message: 'Too many password reset requests. Try again later.' }
});

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const VERIFY_LINK_HOURS = 24;
const RESET_LINK_MINUTES = 60;

// Dummy hash compared when the email is unknown, so timing does not reveal whether an account exists.
const DUMMY_HASH = '$2b$12$mpuh95Eu2lEJLvPDS8Pg.ufNVoB.gZDs.BZ2t3PEFifLkckLBpFmy';

// The emailed token is random and only its SHA-256 hash is stored, so a copy of the database
// cannot be used to verify accounts.
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function newVerificationToken() {
  const token = crypto.randomBytes(32).toString('hex');
  return {
    token,
    verifyTokenHash: sha256(token),
    verifyTokenExpires: new Date(Date.now() + VERIFY_LINK_HOURS * 60 * 60 * 1000)
  };
}

// Resolves to true if the email was sent.
async function sendVerificationLink(user, token) {
  const link = `${BASE_URL}/api/users/verify-email?token=${token}`;
  return emailService.sendVerificationEmail(user, link);
}

function requireUserAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ message: 'Please log in to continue.' });
}

router.post('/register', registerLimiter, async (req, res) => {
  try {
    const { name, email, password } = req.body || {};

    if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string' ||
        !name.trim() || !email.trim() || !password) {
      return res.status(400).json({ message: 'Name, email, and password are required.' });
    }

    const weak = passwordProblem(password);
    if (weak) return res.status(400).json({ message: weak });

    const existing = await User.findOne({ email: email.toLowerCase().trim() });
    if (existing) {
      // Registration has to say the address is taken, which leaks that an account exists; the limiter curbs bulk probing.
      return res.status(400).json({ message: 'An account with that email already exists.' });
    }

    const verification = newVerificationToken();
    const user = await User.create({
      name: name.trim(), email, password,
      verifyTokenHash: verification.verifyTokenHash,
      verifyTokenExpires: verification.verifyTokenExpires
    });

    // Log in right away. The session id is regenerated first (as at login) so a planted id is useless.
    await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
    req.session.userId = user._id;
    req.session.userName = user.name;

    // A failed email must not fail the registration.
    let verificationEmailSent = false;
    try {
      verificationEmailSent = await sendVerificationLink(user, verification.token);
    } catch (mailErr) {
      console.error('Verification email error:', mailErr.message);
    }

    res.status(201).json({
      message: 'Account created successfully.',
      verificationEmailSent,
      user: { id: user._id, name: user.name, email: user.email, emailVerified: false }
    });
  } catch (err) {
    console.error('Registration error:', err);
    if (err.code === 11000) {
      return res.status(400).json({ message: 'An account with that email already exists.' });
    }
    if (err.name === 'ValidationError') {
      return res.status(400).json({ message: Object.values(err.errors).map(e => e.message).join(', ') });
    }
    res.status(500).json({ message: 'Registration failed. Please try again.' });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return res.status(400).json({ message: 'Email and password are required.' });
    }

    // Too many wrong passwords for this account: refuse for a while, whatever the password is.
    const wait = loginGuard.lockedFor('user', email);
    if (wait) {
      res.set('Retry-After', String(wait));
      return res.status(429).json({ message: 'Too many failed attempts for this account. Try again in a few minutes, or reset your password.' });
    }

    // password is hidden by default, so select it explicitly.
    const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+password');

    // Always compare a password so timing does not reveal whether the email exists.
    let passwordMatch = false;
    if (user) passwordMatch = await user.comparePassword(password);
    else await bcrypt.compare(password, DUMMY_HASH);

    if (!user || !passwordMatch) {
      loginGuard.recordFailure('user', email);
      return res.status(401).json({ message: 'Invalid email or password.' });
    }
    loginGuard.recordSuccess('user', email);

    // Regenerate the session id to prevent fixation.
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ message: 'Login failed. Try again.' });
      req.session.userId = user._id;
      req.session.userName = user.name;
      res.json({
        message: 'Login successful.',
        user: { id: user._id, name: user.name, email: user.email, emailVerified: !!user.emailVerified }
      });
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Login failed. Please try again.' });
  }
});

router.post('/logout', requireUserAuth, (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ message: 'Logout failed.' });
    res.clearCookie('connect.sid');
    res.json({ message: 'Logged out successfully.' });
  });
});

router.get('/me', requireUserAuth, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(404).json({ message: 'User not found.' });
    res.json({ id: user._id, name: user.name, email: user.email, emailVerified: !!user.emailVerified });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch profile.' });
  }
});

// Opening the emailed link changes nothing: it hands the token to the storefront in the URL fragment
// (never sent to a server or logged), and the page then confirms it with POST /verify-email.
router.get('/verify-email', (req, res) => {
  const token = req.query.token;
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return res.redirect(`${BASE_URL}/?emailVerified=0`);
  res.redirect(`${BASE_URL}/#verifyToken=${token}`);
});

router.post('/verify-email', async (req, res) => {
  try {
    const token = (req.body || {}).token;
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) {
      return res.status(400).json({ message: 'That verification link is invalid or has expired.' });
    }
    const user = await User.findOneAndUpdate(
      { verifyTokenHash: sha256(token), verifyTokenExpires: { $gt: new Date() } },
      { $set: { emailVerified: true }, $unset: { verifyTokenHash: 1, verifyTokenExpires: 1 } }
    );
    if (!user) return res.status(400).json({ message: 'That verification link is invalid or has expired.' });
    res.json({ message: 'Email verified.' });
  } catch (err) {
    console.error('Email verification error:', err);
    res.status(500).json({ message: 'Failed to verify email.' });
  }
});

// Emails a one-hour, single-use link. Only the SHA-256 of the token is stored.
router.post('/forgot-password', forgotLimiter, async (req, res) => {
  const generic = { message: 'If an account exists for that email, we have sent a link to reset the password.' };
  try {
    const email = (req.body || {}).email;
    if (typeof email !== 'string' || !email.trim() || email.length > 254) return res.json(generic);
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    // Over the hourly cap: the links already sent stay valid, and no new token replaces them.
    if (user && mailBudget.wouldAllow('link', user.email)) {
      const token = crypto.randomBytes(32).toString('hex');
      await User.updateOne({ _id: user._id }, {
        $set: { resetTokenHash: sha256(token), resetTokenExpires: new Date(Date.now() + RESET_LINK_MINUTES * 60 * 1000) }
      });
      await emailService.sendPasswordResetEmail(user, `${BASE_URL}/#resetToken=${token}`);
    }
    res.json(generic);
  } catch (err) {
    console.error('Forgot password error:', err);
    res.json(generic);   // failures are not revealed either
  }
});

router.post('/reset-password', authLimiter, async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
      return res.status(400).json({ message: 'This reset link is not valid. Ask for a new one.' });
    }
    const weak = passwordProblem(password);
    if (weak) return res.status(400).json({ message: weak });

    // Consumed atomically: a second use finds nothing.
    const tokenHash = sha256(token);
    const user = await User.findOneAndUpdate(
      { resetTokenHash: tokenHash, resetTokenExpires: { $gt: new Date() } },
      { $unset: { resetTokenHash: 1, resetTokenExpires: 1 } },
      { returnDocument: 'after' }
    ).select('+password');
    if (!user) return res.status(400).json({ message: 'This reset link has expired or was already used. Ask for a new one.' });

    user.password = password;       // hashed by the model before saving
    user.emailVerified = true;      // the link reached the mailbox, which proves the address is theirs
    try {
      await user.save();
    } catch (saveErr) {
      // The password was not saved, so the link has to keep working for another try. It was valid
      // for at most an hour; it gets a fresh short window back.
      const restoredExpiry = new Date(Date.now() + 15 * 60 * 1000);
      await User.updateOne({ _id: user._id }, { $set: { resetTokenHash: tokenHash, resetTokenExpires: restoredExpiry } }).catch(() => {});
      throw saveErr;
    }
    loginGuard.recordSuccess('user', user.email);        // a reset also lifts a lock from failed attempts
    await endUserSessions(req.sessionStore, user._id);   // a stolen session must not survive the reset
    res.json({ message: 'Your password has been changed. You can log in now.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ message: 'Could not reset the password.' });
  }
});

router.post('/change-password', authLimiter, requireUserAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== 'string' || !currentPassword) {
      return res.status(400).json({ message: 'Enter your current password.' });
    }
    const weak = passwordProblem(newPassword);
    if (weak) return res.status(400).json({ message: weak });
    const user = await User.findById(req.session.userId).select('+password');
    if (!user) return res.status(404).json({ message: 'User not found.' });
    if (!(await user.comparePassword(currentPassword))) {
      return res.status(401).json({ message: 'Your current password is not correct.' });
    }
    user.password = newPassword;
    await user.save();
    await endUserSessions(req.sessionStore, user._id, req.sessionID);   // other devices are logged out, this one stays
    res.json({ message: 'Password changed.' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ message: 'Could not change the password.' });
  }
});

router.post('/resend-verification', resendLimiter, requireUserAuth, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(404).json({ message: 'User not found.' });
    if (user.emailVerified) return res.json({ message: 'Your email is already verified.', emailVerified: true });

    if (!mailBudget.wouldAllow('link', user.email)) {
      return res.json({ message: 'We already sent several verification emails to this address. Please check your inbox (and spam folder), or try again in an hour.', sent: false });
    }

    const verification = newVerificationToken();
    await User.updateOne(
      { _id: user._id },
      { $set: { verifyTokenHash: verification.verifyTokenHash, verifyTokenExpires: verification.verifyTokenExpires } }
    );
    const sent = await sendVerificationLink(user, verification.token);
    res.json({
      message: sent
        ? 'Verification email sent. Please check your inbox.'
        : 'We could not send the email right now. Please try again later.',
      sent
    });
  } catch (err) {
    console.error('Resend verification error:', err);
    res.status(500).json({ message: 'Could not send the verification email.' });
  }
});

// Paginated history: orders placed while logged in, plus guest orders on the account's email once
// verified.
const MY_ORDER_FIELDS = 'items status totalAmount subtotalAmount discountAmount couponCode paymentGateway deliveryAddress createdAt transactionId';

router.get('/my-orders', requireUserAuth, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
    const skip = (page - 1) * limit;

    const conditions = [{ userId: user._id }];
    if (user.emailVerified) conditions.push({ customerEmail: user.email });
    const filter = { $or: conditions };

    const [orders, total] = await Promise.all([
      Order.find(filter, MY_ORDER_FIELDS).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Order.countDocuments(filter)
    ]);

    res.json({
      orders,
      emailVerified: !!user.emailVerified,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (err) {
    console.error('Error fetching user orders:', err);
    res.status(500).json({ message: 'Failed to fetch orders.' });
  }
});

// One review per product, and only after an order containing it was delivered.
const reviewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30,
  message: { message: 'Too many reviews. Please wait a few minutes.' }
});

// Body: { rating: 1-5, text?: string }
router.post('/products/:id/reviews', requireUserAuth, reviewLimiter, async (req, res) => {
  try {
    if (!/^[0-9a-fA-F]{24}$/.test(req.params.id)) return res.status(400).json({ message: 'Invalid product.' });
    const checked = reviews.cleanReview(req.body);
    if (!checked.ok) return res.status(400).json({ message: checked.message });

    const user = await User.findById(req.session.userId);
    if (!user) return res.status(404).json({ message: 'User not found.' });
    const product = await Product.findById(req.params.id).select('_id vendorId');
    if (!product) return res.status(404).json({ message: 'Product not found.' });
    const shop = product.vendorId && !reviews.isOwnProduct(user, product)
      ? await Vendor.findById(product.vendorId).select('ownerUserId').lean() : null;
    if (reviews.isOwnProduct(user, product, shop)) return res.status(403).json({ message: 'You cannot review your own product.' });
    if (!(await reviews.hasReceived(user, product._id, user.vendorId))) {
      return res.status(403).json({ message: 'You can review a product after an order with it has been delivered.' });
    }

    try {
      await Review.create({
        productId: product._id, userId: user._id, authorName: reviews.displayName(user),
        rating: checked.rating, text: checked.text
      });
    } catch (err) {
      if (err && err.code === 11000) return res.status(409).json({ message: 'You have already reviewed this product.' });
      throw err;
    }
    const summary = await reviews.refreshRating(product._id);
    res.status(201).json({ message: 'Thank you for your review!', ...summary });
  } catch (err) {
    console.error('Error saving review:', err.message);
    res.status(500).json({ message: 'Could not save your review.' });
  }
});

// Ids of the products this customer has already reviewed.
router.get('/my-reviews', requireUserAuth, async (req, res) => {
  try {
    const mine = await Review.find({ userId: req.session.userId }).select('productId').limit(500).lean();
    res.json({ productIds: mine.map((r) => String(r.productId)) });
  } catch (err) {
    console.error('Error fetching reviews:', err.message);
    res.status(500).json({ message: 'Failed to fetch reviews.' });
  }
});

// Guests keep their wishlist in the browser (see public/js/app.js) and it is merged on login.
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const MAX_WISHLIST = 200;

// Saved products that still exist.
router.get('/wishlist', requireUserAuth, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(404).json({ message: 'User not found.' });
    const ids = (user.wishlist || []).map(String);
    const found = ids.length ? await Product.find({ _id: { $in: ids } }) : [];
    const products = (await marketplace.visibleProducts(found)).map(({ product }) => product);
    res.json({ ids: products.map((p) => String(p._id)), products: products.map(publicProduct) });
  } catch (err) {
    console.error('Wishlist load error:', err);
    res.status(500).json({ message: 'Could not load your wishlist.' });
  }
});

// Body: { productId }
router.post('/wishlist', requireUserAuth, async (req, res) => {
  try {
    const productId = (req.body || {}).productId;
    if (typeof productId !== 'string' || !OBJECT_ID.test(productId)) {
      return res.status(400).json({ message: 'Invalid product.' });
    }
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(404).json({ message: 'User not found.' });
    const current = (user.wishlist || []).map(String);
    if (!current.includes(productId.toLowerCase())) {
      if (current.length >= MAX_WISHLIST) {
        return res.status(400).json({ message: `Your wishlist can hold at most ${MAX_WISHLIST} products.` });
      }
      const exists = await Product.exists({ _id: productId });
      if (!exists) return res.status(404).json({ message: 'That product is no longer available.' });
      await User.updateOne({ _id: user._id }, { $addToSet: { wishlist: productId } });
    }
    res.json({ saved: true, productId });
  } catch (err) {
    console.error('Wishlist add error:', err);
    res.status(500).json({ message: 'Could not save to your wishlist.' });
  }
});

router.delete('/wishlist/:productId', requireUserAuth, async (req, res) => {
  try {
    const { productId } = req.params;
    if (!OBJECT_ID.test(productId)) return res.status(400).json({ message: 'Invalid product.' });
    await User.updateOne({ _id: req.session.userId }, { $pull: { wishlist: productId } });
    res.json({ saved: false, productId });
  } catch (err) {
    console.error('Wishlist remove error:', err);
    res.status(500).json({ message: 'Could not update your wishlist.' });
  }
});

// Body: { ids: [...] }
// Called once after login to add the guest wishlist. Unknown products are ignored; the 200-product limit applies.
router.post('/wishlist/merge', requireUserAuth, async (req, res) => {
  try {
    const raw = (req.body || {}).ids;
    if (!Array.isArray(raw)) return res.status(400).json({ message: 'ids must be a list.' });
    const wanted = [...new Set(raw
      .filter((id) => typeof id === 'string' && OBJECT_ID.test(id))
      .map((id) => id.toLowerCase()))].slice(0, MAX_WISHLIST);

    const user = await User.findById(req.session.userId);
    if (!user) return res.status(404).json({ message: 'User not found.' });
    const current = (user.wishlist || []).map(String);
    const fresh = wanted.filter((id) => !current.includes(id));

    let added = [];
    if (fresh.length && current.length < MAX_WISHLIST) {
      const found = await Product.find({ _id: { $in: fresh } }).select('_id').lean();
      added = found.map((p) => String(p._id)).slice(0, MAX_WISHLIST - current.length);
      if (added.length) await User.updateOne({ _id: user._id }, { $addToSet: { wishlist: { $each: added } } });
    }
    res.json({ ids: [...current, ...added] });
  } catch (err) {
    console.error('Wishlist merge error:', err);
    res.status(500).json({ message: 'Could not update your wishlist.' });
  }
});

module.exports = router;
