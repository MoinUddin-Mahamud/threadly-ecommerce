const mongoose = require('mongoose');

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.DB_NAME || 'ecommerce';

  if (!uri) {
    throw new Error('MONGODB_URI is missing in .env');
  }

  await mongoose.connect(uri, { dbName });
  console.log(`MongoDB connected to database: ${dbName}`);
}

module.exports = connectDB;


