'use strict';

// Reads the chatbot settings from the environment and says whether the chatbot is usable.

const PROVIDERS = ['gemini', 'openai', 'anthropic', 'openai-compatible'];

const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1';
const DEFAULT_ANTHROPIC_BASE = 'https://api.anthropic.com';
const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

// A model name is put into a request address (Gemini) or body, so only plain characters are
// accepted.
const MODEL_NAME = /^[a-z0-9][a-z0-9._:/-]{1,100}$/i;
const validModel = (m) => MODEL_NAME.test(m) && !m.includes('..');

const isReal = (value) => {
  const v = String(value === undefined || value === null ? '' : value).trim();
  return v !== '' && !/^(your[-_ ]|replace[-_ ]|changeme|xxx)/i.test(v);
};
const text = (value) => (isReal(value) ? String(value).trim() : '');
const first = (...values) => values.map(text).find(Boolean) || '';

function number(value, fallback, { min, max, integer } = {}) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n))) return fallback;
  if (min !== undefined && n < min) return fallback;
  if (max !== undefined && n > max) return fallback;
  return n;
}

// Like number(), but an out-of-range value is moved to the nearest limit instead of ignored
// (the behaviour the Gemini retry settings have always had).
function clamped(value, fallback, min, max) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function baseUrl(value) {
  const v = text(value).replace(/\/+$/, '');
  if (!v) return '';
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? v : '';
  } catch (err) {
    return '';
  }
}

const providerOf = (env) => {
  const requested = String(env.CHAT_PROVIDER === undefined ? '' : env.CHAT_PROVIDER).trim().toLowerCase();
  // Old installs only have GEMINI_API_KEY, so Gemini stays the default.
  return { requested, provider: requested || 'gemini' };
};

// The models to try, in order: the main one first, then the fallbacks, without duplicates.
function modelList(env = process.env) {
  const { provider } = providerOf(env);
  const gemini = provider === 'gemini';
  const main = first(env.CHAT_MODEL, gemini ? env.GEMINI_MODEL : '');
  const extra = String(first(env.CHAT_FALLBACK_MODELS, gemini ? env.GEMINI_FALLBACK_MODELS : '')).split(',');
  return [...new Set([main, ...extra].map((m) => String(m).trim()).filter(validModel))];
}

// Resolves to { enabled: true, provider, models, model, apiKey, baseUrl, maxTokens, temperature,
// timeoutMs, totalTimeoutMs, maxRetries, retryBaseMs, anthropicVersion } or { enabled: false,
// reason }.
function chatConfig(env = process.env) {
  if (String(env.CHAT_ENABLED === undefined ? '' : env.CHAT_ENABLED).trim().toLowerCase() === 'false') {
    return { enabled: false, reason: 'CHAT_ENABLED is false.' };
  }

  const { requested, provider } = providerOf(env);
  if (!PROVIDERS.includes(provider)) {
    return { enabled: false, reason: `CHAT_PROVIDER "${requested}" is not one of: ${PROVIDERS.join(', ')}.` };
  }

  const specificKey = { gemini: env.GEMINI_API_KEY, openai: env.OPENAI_API_KEY, anthropic: env.ANTHROPIC_API_KEY }[provider];
  const apiKey = first(env.CHAT_API_KEY, specificKey);
  // A local server (Ollama, LM Studio) needs no key; every hosted provider does.
  if (!apiKey && provider !== 'openai-compatible') {
    return { enabled: false, reason: `No API key for ${provider} (set CHAT_API_KEY${provider === 'gemini' ? ' or GEMINI_API_KEY' : ''}).` };
  }

  const models = modelList(env);
  if (!models.length) return { enabled: false, reason: `CHAT_MODEL is required for ${provider} (and must be a plain model name).` };

  let base = baseUrl(env.CHAT_BASE_URL);
  if (isReal(env.CHAT_BASE_URL) && !base) return { enabled: false, reason: 'CHAT_BASE_URL must be a full http(s) address.' };
  if (provider === 'openai-compatible' && !base) return { enabled: false, reason: 'CHAT_BASE_URL is required for openai-compatible.' };
  if (provider === 'openai' && !base) base = DEFAULT_OPENAI_BASE;
  if (provider === 'anthropic' && !base) base = DEFAULT_ANTHROPIC_BASE;
  if (provider === 'gemini' && !base) base = DEFAULT_GEMINI_BASE;

  // Gemini and OpenAI-style servers choose their own reply length when none is set (as Gemini
  // always did here); Anthropic requires a number, so it gets one.
  const maxTokens = number(env.CHAT_MAX_TOKENS, provider === 'anthropic' ? 1024 : null, { min: 16, max: 8000, integer: true });

  return {
    enabled: true,
    provider,
    models,
    model: models[0],
    apiKey,
    baseUrl: base,
    maxTokens,
    temperature: number(env.CHAT_TEMPERATURE, null, { min: 0, max: 2 }),
    // How long ONE attempt may take, and how long the customer waits for the whole answer.
    timeoutMs: number(env.CHAT_TIMEOUT_MS, 15000, { min: 1000, max: 120000, integer: true }),
    totalTimeoutMs: clamped(first(env.CHAT_TOTAL_TIMEOUT_MS, env.GEMINI_TOTAL_TIMEOUT_MS), 30000, 1000, 120000),
    maxRetries: clamped(first(env.CHAT_MAX_RETRIES, env.GEMINI_MAX_RETRIES), 2, 0, 5),
    retryBaseMs: clamped(first(env.CHAT_RETRY_BASE_MS, env.GEMINI_RETRY_BASE_MS), 500, 1, 5000),
    anthropicVersion: text(env.CHAT_ANTHROPIC_VERSION) || DEFAULT_ANTHROPIC_VERSION
  };
}

module.exports = { chatConfig, modelList, PROVIDERS, DEFAULT_ANTHROPIC_VERSION, DEFAULT_OPENAI_BASE, validModel };
