'use strict';

// Anthropic Messages API: https://docs.claude.com/en/api/messages
// The system prompt is a top-level field, roles are user / assistant, max_tokens is required.
function buildRequest(cfg, model, system, messages) {
  const body = {
    model,
    max_tokens: cfg.maxTokens,
    system,
    messages: messages.map((m) => ({ role: m.role, content: m.content }))
  };
  if (cfg.temperature !== null) body.temperature = cfg.temperature;
  return {
    url: `${cfg.baseUrl}/v1/messages`,
    headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': cfg.anthropicVersion, 'content-type': 'application/json' },
    body
  };
}

function parseReply(data) {
  const blocks = (data && Array.isArray(data.content)) ? data.content : [];
  return blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('').trim();
}

module.exports = { buildRequest, parseReply };
