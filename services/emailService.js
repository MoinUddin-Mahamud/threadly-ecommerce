const nodemailer = require('nodemailer');

// The sample values from .env.example (smtp.example.com, your-email@example.com,
// your-email-app-password) and obvious variants of them. Only whole values count,
// so a real address such as your-shop@gmail.com is never mistaken for a placeholder.
const { toMinor, fromMinor, fixedAmount } = require('./money');
const { brandName } = require('./brand');
const mailBudget = require('./mailBudget');
const PLACEHOLDER_HOST = /(^|\.)example\.(com|org|net)$/i;
const PLACEHOLDER_USER = /@example\.(com|org|net)$/i;
const PLACEHOLDER_PASS = /^(your[-_ ](email[-_ ])?(app[-_ ])?password|replace[-_ ]?me|change[-_ ]?me)$/i;

// True only when EMAIL_HOST, EMAIL_USER and EMAIL_PASS are all real values (not the .env.example ones).
function isEmailConfigured(env = process.env) {
  const values = [env.EMAIL_HOST, env.EMAIL_USER, env.EMAIL_PASS];
  if (values.some((v) => typeof v !== 'string' || v.trim() === '')) return false;
  const [host, user, pass] = values.map((v) => v.trim());
  return !(PLACEHOLDER_HOST.test(host) || PLACEHOLDER_USER.test(user) || PLACEHOLDER_PASS.test(pass));
}

// Port 465 is "implicit TLS" (secure: true); 587 and 25 start plain and upgrade
// with STARTTLS (secure: false). EMAIL_SECURE=true|false overrides the guess.
function useSecureConnection(env = process.env) {
  const forced = String(env.EMAIL_SECURE || '').trim().toLowerCase();
  if (forced === 'true') return true;
  if (forced === 'false') return false;
  return parseInt(env.EMAIL_PORT, 10) === 465;
}

let transporter = null;
let warnedNotConfigured = false;

function getTransporter() {
  // A public demo must not send mail to addresses typed in by visitors.
  if (process.env.DEMO_MODE === 'true') return null;
  if (transporter) return transporter;

  if (!isEmailConfigured()) {
    if (!warnedNotConfigured) {
      warnedNotConfigured = true;
      console.warn('Email not configured. Set EMAIL_HOST, EMAIL_USER and EMAIL_PASS in .env (the example values do not count).');
    }
    return null;
  }

  transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT, 10) || 587,
    secure: useSecureConnection(),
    // A wrong host or a blocked port must fail within seconds. Without these
    // limits sign-up, which waits for the verification email, could hang for minutes.
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 15000,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });

  return transporter;
}

function fromAddress() {
  return process.env.EMAIL_FROM || `${brandName()} <${process.env.EMAIL_USER}>`;
}

// Price x quantity in whole minor, so the line total never shows a floating-point artefact.
function lineTotal(item) {
  try { return fixedAmount(fromMinor(toMinor(item.price) * Number(item.quantity))); }
  catch (e) { return fixedAmount((Number(item.price) * Number(item.quantity) || 0)); }
}

// Customer text (name, product titles) ends up in HTML emails, so it is escaped.
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
}

