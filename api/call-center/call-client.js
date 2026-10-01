/**
 * POST /api/call-center/call-client { to, name?, mode?: 'me' | 'lola' }
 *   mode 'me'   (default) — ring the owner's mobile, then connect the client (salon caller ID)
 *   mode 'lola' — Lola calls the client herself (the existing callback path)
 */
import { bearer, getUserFromToken } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { db } from '../lib/db.js';
import { callThroughOwner } from '../lib/owner-call.js';
import { originateCallback, validPhone } from '../lib/call-callback.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no salon' });
    const c = db();
    if (!c) return res.status(503).json({ ok: false, error: 'database not configured' });
    let body = req.body || {}; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    if (body.mode === 'lola') {
      const to = validPhone(body.to);
      if (!to) return res.status(400).json({ ok: false, say: 'That number doesn’t look right.' });
      const r = await originateCallback(c, tenant, to);
      return res.status(r.ok ? 200 : 502).json({ ...r, say: r.ok ? `Lola is calling ${body.name || 'them'} now.` : 'Lola couldn’t place that call. Say “Lola, run a check”.' });
    }
    const r = await callThroughOwner(c, tenant, body.to, { clientName: body.name });
    return res.status(r.ok ? 200 : (r.error === 'no_owner_phone' || r.error === 'bad_number' || r.error === 'no_line' ? 400 : 502)).json(r);
  } catch (e) { return res.status(500).json({ ok: false, error: String(e?.message || e) }); }
}
