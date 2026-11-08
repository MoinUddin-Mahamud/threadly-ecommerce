'use strict';

const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  actor: {
    type: String,
    required: true,
    index: true
  },
  action: {
    type: String,
    required: true,
    index: true
  },
  targetId: {
    type: String,
    default: null,
    index: true
  },
  targetType: {
    type: String,
    default: null
  },
  before: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  after: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  ip: {
    type: String,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
});

module.exports = mongoose.model('AuditLog', auditLogSchema);