async function sendOrderConfirmation(order) {
  const t = getTransporter();
  if (!t) return;
  // Anyone can type another person's address at checkout: cap what one address receives per hour.
  if (!mailBudget.allow('order', order.customerEmail)) return;

  // COD and manual-payment orders are only RECEIVED until staff confirm them, so the email must
  // not say "Confirmed".
  const awaitingConfirmation = order.status === 'PLACED';
  const itemsHtml = order.items.map(item => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee;">${escapeHtml(item.title)}${item.size ? ` (${escapeHtml(item.size)})` : ''}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:center;">${item.quantity}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${fixedAmount(Number(item.price || 0))}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${lineTotal(item)}</td>
    </tr>
  `).join('');

  const manualCfg = require('./paymentConfig').manualSettings();
  const manualNoteHtml = order.paymentGateway === 'manual' ? `
          <div style="background:#fff8e1;border:1px solid #ffe08a;border-radius:8px;padding:15px;margin-bottom:20px;">
            <strong>Payment needed:</strong> please send <strong>${fixedAmount(Number(order.totalAmount || 0))}</strong> within ${manualCfg.hours} hours,
            then enter your payment reference on the order page, or reply to this email.
            ${manualCfg.instructions ? `<br><br>${escapeHtml(manualCfg.instructions).replace(/\n/g, '<br>')}` : ''}
          </div>` : '';

  // Cash on Delivery: tell the customer how much to have ready.
  const codNoteHtml = order.paymentGateway === 'cod' ? `
          <div style="background:#fff8e1;border:1px solid #ffe08a;border-radius:8px;padding:15px;margin-bottom:20px;">
            <strong style="color:#856404;">💵 Cash on Delivery (COD) Order Placed</strong>
            <p style="color:#856404;margin:8px 0 0;font-size:14px;">
              Our customer team will call your phone number (${escapeHtml(order.customerPhone)}) to confirm this order.
              Please prepare <strong>${fixedAmount(Number(order.totalAmount))}</strong> in cash for the courier when delivered.
            </p>
          </div>` : '';

  // The coupon code is customer-typed text, so it is escaped below.
  const discount = Number(order.discountAmount) || 0;
  // Shipping is only present when shipping rates are on; take it out of the total to get the subtotal.
  const shippingFee = Number(order.shippingAmount) || 0;
  const discountRowsHtml = discount > 0 ? `
              <tr>
                <td colspan="3" style="padding:8px 12px;text-align:right;color:#555;">Subtotal:</td>
                <td style="padding:8px 12px;text-align:right;color:#555;">${fixedAmount(((Number(order.totalAmount) || 0) - shippingFee + discount))}</td>
              </tr>
              <tr>
                <td colspan="3" style="padding:8px 12px;text-align:right;color:#198754;">Discount${order.couponCode ? ` (${escapeHtml(order.couponCode)})` : ''}:</td>
                <td style="padding:8px 12px;text-align:right;color:#198754;">-${fixedAmount(discount)}</td>
              </tr>` : '';
  const shippingRowHtml = shippingFee > 0 ? `
              <tr>
                <td colspan="3" style="padding:8px 12px;text-align:right;color:#555;">Shipping:</td>
                <td style="padding:8px 12px;text-align:right;color:#555;">${fixedAmount(shippingFee)}</td>
              </tr>` : '';

  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"></head>
    <body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:20px;">
      <div style="max-width:600px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.1);">
        
        <!-- Header -->
        <div style="background:linear-gradient(135deg,#0f1f3d,#17305c);padding:30px;text-align:center;">
          <h1 style="color:#e0a92e;margin:0;font-size:24px;">🛍️ ${escapeHtml(brandName())}</h1>
          <p style="color:rgba(255,255,255,0.8);margin:8px 0 0;">${awaitingConfirmation ? 'Order Received' : 'Order Confirmation'}</p>
        </div>

        <!-- Body -->
        <div style="padding:30px;">
          <h2 style="color:#0f1f3d;margin-top:0;">Thank you, ${escapeHtml(order.customerName)}!</h2>
          <p style="color:#555;">${awaitingConfirmation ? 'We have received your order. It is not confirmed yet, and we will email you as soon as it is. Here\'s a summary:' : 'Your order has been placed successfully. Here\'s a summary:'}</p>

          <!-- Order ID -->
          <div style="background:#f8f9fa;border-radius:8px;padding:15px;margin-bottom:20px;">
            <strong>Order ID:</strong> <code>${order._id}</code><br>
            <strong>Date:</strong> ${new Date(order.createdAt).toLocaleString()}<br>
            <strong>Status:</strong> <span style="color:#6c757d;font-weight:bold;">${escapeHtml(order.status || 'PLACED')}</span>
          </div>

          ${codNoteHtml}
          ${manualNoteHtml}

          <!-- Items Table -->
          <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
            <thead>
              <tr style="background:#0f1f3d;color:white;">
                <th style="padding:10px;text-align:left;">Product</th>
                <th style="padding:10px;text-align:center;">Qty</th>
                <th style="padding:10px;text-align:right;">Price</th>
                <th style="padding:10px;text-align:right;">Subtotal</th>
              </tr>
            </thead>
            <tbody>${itemsHtml}</tbody>
            <tfoot>${discountRowsHtml}${shippingRowHtml}
              <tr>
                <td colspan="3" style="padding:12px;text-align:right;font-weight:bold;font-size:16px;">Total:</td>
                <td style="padding:12px;text-align:right;font-weight:bold;font-size:18px;color:#0f1f3d;">${fixedAmount(Number(order.totalAmount || 0))}</td>
              </tr>
            </tfoot>
          </table>

          <p style="color:#555;">We'll notify you when your order status changes. If you have any questions, just reply to this email.</p>
        </div>

        <!-- Footer -->
        <div style="background:#f8f9fa;padding:20px;text-align:center;border-top:1px solid #eee;">
          <p style="color:#999;margin:0;font-size:12px;">© ${new Date().getFullYear()} ${escapeHtml(brandName())}. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    await t.sendMail({
      from: fromAddress(),
      to: order.customerEmail,
      subject: `${awaitingConfirmation ? '📝 Order Received' : '✅ Order Confirmed'} - ${brandName()} (#${order._id})`,
      html
    });
    console.log(`Order confirmation sent to ${order.customerEmail}`);
  } catch (err) {
    // A mail failure must not break the order; just log it
    console.error('Failed to send order confirmation email:', err.message);
  }
}

