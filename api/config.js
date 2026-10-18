// Vercel Edge Function: GET /api/config
// Tells the page whether sign-in is on, which public Supabase keys to use, and which models exist.
// Only public values are returned here (the Supabase anon/publishable key is designed to be public).
import { json, authEnabled } from '../lib/auth.js';
import { modelList } from '../lib/llm.js';

export const config = { runtime: 'edge' };

export default function handler() {
  const auth = authEnabled();
  return json({
    auth,
    supabaseUrl: auth ? process.env.SUPABASE_URL.trim() : null,
    supabaseKey: auth ? process.env.SUPABASE_ANON_KEY.trim() : null,
    accessCode: !auth && Boolean((process.env.ACCESS_CODE || '').trim()),
    models: modelList(),
  }, 200, { 'cache-control': 'no-store' });
}
