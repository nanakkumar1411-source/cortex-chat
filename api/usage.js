// Vercel Edge Function: GET /api/usage
// Returns today's message count and daily limit for the signed-in person.
import { json, authEnabled, requireUser, readUsage } from '../lib/auth.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (!authEnabled()) return json({ used: 0, limit: null, admin: false });
  const auth = await requireUser(req);
  if (auth.error) return auth.error;
  return json(await readUsage(auth.user), 200, { 'cache-control': 'no-store' });
}
