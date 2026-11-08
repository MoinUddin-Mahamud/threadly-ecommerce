'use strict';

// OpenAI Chat Completions: POST {base}/chat/completions with a Bearer key.
// OpenRouter, Groq, Together, Mistral, DeepSeek, Ollama, LM Studio and many gateways speak the same
// wire format, which is why openaiCompatible.js reuses this file.
function buildRequest(cfg, model, system, messages) {
  const body = {
    model,
    messages: [{ role: 'system', content: system }, ...messages.map((m) => ({ role: m.role, content: m.content }))]
  };
  if (cfg.maxTokens !== null) {
    // OpenAI's own newer models take max_completion_tokens; most other servers only know max_tokens.
    body[cfg.provider === 'openai' ? 'max_completion_tokens' : 'max_tokens'] = cfg.maxTokens;
  }
  if (cfg.temperature !== null) body.temperature = cfg.temperature;
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  return { url: `${cfg.baseUrl}/chat/completions`, headers, body };
}

function parseReply(data) {
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.filter((p) => p && typeof p.text === 'string').map((p) => p.text).join('').trim();
  return '';
}

module.exports = { buildRequest, parseReply };
