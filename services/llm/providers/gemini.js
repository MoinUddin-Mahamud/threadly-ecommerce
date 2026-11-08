'use strict';

// Google Gemini: https://ai.google.dev/gemini-api/docs
// The key goes in the x-goog-api-key header, never in the URL.

function buildRequest(cfg, model, system, messages) {
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
  };
  const generationConfig = {};
  if (cfg.maxTokens !== null) generationConfig.maxOutputTokens = cfg.maxTokens;
  if (cfg.temperature !== null) generationConfig.temperature = cfg.temperature;
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  return {
    url: `${cfg.baseUrl}/models/${encodeURIComponent(model)}:generateContent`,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
    body
  };
}

// Some models return "thinking" parts before the answer; only answer text is shown.
function parseReply(data) {
  const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  return parts.filter((p) => p && typeof p.text === 'string' && !p.thought).map((p) => p.text).join('').trim();
}

module.exports = { buildRequest, parseReply };
