// Model list, shared daily capacity per model (with an admin reserve), and provider requests.
import { rest, today } from './auth.js';

const env = (k) => (process.env[k] || '').trim();
const num = (k, d) => { const n = parseInt(env(k), 10); return Number.isFinite(n) && n >= 0 ? n : d; };

// cap = the model's free requests per day for the whole site.
// reserve = how many of those are kept for admins (ADMIN_EMAILS). Everyone else shares cap - reserve.
export const MODELS = {
  flash: {
    provider: 'gemini', id: () => env('MODEL_FLASH') || 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash', short: '3.8 Flash', files: true, search: true,
    cap: () => num('CAP_FLASH', 1500), reserve: () => num('RESERVE_FLASH', 1000),
  },
  lite: {
    provider: 'gemini', id: () => env('MODEL_LITE') || 'gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash-Lite', short: 'Flash-Lite', files: true, search: true,
    cap: () => num('CAP_LITE', 1500), reserve: () => num('RESERVE_LITE', 500),
  },
  gptoss: {
    provider: 'groq', id: () => env('MODEL_GROQ_1') || 'openai/gpt-oss-120b',
    label: 'GPT-OSS 120B (Groq)', short: 'GPT-OSS', files: false, search: false,
    cap: () => num('CAP_GROQ_1', 1000), reserve: () => num('RESERVE_GROQ_1', 0),
  },
  qwen: {
    provider: 'groq', id: () => env('MODEL_GROQ_2') || 'qwen/qwen3.8-27b',
    label: 'Qwen (Groq)', short: 'Qwen', files: false, search: false,
    cap: () => num('CAP_GROQ_2', 1000), reserve: () => num('RESERVE_GROQ_2', 0),
  },
};
export const AUTO_ORDER = ['flash', 'lite', 'gptoss', 'qwen'];

export function available(key) {
  const m = MODELS[key];
  if (!m) return false;
  return m.provider === 'gemini' ? Boolean(env('GEMINI_API_KEY')) : Boolean(env('GROQ_API_KEY'));
}

export function modelList() {
  return AUTO_ORDER.filter(available).map((key) => ({
    key, label: MODELS[key].label, short: MODELS[key].short, files: MODELS[key].files, search: MODELS[key].search,
  }));
}

// The order to try models in: the person's pick first (if any), then the automatic order.
export function candidates(preferred, { needFiles = false, onlyGemini = false } = {}) {
  const first = typeof preferred === 'string' && Object.hasOwn(MODELS, preferred) ? [preferred] : [];
  return [...new Set([...first, ...AUTO_ORDER])].filter((k) =>
    available(k) && (!needFiles || MODELS[k].files) && (!onlyGemini || MODELS[k].provider === 'gemini'));
}

// Take one unit of today's site-wide capacity for a model. Admins can use the reserve; others can't.
// Returns true when the request may go ahead.
export async function reserveModel(key, user, admin) {
  if (!user || !env('SUPABASE_SERVICE_ROLE_KEY')) return true; // no accounts: rely on the provider's own limits
  const m = MODELS[key];
  const cap = admin ? m.cap() : Math.max(0, m.cap() - m.reserve());
  if (cap <= 0) return false;
  try {
    const res = await rest('rpc/reserve_model', {
      method: 'POST',
      body: JSON.stringify({ p_day: today(), p_model: key, p_cap: cap }),
    });
    if (!res.ok) return true; // counter unavailable: don't block the person
    const n = await res.json();
    return n !== null && n !== undefined;
  } catch {
    return true;
  }
}

// ---------- Provider requests ----------

export function geminiContents(messages) {
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [
      ...(m.attachments || []).map((a) => ({ inlineData: { mimeType: a.mimeType, data: a.data } })),
      { text: m.content || 'Please look at the attached file(s).' },
    ],
  }));
}

// opts: { system, messages, tools, thinking, maxTokens, stream, signal }
export async function callModel(key, opts) {
  const m = MODELS[key];
  if (m.provider === 'groq') {
    const body = {
      model: m.id(),
      stream: Boolean(opts.stream),
      max_tokens: opts.maxTokens || 8192,
      messages: [
        { role: 'system', content: opts.system },
        ...opts.messages.map((x) => ({
          role: x.role,
          content: (x.content || '') + ((x.attachments || []).length ? '\n\n(Files were attached, but this model can only read text.)' : ''),
        })),
      ],
    };
    if (key === 'gptoss') body.reasoning_effort = opts.thinking === 'high' ? 'medium' : 'low';
    return fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${env('GROQ_API_KEY')}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  }

  const send = (withThinking, withTools) => {
    const generationConfig = { maxOutputTokens: opts.maxTokens || 8192 };
    if (withThinking && opts.thinking) generationConfig.thinkingConfig = { thinkingLevel: opts.thinking };
    const payload = {
      systemInstruction: { parts: [{ text: opts.system }] },
      contents: geminiContents(opts.messages),
      generationConfig,
    };
    if (withTools && opts.tools?.length) payload.tools = opts.tools;
    const method = opts.stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m.id()}:${method}`, {
      method: 'POST',
      headers: { 'x-goog-api-key': env('GEMINI_API_KEY'), 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: opts.signal,
    });
  };

  let res = await send(true, true);
  // Retry once without settings this model doesn't accept.
  if (res.status === 400) {
    const msg = await errorMessage(res.clone());
    if (/thinking/i.test(msg)) res = await send(false, true);
    else if (/tool|code_execution|google_search|grounding/i.test(msg) && opts.tools?.length) res = await send(true, false);
  }
  return res;
}

export async function errorMessage(res) {
  let message = `The AI service returned ${res.status}.`;
  try {
    const data = await res.json();
    const err = Array.isArray(data) ? data[0]?.error : data?.error;
    if (err?.message) message = err.message;
  } catch { /* keep default */ }
  return message;
}

// Errors where trying the next model makes sense.
export function shouldFallBack(status) {
  return status === 429 || status === 404 || status === 500 || status === 502 || status === 503 || status === 504;
}
