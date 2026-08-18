/**
 * /api/admin/booksy — attach a tenant's Booksy business to the sync engine.
 * ════════════════════════════════════════════════════════════════
 * Booksy has no browser OAuth, so there is no self-serve connect flow. The
 * platform partner credential (BOOKSY_PRIVATE_KEY + BOOKSY_PARTNER_ID) is
 * shared, and each tenant is scoped by their Booksy business id stored on an
 * `integrations` row (provider 'booksy', metadata.business_id).
 *
 * This is the operator-side wiring step: once a salon shares their Booksy
 * business id, the operator attaches it here and the booking-sync cron picks
 * it up on the next tick.
 *
 * Hard-gated exactly like /api/admin: the session's email must be in
 * ADMIN_EMAILS.
 *
 *   GET  /api/admin/booksy                        → partner creds + connected roster
 *   POST /api/admin/booksy { tenant_id, business_id }            → connect
 *   POST /api/admin/booksy { tenant_id, action:'disconnect' }    → disconnect
 */

import { bearer, getUserFromToken, isAdminEmail } from '../lib/auth.js';
import { db, upsertIntegration } from '../lib/db.js';

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET/POST only' });

  const user = await getUserFromToken(bearer(req));
  if(!user) return res.status(401).json({ ok: false, error: 'Not signed in' });
  if(!isAdminEmail(user.email)) return res.status(403).json({ ok: false, error: 'Not authorized' });

  const c = db();
  if(!c) return res.status(503).json({ ok: false, error: 'Database not configured' });

  if(req.method === 'POST'){
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const tenantId = body.tenant_id || body.tenantId;
    if(!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

    const { data: tenant } = await c.from('tenants').select('id').eq('id', tenantId).maybeSingle();
    if(!tenant) return res.status(404).json({ ok: false, error: 'tenant not found' });

    if(body.action === 'disconnect'){
      const { error } = await c.from('integrations').delete().eq('tenant_id', tenantId).eq('provider', 'booksy');
      if(error) return res.status(500).json({ ok: false, error: error.message });
      return res.status(200).json({ ok: true, connected: false });
    }

    const businessId = String(body.business_id || body.businessId || '').trim();
    if(!businessId) return res.status(400).json({ ok: false, error: 'business_id required' });

    try{
      await upsertIntegration(tenantId, {
        provider: 'booksy',
        accessToken: null,
        refreshToken: null,
        metadata: { business_id: businessId }
      });
      return res.status(200).json({ ok: true, connected: true, business_id: businessId });
    }catch(e){
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  }

  // GET — partner credential status + the Booksy-connected roster.
  const partnerConfigured = Boolean(process.env.BOOKSY_PRIVATE_KEY && process.env.BOOKSY_PARTNER_ID);
  const { data: rows } = await c.from('integrations')
    .select('tenant_id,metadata').eq('provider', 'booksy');
  const { data: tenants } = await c.from('tenants').select('id,slug,name');
  const byId = new Map((tenants || []).map(t => [t.id, t]));

  const connected = (rows || []).map(r => {
    const t = byId.get(r.tenant_id) || {};
    const m = r.metadata || {};
    return {
      tenant_id: r.tenant_id,
      slug: t.slug || null,
      name: t.name || null,
      business_id: m.business_id || m.businessId || null
    };
  });

  return res.status(200).json({ ok: true, partner_configured: partnerConfigured, connected });
}
