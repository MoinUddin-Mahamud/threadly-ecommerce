const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
    maxlength: [100, 'Name cannot exceed 100 characters']
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^[^\s@,;:<>()\[\]"'\\]+@[^\s@,;:<>()\[\]"'\\]+\.[^\s@,;:<>()\[\]"'\\]+$/, 'Please enter a valid email']
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [8, 'Password must be at least 8 characters'],
    // bcrypt only reads the first 72 bytes, so a longer password would silently be cut short.
    validate: {
      validator: (v) => Buffer.byteLength(String(v), 'utf8') <= 72,
      message: 'Password must be at most 72 bytes long'
    },
    select: false
  },
  // Products the customer saved for later (see the wishlist routes in routes/users.js).
  wishlist:           { type: [mongoose.Schema.Types.ObjectId], default: [] },
  // The shop this customer sells through, once they applied to become a vendor.
  vendorId:           { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: null },
  emailVerified:      { type: Boolean, default: false },
  verifyTokenHash:    { type: String, select: false },   // SHA-256 of the emailed token
  verifyTokenExpires: { type: Date, select: false },
  resetTokenHash:     { type: String, select: false },   // SHA-256 of the emailed password-reset token
  resetTokenExpires:  { type: Date, select: false }
}, { timestamps: true });

// Async hooks do not take next() in Mongoose 7+
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 12);
});

userSchema.methods.comparePassword = async function (plainText) {
  return bcrypt.compare(plainText, this.password);
};

module.exports = mongoose.model('User', userSchema);