async function sendStatusUpdate(order) {
  const t = getTransporter();
  if (!t) return;

  const statusColors = {
    CONFIRMED: '#0d6efd',
    SHIPPED:   '#6f42c1',
    DELIVERED: '#198754',
    CANCELLED: '#dc3545'
  };

  const statusMessages = {
    CONFIRMED: 'Great news! Your order has been confirmed and is being prepared.',
    SHIPPED:   'Your order is on its way! It should arrive soon.',
    DELIVERED: 'Your order has been delivered. We hope you love your new clothes!',
    CANCELLED: 'Your order has been cancelled. If you have questions, please contact us.'
  };

  const color = statusColors[order.status] || '#6c757d';
  let message = statusMessages[order.status] || `Your order status is now: ${order.status}`;
  // A cancelled order the customer already paid for is refunded; say so instead of leaving them
  // wondering.
  if (order.status === 'CANCELLED' && (order.paidAt || order.paymentIssue === 'REFUND_DUE' || order.paymentIssue === 'PAID_AFTER_CANCEL')) {
    message += ' Because this order was paid, you will be refunded. We will contact you about the refund; if you do not hear from us, reply to this email with your order number.';
  }

  const html = `
    <!DOCTYPE html>
    <html>
    <body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:20px;">
      <div style="max-width:600px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.1);">
        <div style="background:linear-gradient(135deg,#0f1f3d,#17305c);padding:30px;text-align:center;">
          <h1 style="color:#e0a92e;margin:0;">🛍️ ${escapeHtml(brandName())}</h1>
          <p style="color:rgba(255,255,255,0.8);margin:8px 0 0;">Order Status Update</p>
        </div>
        <div style="padding:30px;">
          <h2 style="color:#0f1f3d;">Hi ${escapeHtml(order.customerName)},</h2>
          <p style="color:#555;">${message}</p>
          <div style="background:#f8f9fa;border-radius:8px;padding:15px;margin:20px 0;">
            <strong>Order ID:</strong> <code>${order._id}</code><br>
            <strong>New Status:</strong> 
            <span style="color:${color};font-weight:bold;">${order.status}</span>
          </div>
          <p style="color:#555;">Total: <strong>${fixedAmount(Number(order.totalAmount || 0))}</strong></p>
        </div>
        <div style="background:#f8f9fa;padding:20px;text-align:center;border-top:1px solid #eee;">
          <p style="color:#999;margin:0;font-size:12px;">© ${new Date().getFullYear()} ${escapeHtml(brandName())}</p>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    await t.sendMail({
      from: fromAddress(),
      to: order.customerEmail,
      subject: `📦 Order ${order.status} - ${brandName()} (#${order._id})`,
      html
    });
    console.log(`Status update (${order.status}) sent to ${order.customerEmail}`);
  } catch (err) {
    console.error('Failed to send status update email:', err.message);
  }
}

