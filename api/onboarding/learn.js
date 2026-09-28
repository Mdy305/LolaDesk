/**
 * POST /api/onboarding/learn   (Authorization: Bearer <owner token>)
 *   { website?, notes?, instagram?, city? }
 * → { ok, say, suggestions, profile, report }
 * Lola reads the salon's website and/or pasted menu and writes what she
 * learned into the real tables (see lib/business-learn.js). Runs to
 * completion before answering (serverless freezes work after a response).
 */
import { bearer, getUserFromToken } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { db } from '../lib/db.js';
import { learnBusiness } from '../lib/business-learn.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no salon for this account' });
    const c = db();
    if (!c) return res.status(503).json({ ok: false, error: 'database not configured' });
    let body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch { body = {}; } }
    const out = await learnBusiness(c, tenant, {
      website: String(body.website || '').trim().slice(0, 300),
      notes: String(body.notes || '').slice(0, 20000),
      instagram: String(body.instagram || '').trim().slice(0, 80),
      city: String(body.city || '').trim().slice(0, 120),
    });
    return res.status(out.ok ? 200 : 422).json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e), say: 'Something went wrong while I was reading. Try again in a moment.' });
  }
}
