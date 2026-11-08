const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  title:     { type: String, required: true },
  price:     { type: Number, required: true },
  quantity:  { type: Number, required: true, min: 1 },
  size:      { type: String, default: null },
  // True when the product kept its stock per size at the time of the order, so cancelling returns
  // the units to that size.
  sizeTracked: { type: Boolean, default: undefined },
  // Marketplace: who sold this item and the commission percent that applied when it was ordered.
  vendorId:          { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: undefined },
  commissionPercent: { type: Number, default: undefined, min: 0, max: 90 },
  // Marketplace: this line's share of the coupon discount, in whole minor units.
  discountMinor:     { type: Number, default: undefined, min: 0 }
}, { _id: false });

// One entry per vendor in the order: the vendor ships their own items.
const fulfillmentSchema = new mongoose.Schema({
  vendorId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
  status:    { type: String, enum: ['PENDING', 'SHIPPED', 'DELIVERED'], default: 'PENDING' },
  note:      { type: String, default: '', maxlength: 200 },
  updatedAt: { type: Date, default: Date.now }
}, { _id: false });

const orderSchema = new mongoose.Schema({
  customerName:  { type: String, required: true, trim: true },
  customerEmail: { type: String, required: true, lowercase: true, trim: true },
  customerPhone: { type: String, trim: true, default: '' },
  paymentGateway: { type: String, enum: ['sslcommerz', 'stripe', 'paypal', 'flutterwave', 'mollie', 'cod', 'manual'], default: 'sslcommerz' },
  deliveryAddress: {
    address:  { type: String, trim: true, default: '' },
    city:     { type: String, trim: true, default: '' },
    postcode: { type: String, trim: true, default: '' },
    country:  { type: String, trim: true, default: '' }
  },
  items:          [orderItemSchema],
  fulfillment:    { type: [fulfillmentSchema], default: undefined },
  subtotalAmount: { type: Number, default: 0 },
  // What the customer is charged: subtotalAmount minus discountAmount plus shippingAmount.
  totalAmount:    { type: Number, required: true },
  // Shipping fee included in totalAmount (0 when shipping rates are off or the order shipped free).
  shippingAmount: { type: Number, default: 0, min: 0 },
  // The coupon used on this order (null / 0 when none).
  couponId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon', default: null },
  couponCode:     { type: String, default: null },
  couponType:     { type: String, default: null },
  couponValue:    { type: Number, default: null },
  discountAmount: { type: Number, default: 0, min: 0 },
  status: {
    type: String,
    enum: ['PENDING', 'PLACED', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'],
    default: 'PENDING'
  },
  // Set only when the storefront sends one (never stored as null: the unique
  // index below would treat every null as a duplicate).
  clientRequestId:  { type: String },
  // Where the customer pays (kept so a repeated request can return it) and, for
  // Stripe, the exact amount (minor units) the session was created for.
  gatewayUrl:       { type: String, default: undefined },
  stripeAmountCents:{ type: Number, default: undefined },
  // PayPal, Flutterwave and Mollie: the gateway's own reference for the payment,
  // and the exact amount (in minor units) and currency code the customer is charged. The
  // amount and currency are checked again when the customer comes back.
  gatewayRef:         { type: String, default: undefined },
  gatewayAmountMinor: { type: Number, default: undefined },
  gatewayCurrency:    { type: String, default: undefined },
  transactionId:    { type: String },
  valId:            { type: String },
  paymentReference: { type: String, maxlength: 60, default: null },
  paymentReferenceDuplicate: { type: Boolean, default: undefined },   // true while another order carries the same reference
  paidAt:           { type: Date },
  userId:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  stockReleased:    { type: Boolean, default: false },
  paymentIssue:     { type: String, enum: ['PAID_AFTER_CANCEL', 'REFUND_DUE', 'PAYMENT_UNCONFIRMED'], default: undefined },
  // Marketplace (SELLER_KEEPS_SHIPPED_ON_CANCEL): when a whole order is cancelled, the sellers
  // whose part had already been SHIPPED or DELIVERED keep their earnings and their items are not
  // restocked.
  keptVendorIds:    { type: [mongoose.Schema.Types.ObjectId], default: undefined },
  noRestockVendorIds: { type: [mongoose.Schema.Types.ObjectId], default: undefined },
  refundedAt:       { type: Date, default: null },
  // What was refunded and how (entered by staff when marking an order refunded).
  refundedAmount:   { type: Number, min: 0, default: undefined },
  refundNote:       { type: String, maxlength: 200, default: undefined },
  // Set when staff reopen a cancelled order; the unconfirmed-order timer restarts from it.
  reopenedAt:       { type: Date, default: undefined }
}, { timestamps: true });

orderSchema.index({ customerEmail: 1 });
orderSchema.index({ userId: 1 });
orderSchema.index({ status: 1 });
orderSchema.index({ createdAt: -1 });
orderSchema.index({ transactionId: 1 }, { unique: true, sparse: true });
orderSchema.index({ clientRequestId: 1 }, { unique: true, sparse: true });
orderSchema.index({ gatewayRef: 1 }, { sparse: true });
// Not unique: a reference used twice is flagged (paymentReferenceDuplicate), not rejected. Partial
// (not sparse) because the field holds an explicit null on most orders.
orderSchema.index({ paymentReference: 1 }, { partialFilterExpression: { paymentReference: { $type: 'string' } } });

module.exports = mongoose.model('Order', orderSchema);