// Resolves to true when handed to the mail server; without email settings nothing is sent and
// false is returned.
async function sendVerificationEmail(user, link) {
  const t = getTransporter();
  if (!t) {
    console.log(`[email not configured] Verification email for ${user.email} skipped.`);
    return false;
  }
  if (!mailBudget.allow('link', user.email)) return false;   // the routes check wouldAllow first

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;">
      <h2 style="color:#0f1f3d;">Verify your email</h2>
      <p>Hi ${escapeHtml(user.name)},</p>
      <p>Please confirm that this is your email address so you can see your orders on ${escapeHtml(brandName())}.</p>
      <p><a href="${escapeHtml(link)}" style="background:#e0a92e;color:#0f1f3d;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">Verify my email</a></p>
      <p style="color:#666;font-size:13px;">This link works for 24 hours. If you didn't create an account, you can ignore this email.</p>
    </div>
  `;

  try {
    await t.sendMail({
      from: fromAddress(),
      to: user.email,
      subject: `Verify your email - ${brandName()}`,
      html
    });
    return true;
  } catch (err) {
    console.error('Failed to send verification email:', err.message);
    return false;
  }
}

// Same contract as sendVerificationEmail.
async function sendPasswordResetEmail(user, link) {
  const t = getTransporter();
  if (!t) {
    console.log(`[email not configured] Password reset email for ${user.email} skipped.`);
    return false;
  }
  if (!mailBudget.allow('link', user.email)) return false;   // the routes check wouldAllow first
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;">
      <h2 style="color:#0f1f3d;">Reset your password</h2>
      <p>Hi ${escapeHtml(user.name)},</p>
      <p>Someone asked to reset the password of your ${escapeHtml(brandName())} account. Choose a new one here:</p>
      <p><a href="${escapeHtml(link)}" style="background:#e0a92e;color:#0f1f3d;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">Choose a new password</a></p>
      <p style="color:#666;font-size:13px;">This link works for 1 hour and only once. If you did not ask for this, ignore this email: your password stays as it is.</p>
    </div>
  `;
  try {
    await t.sendMail({ from: fromAddress(), to: user.email, subject: `Reset your password - ${brandName()}`, html });
    return true;
  } catch (err) {
    console.error('Failed to send password reset email:', err.message);
    return false;
  }
}

async function sendCodExpiredNotification(order, { hadReference = false } = {}) {
  const t = getTransporter();
  if (!t) return;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;">
      <h2 style="color:#d9534f;">${order.paymentGateway === 'manual' ? 'Unpaid order cancelled' : 'COD Order Cancelled'}</h2>
      <p>Hi ${escapeHtml(order.customerName)},</p>
      <p>Your ${order.paymentGateway === 'manual' ? 'manual payment' : 'Cash on Delivery'} order (#${order._id}) was automatically cancelled because it could not be confirmed within the required time window.</p>
      ${hadReference
        ? `<p>We could not verify the payment reference you sent (<code>${escapeHtml(String(order.paymentReference || ''))}</code>). <strong>If you did transfer money, please contact us with your order number and proof of payment and we will refund or re-open the order.</strong></p>`
        : '<p>Reserved items have been released back to stock. If you still wish to complete this purchase, please place a new order on our shop.</p>'}
    </div>
  `;

  try {
    await t.sendMail({
      from: fromAddress(),
      to: order.customerEmail,
      subject: `Order Cancelled (Unconfirmed) - ${brandName()} (#${order._id})`,
      html
    });
  } catch (err) {
    console.error('Failed to send COD expired notification email:', err.message);
  }
}

module.exports = { sendOrderConfirmation, sendCodExpiredNotification, sendStatusUpdate, sendVerificationEmail, sendPasswordResetEmail, brandName, escapeHtml, isEmailConfigured, useSecureConnection };

