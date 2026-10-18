// Vercel Edge Function: POST /api/chat
// Checks sign-in and the daily limit, picks a model (Gemini first, free backups after),
// and streams the reply as plain text. After the reply, a metadata block (model, sources,
// searches) follows a \u001e separator. API keys stay on the server.

import { CATEGORIES, CREDIBLE_DEFAULT, SEARCH_HINTS, classify, domainOf } from '../lib/sources.js';
import { json, requireUser, useQuota, refundQuota, limitFor, verifyFindings } from '../lib/auth.js';
import { MODELS, candidates, reserveModel, callModel, errorMessage, shouldFallBack } from '../lib/llm.js';

export const config = { runtime: 'edge' };

const MODES = {
  casual: {
    thinking: 'low',
    prompt: 'Mode: Casual. Be friendly, natural and concise, like a smart friend. Short paragraphs, minimal formatting unless it truly helps.',
  },
  research: {
    thinking: 'high',
    prompt: `Mode: Research. Act as a careful research analyst.
- Start with a 2-3 sentence direct answer, then "Key findings" as bullets, then detail where useful, then "Limitations & open questions".
- Rely only on credible sources (peer-reviewed research, government and intergovernmental bodies, established newsrooms, established references). Never rely on blogs, forums, social media, marketing pages, or content farms.
- Attribute important claims in the text ("According to the CDC, ..."). Give numbers with their date and source.
- Distinguish strong evidence from weak or contested evidence. If credible sources don't settle a question, say so plainly.`,
  },
  fun: {
    thinking: 'low',
    prompt: 'Mode: Fun. Be playful, witty and upbeat. Wordplay, light jokes and the occasional emoji are welcome, but keep facts accurate and never mock the user.',
  },
  creative: {
    thinking: 'low',
    prompt: 'Mode: Creative. Be an imaginative writing partner: vivid language, fresh ideas, strong structure. Offer options when the request is open-ended.',
  },
  code: {
    thinking: 'high',
    prompt: 'Mode: Code. Act as a senior software engineer. Give working, idiomatic code in fenced blocks with a language tag, explain key decisions briefly, mention edge cases and how to test.',
  },
  tutor: {
    thinking: 'high',
    prompt: 'Mode: Tutor. Teach step by step at the learner\'s level. Use simple examples and analogies, check understanding, and end with one short practice question.',
  },
};

const BASE_PROMPT = `You are Cortex, a smart, warm and precise AI assistant.
- Answer directly first, then add detail only when it helps.
- Use Markdown (headings, lists, tables, fenced code with a language tag) when it improves readability.
- If you are unsure, say so instead of guessing.
- Do not write your own "Sources" or "References" list at the end. The app adds the list of sources automatically.`;

const MAX_MESSAGES = 40;
const MAX_CHARS = 60000;
const MAX_ATTACHMENT_CHARS = 3_800_000; // keeps requests under Vercel's 4.5 MB body limit
const ALLOWED_MIME = /^(image\/(png|jpeg|webp|heic|heif)|application\/pdf)$/;

