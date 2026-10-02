/**
 * /api/zapier — connect the salon's booking system through Zapier (owner).
 *   GET              → { inbound_url, outbound_connected }
 *   POST { url }     → save the Zapier Catch Hook (https://hooks.zapier.com/…) and send a test event
 *   DELETE           → disconnect the outbound hook
 */
import { getUserFromToken, bearer } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db } from './lib/db.js';
import { inboundUrl, getZapUrl, setZapUrl, validZapUrl, postZap } from './lib/zapier-bridge.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const user = await getUserFromToken(bearer(req)).catch(() => null);
  if (!user) return res.status(401).json({ ok: false, error: 'not signed in' });
  const tenant = await resolveTenantForUser(user).catch(() => null);
  const c = db();
  if (!tenant?.id || !c) return res.status(404).json({ ok: false, error: 'no salon' });
  if (req.method === 'GET') {
    let recent = 0;
    try { const { data } = await c.from('cached_availability').select('id').eq('tenant_id', tenant.id).eq('provider', 'zapier'); recent = (data || []).length; } catch (_) {}
    return res.json({ ok: true, inbound_url: inboundUrl(tenant.id), outbound_connected: !!(await getZapUrl(c, tenant.id)), appointments_received: recent });
  }
  if (req.method === 'DELETE') { await setZapUrl(c, tenant.id, null); return res.json({ ok: true }); }
  if (req.method === 'POST') {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const url = validZapUrl(b.url);
    if (!url) return res.status(400).json({ ok: false, error: 'Paste the Zapier “Catch Hook” URL — it starts with https://hooks.zapier.com/' });
    const now = new Date(), later = new Date(now.getTime() + 3600e3);
    const test = await postZap(url, { event: 'test', source: 'LolaDesk', booking_id: 'test', salon: tenant.name || '', starts_at: now.toISOString(), ends_at: later.toISOString(), start_local: '', end_local: '', duration_min: 60, service: 'Test', stylist_name: '', client_name: 'Test Client', client_phone: '', title: 'Lola: Test Client — Test', status: 'test' });
    if (!test.ok) return res.status(400).json({ ok: false, error: `Zapier didn’t accept it (${test.error}). Check the URL, then try again.` });
    await setZapUrl(c, tenant.id, url);
    return res.json({ ok: true, say: 'Connected. We sent Zapier a test booking — use it to map the fields in your Zap.' });
  }
  return res.status(405).json({ ok: false });
}
