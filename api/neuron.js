// Vercel Edge Function: POST /api/neuron
// A "neuron" is a small independent checker that reviews an answer Cortex just gave.
//   fact      verifies key facts with Google Search, favoring credible sources
//   logic     checks math, reasoning and code (runs code with Gemini's code execution)
//   coverage  checks every part of the question was answered, with key caveats
// Body: { type, question, answer, mode }
// The response streams a few spaces while working (keeps the connection alive), then one JSON object:
//   { verdict: "pass" | "issues", checked, summary, issues: [{ claim, problem, fix }], model }

import { json, requireUser, useQuota, refundQuota, limitFor, signFindings } from '../lib/auth.js';
import { SEARCH_HINTS } from '../lib/sources.js';
import { MODELS, candidates, reserveModel, callModel, shouldFallBack } from '../lib/llm.js';

export const config = { runtime: 'edge' };

const OUTPUT = `Reply with ONLY one JSON object and nothing else:
{"verdict":"pass" or "issues","checked":<how many items you checked>,"summary":"<one short plain sentence about what you checked>","issues":[{"claim":"<short quote or paraphrase from the answer>","problem":"<what is wrong>","fix":"<the correct information>"}]}
Rules:
- Only report a problem when you are confident it is wrong AND you can state the correct information.
- Do not report style, tone, length, formatting, opinions, or things that are merely debatable.
- If everything checks out, use "verdict":"pass" and an empty "issues" list.
- At most 5 issues.`;

const NEURONS = {
  fact: {
    tools: [{ google_search: {} }],
    prompt: (mode) => `You are the Fact Neuron, an independent fact-checker.
Pick the 3-8 most important checkable facts in the ANSWER (numbers, dates, names, definitions, current events, current office holders, prices, rules) and verify each one with Google Search.
Prefer credible sources: ${SEARCH_HINTS.gov}; ${SEARCH_HINTS.academic}; ${SEARCH_HINTS.news}; ${SEARCH_HINTS.reference}.${mode === 'research' ? ' Use ONLY those credible sources for this check.' : ''}
A fact that is out of date counts as a problem.`,
  },
  logic: {
    tools: [{ code_execution: {} }],
    prompt: () => `You are the Logic Neuron, an independent checker of math, reasoning and code.
Check every calculation, unit conversion, percentage, date difference and logical step in the ANSWER. For code, check that it is correct and would run; use code execution to actually run calculations and short code snippets whenever possible.
Count each calculation, step or code block you checked.`,
  },
  coverage: {
    tools: [],
    prompt: () => `You are the Coverage Neuron, an independent reviewer.
Check whether the ANSWER fully addresses every part of the QUESTION, contradicts itself anywhere, or leaves out a caveat or safety warning that a careful expert would consider essential (for example about health, money, law, or irreversible actions).
Count each part of the question you checked.`,
  },
};

// Find the verdict object. Code-execution output can contain other braces, so try each text part from the end.
function extractJson(parts) {
  for (const text of [...parts].reverse().concat(parts.join('\n'))) {
    const end = text.lastIndexOf('}');
    let start = text.lastIndexOf('{', end);
    while (start !== -1) {
      try {
        const obj = JSON.parse(text.slice(start, end + 1));
        if (obj && typeof obj === 'object' && 'verdict' in obj) return obj;
      } catch { /* widen */ }
      start = text.lastIndexOf('{', start - 1);
    }
  }
  return null;
}

function normalize(raw, modelKey) {
  const issues = (Array.isArray(raw?.issues) ? raw.issues : []).slice(0, 5).map((i) => ({
    claim: String(i?.claim || '').slice(0, 300),
    problem: String(i?.problem || '').slice(0, 500),
    fix: String(i?.fix || '').slice(0, 500),
  })).filter((i) => i.problem && i.fix);
  return {
    verdict: issues.length ? 'issues' : 'pass',
    checked: Math.max(0, Math.min(50, parseInt(raw?.checked, 10) || 0)),
    summary: String(raw?.summary || '').slice(0, 240),
    issues,
    model: MODELS[modelKey]?.short || modelKey,
  };
}

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  const auth = await requireUser(req);
  if (auth.error) return auth.error;
  const user = auth.user;
  const admin = user ? limitFor(user.email).admin : true;

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON.' }, 400); }
  const type = typeof body?.type === 'string' && Object.hasOwn(NEURONS, body.type) ? body.type : null;
  const question = typeof body?.question === 'string' ? body.question.slice(0, 20000) : '';
  const answer = typeof body?.answer === 'string' ? body.answer.slice(0, 40000) : '';
  if (!type || !answer) return json({ error: 'Missing neuron type or answer.' }, 400);

  const neuron = NEURONS[type];
  const today = new Date().toISOString().slice(0, 10);
  const system = `${neuron.prompt(body.mode)}\nToday's date is ${today}.\n\n${OUTPUT}`;
  const messages = [{
    role: 'user',
    content: `QUESTION:\n${question || '(not provided)'}\n\nANSWER TO CHECK:\n${answer}`,
    attachments: [],
  }];

  // Neurons need Gemini (search and code execution). Flash-Lite first, to save Flash for answers.
  const order = ['lite', 'flash'].filter((k) => candidates(null, { onlyGemini: true }).includes(k));
  if (!order.length) return json({ skipped: true, summary: 'Checks need a Gemini API key.' });

  const quota = await useQuota(user, 'check');
  if (!quota.ok) {
    if (quota.quiet) return json({ skipped: true, summary: 'Checks are paused for today.' });
    return quota.error;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const beat = setInterval(() => { try { controller.enqueue(encoder.encode(' ')); } catch { /* client left */ } }, 5000);
      let result = { skipped: true, summary: 'This check could not run right now.' };
      try {
        for (const key of order) {
          if (!(await reserveModel(key, user, admin))) continue;
          let res;
          try {
            res = await callModel(key, { system, messages, tools: neuron.tools, thinking: 'low', maxTokens: 4096, signal: req.signal });
          } catch { if (req.signal.aborted) break; continue; }
          if (!res.ok) { if (shouldFallBack(res.status)) continue; break; }
          const data = await res.json();
          const parts = (data.candidates?.[0]?.content?.parts || [])
            .filter((p) => typeof p.text === 'string' && !p.thought)
            .map((p) => p.text);
          const parsed = extractJson(parts);
          if (parsed) {
            result = normalize(parsed, key);
            if (user && result.issues.length) result.token = await signFindings(user.id, answer, result.issues);
          }
          break;
        }
      } catch { /* keep "could not run" */ }
      clearInterval(beat);
      if (result.skipped) await refundQuota(user, 'check');
      try {
        controller.enqueue(encoder.encode(JSON.stringify(result)));
        controller.close();
      } catch { /* the page went away */ }
    },
  });

  return new Response(stream, {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