function cleanMessages(input) {
  if (!Array.isArray(input)) return [];
  let budget = MAX_ATTACHMENT_CHARS;
  const out = [];
  for (const m of input.slice(-MAX_MESSAGES)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = typeof m.content === 'string' ? m.content.slice(0, MAX_CHARS).trim() : '';
    const attachments = [];
    if (m.role === 'user' && Array.isArray(m.attachments)) {
      for (const a of m.attachments) {
        if (!a || typeof a.data !== 'string' || typeof a.mimeType !== 'string') continue;
        if (!ALLOWED_MIME.test(a.mimeType) || a.data.length > budget) continue;
        budget -= a.data.length;
        attachments.push({ mimeType: a.mimeType, data: a.data, name: String(a.name || 'file').slice(0, 120) });
      }
    }
    if (!content && !attachments.length) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) {
      prev.content = [prev.content, content].filter(Boolean).join('\n\n');
      prev.attachments.push(...attachments);
    } else {
      out.push({ role: m.role, content, attachments });
    }
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

function sourcePrompt(cats, search) {
  if (!search) {
    return 'Web search is OFF for this message. Answer from your own knowledge. If the question depends on recent events or fast-changing facts, say your information may be out of date and suggest turning on a source in the Sources menu.';
  }
  if (cats.includes('web')) {
    return 'Google Search is available. Use it for anything current, factual, or checkable, and prefer authoritative sources over blogs and forums.';
  }
  const kinds = cats.map((c) => `- ${CATEGORIES[c].label}: ${SEARCH_HINTS[c]}`).join('\n');
  return `Google Search is available, but you may ONLY rely on these source types:
${kinds}
Steer your searches toward them (for example add site:.gov, site:.edu, a journal or outlet name, "study", "report"). Ignore and do not use any other kind of result. If these sources do not answer the question, say so instead of using others.`;
}

// A revision request carries the neurons' signed findings, so people can't invent their own.
async function cleanRevision(rev, user) {
  if (!rev || typeof rev !== 'object' || typeof rev.draft !== 'string' || !Array.isArray(rev.findings)) return null;
  const draft = rev.draft.slice(0, 40000);
  const issues = [];
  for (const f of rev.findings.slice(0, 3)) {
    if (!f || !Array.isArray(f.issues) || !f.issues.length) continue;
    if (user && !(await verifyFindings(user.id, draft, f.issues, f.token))) return { invalid: true };
    for (const i of f.issues.slice(0, 5)) {
      const item = {
        claim: String(i?.claim || '').slice(0, 400),
        problem: String(i?.problem || '').slice(0, 600),
        fix: String(i?.fix || '').slice(0, 600),
      };
      if (item.problem || item.fix) issues.push(item);
    }
  }
  if (!issues.length) return null;
  return { draft, issues };
}

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  const auth = await requireUser(req);
  if (auth.error) return auth.error;
  const user = auth.user;
  const admin = user ? limitFor(user.email).admin : true;

  let body;
  try { body = await req.json(); } catch { return json({ error: 'The request was too large or not valid JSON.' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'The request body must be a JSON object.' }, 400);

  let messages = cleanMessages(body.messages);
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return json({ error: 'Send at least one message, ending with yours.' }, 400);
  }

  // A revision is Cortex correcting its own answer after the neurons found problems.
  const revision = await cleanRevision(body.revision, user);
  if (revision?.invalid) return json({ error: 'That correction request could not be verified.' }, 400);

  if (revision) {
    const list = revision.issues.map((i, n) => `${n + 1}. ${i.claim ? `"${i.claim}": ` : ''}${i.problem}${i.fix ? ` Correct information: ${i.fix}` : ''}`).join('\n');
    messages = [
      ...messages,
      { role: 'assistant', content: revision.draft, attachments: [] },
      {
        role: 'user',
        content: `Independent checks found these problems in your last answer:\n${list}\n\nWrite the complete corrected answer now. It will replace your previous answer, so keep everything that was correct, fix every problem above, and keep the same structure and tone. Do not mention the checks, the corrections, or that this is a revision.`,
        attachments: [],
      },
    ];
  }

  const modeKey = typeof body.mode === 'string' && Object.hasOwn(MODES, body.mode) ? body.mode : 'casual';
  const mode = MODES[modeKey];

  let cats = Array.isArray(body.sources) ? [...new Set(body.sources.filter((c) => Object.hasOwn(CATEGORIES, c)))] : [];
  if (modeKey === 'research') {
    cats = cats.filter((c) => CATEGORIES[c].credible);
    if (!cats.length) cats = [...CREDIBLE_DEFAULT];
  }
  const allowAll = cats.includes('web');
  const today = new Date().toISOString().slice(0, 10);
  const needFiles = messages.some((m) => m.attachments.length);

  // ---------- Try models in order until one answers ----------
  const order = candidates(body.model, { needFiles });
  if (!order.length) {
    return json({ error: needFiles
      ? 'No model that can read files is set up. Add GEMINI_API_KEY in Vercel.'
      : 'No AI model is set up. Add GEMINI_API_KEY in Vercel → Settings → Environment Variables.' }, 500);
  }

  const kind = revision ? 'check' : 'message';
  const quota = await useQuota(user, kind);
  if (!quota.ok) return quota.error || json({ error: 'Accuracy checks are paused for today.', code: 'checks_paused' }, 429);

  let upstream = null;
  let usedKey = null;
  let search = false;
  let lastError = '';
  for (const key of order) {
    if (!(await reserveModel(key, user, admin))) continue;
    const m = MODELS[key];
    search = m.search && cats.length > 0;
    const system = `${BASE_PROMPT}\nToday's date is ${today}.\n\n${mode.prompt}\n\n${sourcePrompt(cats, search)}`;
    let res;
    try {
      res = await callModel(key, {
        system, messages, stream: true, thinking: mode.thinking,
        tools: search ? [{ google_search: {} }] : [], signal: req.signal,
      });
    } catch {
      if (req.signal.aborted) { await refundQuota(user, kind); return new Response(null, { status: 499 }); }
      lastError = 'Could not reach the AI service.';
      continue;
    }
    if (res.ok && res.body) { upstream = res; usedKey = key; break; }
    lastError = await errorMessage(res);
    if (!shouldFallBack(res.status)) {
      await refundQuota(user, kind);
      if (/api key/i.test(lastError) || res.status === 401 || res.status === 403) {
        return json({ error: `The ${m.provider === 'groq' ? 'GROQ_API_KEY' : 'GEMINI_API_KEY'} was rejected. Check it in Vercel → Settings → Environment Variables.` }, 500);
      }
      return json({ error: lastError }, 400);
    }
  }
  if (!upstream) {
    await refundQuota(user, kind);
    return json({
      error: 'Today’s free AI capacity is used up. Please try again later, or tomorrow after midnight Eastern.',
      code: 'capacity_reached',
      detail: lastError,
    }, 429);
  }

  const provider = MODELS[usedKey].provider;
  const headers = {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-content-type-options': 'nosniff',
  };
  if (!revision && quota.used !== undefined) {
    headers['x-usage-used'] = String(quota.used);
    headers['x-usage-limit'] = String(quota.limit);
  }

  // ---------- Stream: SSE → plain text, then metadata ----------
  const grounding = { chunks: new Map(), queries: new Set(), suggestionsHtml: '' };

  function extract(event) {
    if (event.error) return `\n\n**Error:** ${event.error.message || 'The reply was interrupted.'}`;
    if (provider === 'groq') return event.choices?.[0]?.delta?.content || '';
    if (event.promptFeedback?.blockReason) return '\n\n_The request was blocked by the safety filter._';
    const cand = event.candidates?.[0];
    const gm = cand?.groundingMetadata;
    if (gm) {
      for (const q of gm.webSearchQueries || []) grounding.queries.add(q);
      for (const c of gm.groundingChunks || []) {
        if (c.web?.uri) grounding.chunks.set(c.web.uri, { title: c.web.title || '', uri: c.web.uri });
      }
      if (gm.searchEntryPoint?.renderedContent) grounding.suggestionsHtml = gm.searchEntryPoint.renderedContent;
    }
    let text = (cand?.content?.parts || [])
      .filter((p) => typeof p.text === 'string' && !p.thought)
      .map((p) => p.text)
      .join('');
    if (/SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/.test(cand?.finishReason || '')) text += '\n\n_The reply was stopped by the safety filter._';
    if (cand?.finishReason === 'MAX_TOKENS') text += '\n\n_The reply hit the length limit. Ask me to continue._';
    return text;
  }

  function buildMeta() {
    const seen = new Set();
    const kept = [];
    let filtered = 0;
    for (const c of grounding.chunks.values()) {
      const domain = domainOf(c.title, c.uri);
      const category = classify(domain);
      if (!(allowAll || cats.includes(category))) { filtered++; continue; }
      const key = domain + '|' + c.title;
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push({ title: c.title || domain, url: c.uri, domain, category });
    }
    return {
      mode: modeKey,
      model: usedKey,
      modelLabel: MODELS[usedKey].label,
      backup: usedKey !== order[0],
      searched: search,
      allowed: cats,
      queries: [...grounding.queries].slice(0, 8),
      sources: kept.slice(0, 20),
      filtered,
      suggestionsHtml: grounding.suggestionsHtml,
      revised: Boolean(revision),
    };
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();
  let buffer = '';

  function parseLines(lines) {
    let text = '';
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let event;
      try { event = JSON.parse(payload); } catch { continue; }
      text += extract(event);
    }
    return text;
  }

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        // Keep reading until there is text to send, so metadata-only chunks never stall the stream.
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            const rest = parseLines(buffer.split('\n'));
            buffer = '';
            controller.enqueue(encoder.encode(rest + '\u001e' + JSON.stringify(buildMeta())));
            controller.close();
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          const text = parseLines(lines);
          if (text) {
            controller.enqueue(encoder.encode(text));
            return;
          }
        }
      } catch (err) {
        reader.cancel().catch(() => {});
        controller.error(err);
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  return new Response(stream, { headers });
}
