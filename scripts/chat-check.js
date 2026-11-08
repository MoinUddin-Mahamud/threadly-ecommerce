#!/usr/bin/env node
// Sends one message to the chatbot provider set in .env, so you can check your key and model name
// without opening the shop.
require('dotenv').config({ quiet: true });
const { chatConfig } = require('../services/llm/config');
const { getChatReply } = require('../services/llm');

(async () => {
  const cfg = chatConfig();
  if (!cfg.enabled) {
    console.error(`The chatbot is off: ${cfg.reason}`);
    process.exit(1);
  }
  console.log(`Provider: ${cfg.provider}, model: ${cfg.models.join(' then ')}${cfg.baseUrl ? `, base: ${cfg.baseUrl}` : ''}`);
  const question = process.argv.slice(2).join(' ').trim() || 'Hello! What can you help me with?';
  try {
    console.log('Reply:', await getChatReply({ userMessage: question }));
  } catch (err) {
    console.error('Failed:', err.userMessage || err.message);
    process.exit(1);
  }
})();
