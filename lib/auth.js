// Sign-in checks and per-person daily limits, backed by Supabase.
// If SUPABASE_URL is not set, Cortex runs without sign-in (optionally behind ACCESS_CODE).

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const env = (k) => (process.env[k] || '').trim();

export function authEnabled() {
  return Boolean(env('SUPABASE_URL') && env('SUPABASE_ANON_KEY'));
}

// Today's date in US Eastern time, so limits reset at midnight Eastern.
export function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

// ADMIN_EMAILS="you@gmail.com:1000, friend@x.com:500"  (an email with no number gets 1000)
export function limitFor(email) {
  const def = parseInt(env('DAILY_LIMIT'), 10);
  const base = Number.isFinite(def) && def > 0 ? def : 100;
  const target = String(email || '').trim().toLowerCase();
  for (const entry of env('ADMIN_EMAILS').split(',')) {
    const [addr, num] = entry.split(':').map((s) => s.trim());
    if (addr && addr.toLowerCase() === target) {
      const n = parseInt(num, 10);
      return { limit: Number.isFinite(n) && n > 0 ? n : 1000, admin: true };
    }
  }
  return { limit: base, admin: false };
}

// Returns { user } or { error: Response }.
export async function requireUser(req) {
  if (!authEnabled()) {
    const code = env('ACCESS_CODE');
    if (code && req.headers.get('x-access-code') !== code) {
      return { error: json({ error: 'Enter the access code to use this chat.', code: 'access_code_required' }, 401) };
    }
    return { user: null };
  }
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return { error: json({ error: 'Sign in to start chatting.', code: 'auth_required' }, 401) };

  let res;
  try {
    res = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
      headers: { apikey: env('SUPABASE_ANON_KEY'), authorization: `Bearer ${token}` },
    });
  } catch {
    return { error: json({ error: 'Could not reach the sign-in service. Try again in a moment.' }, 502) };
  }
  if (!res.ok) return { error: json({ error: 'Your session expired. Sign in again.', code: 'auth_required' }, 401) };
  const user = await res.json();
  if (!user?.id) return { error: json({ error: 'Your session expired. Sign in again.', code: 'auth_required' }, 401) };
  if (!user.email_confirmed_at && !user.confirmed_at) {
    return { error: json({ error: 'Verify your email first. Check your inbox for the link.', code: 'email_unverified' }, 403) };
  }
  return { user };
}

export async function rest(path, init = {}) {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  return fetch(`${env('SUPABASE_URL')}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, 'content-type': 'application/json', ...(init.headers || {}) },
  });
}

// Count one use. kind: "message" (counts toward the daily limit) or "check" (neurons; allowed 5x the limit).
// Returns { ok, used, limit, admin } or { ok:false, error: Response }.
export async function useQuota(user, kind = 'message') {
  if (!user) return { ok: true };
  const { limit, admin } = limitFor(user.email);
  if (!env('SUPABASE_SERVICE_ROLE_KEY')) {
    return { ok: false, error: json({ error: 'Daily limits are not set up yet: add SUPABASE_SERVICE_ROLE_KEY in Vercel.' }, 500) };
  }
  const cap = kind === 'check' ? limit * 5 : limit;
  let res;
  try {
    res = await rest('rpc/use_quota', {
      method: 'POST',
      body: JSON.stringify({ p_user: user.id, p_day: today(), p_kind: kind, p_limit: cap }),
    });
  } catch {
    return { ok: false, error: json({ error: 'Could not reach the usage service. Try again in a moment.' }, 502) };
  }
  if (!res.ok) {
    return { ok: false, error: json({ error: 'Usage tracking is not set up. Run supabase/setup.sql in your Supabase project.' }, 500) };
  }
  const used = await res.json();
  if (used === null || used === undefined) {
    if (kind === 'check') return { ok: false, quiet: true };
    return {
      ok: false,
      error: json(
        { error: `You've used all ${limit} messages for today. Your limit resets at midnight Eastern time.`, code: 'limit_reached', used: limit, limit },
        429
      ),
    };
  }
  return { ok: true, used, limit, admin };
}

export async function readUsage(user) {
  const { limit, admin } = limitFor(user.email);
  let used = 0;
  try {
    const res = await rest(`usage?select=messages&user_id=eq.${encodeURIComponent(user.id)}&day=eq.${today()}`);
    if (res.ok) used = (await res.json())[0]?.messages || 0;
  } catch { /* show 0 */ }
  return { used, limit, admin };
}

// Give back one use when a request fails before any answer was produced.
export async function refundQuota(user, kind = 'message') {
  if (!user || !env('SUPABASE_SERVICE_ROLE_KEY')) return;
  try {
    await rest('rpc/refund_quota', {
      method: 'POST',
      body: JSON.stringify({ p_user: user.id, p_day: today(), p_kind: kind }),
    });
  } catch { /* best effort */ }
}

// ---------- Signed neuron results ----------
// A neuron signs its findings so /api/chat can trust a correction request
// (and bill it as a cheap "check") without letting people invent their own.
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256(text) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

async function hmac(data) {
  const secret = env('NEURON_SECRET') || env('SUPABASE_SERVICE_ROLE_KEY');
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export async function signFindings(userId, answer, issues) {
  return hmac(`${userId}|${await sha256(answer)}|${JSON.stringify(issues)}`);
}

export async function verifyFindings(userId, answer, issues, token) {
  if (typeof token !== 'string' || token.length !== 64) return false;
  const expected = await signFindings(userId, answer, issues);
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}
