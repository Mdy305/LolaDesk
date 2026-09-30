/**
 * GET /api/lola/doctor  (Authorization: Bearer <owner token>)
 * → { ok, say, checks[] } — Lola tests her brain, voice, texting line and
 *   reflexes live and says what to fix. Same as saying "Lola, run a check".
 */
import { bearer, getUserFromToken } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { lolaSelfCheck } from '../lib/lola-doctor.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no salon for this account' });
    return res.status(200).json(await lolaSelfCheck(tenant));
  } catch (e) { return res.status(500).json({ ok: false, error: String(e?.message || e) }); }
}
