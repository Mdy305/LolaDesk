/**
 * /api/boulevard — connect the salon's Boulevard so Lola checks real availability and books straight
 * into it (lib/connectors/boulevard-client.js).
 *   GET     → { ok, connected, business_id (masked), location }
 *   POST    { business_id, api_key, location_id?, env? } → keys proven against Boulevard, then saved
 *           (encrypted). Several locations → { ok:true, choose:[{id,name,city}] } until one is picked.
 *   DELETE  → disconnected (Lola goes back to LolaDesk's calendar / your booking-link setting).
 * Owner-authenticated; fenced to the owner's own salon.
 */
import { getUserFromToken, bearer } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db, upsertIntegration, getTenantIntegrations } from './lib/db.js';
import { PROVIDER, verifyConnection } from './lib/connectors/boulevard-client.js';

const body = (req) => { const b = req.body; if (typeof b === 'string') { try { return JSON.parse(b || '{}'); } catch (_) { return {}; } } return b || {}; };
const mask = (s) => { const v = String(s || ''); return v.length > 8 ? v.slice(0, 4) + '…' + v.slice(-4) : v ? '••••' : ''; };
const UUIDISH = /^[0-9a-f-]{20,64}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const user = await getUserFromToken(bearer(req)).catch(() => null);
  if (!user) return res.status(401).json({ ok: false, error: 'not signed in' });
  const tenant = await resolveTenantForUser(user).catch(() => null);
  const c = db();
  if (!tenant?.id || !c) return res.status(404).json({ ok: false, error: 'no salon for this account' });
  const current = (await getTenantIntegrations(tenant.id).catch(() => [])).find((i) => i.provider === PROVIDER) || null;

  if (req.method === 'GET') {
    const m = current?.metadata || {};
    return res.json({ ok: true, connected: !!current, business_id: mask(m.business_id), location: m.location_name || null, connected_at: current?.updated_at || null });
  }
  if (req.method === 'DELETE') {
    try { await c.from('integrations').update({ status: 'disconnected' }).eq('tenant_id', tenant.id).eq('provider', PROVIDER); } catch (_) {}
    return res.json({ ok: true, say: 'Boulevard disconnected. Lola books in LolaDesk’s calendar again.' });
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET, POST or DELETE' });

  const b = body(req);
  const businessId = String(b.business_id || current?.metadata?.business_id || '').trim();
  const apiKey = String(b.api_key || current?.access_token || '').trim();
  if (!UUIDISH.test(businessId)) return res.status(400).json({ ok: false, error: 'Paste your Boulevard Business ID (it looks like 312bf55a-b6c5-48f2-ab40-eef5d78277ac).' });
  if (apiKey.length < 16) return res.status(400).json({ ok: false, error: 'Paste the API key of your Boulevard app.' });
  const env = b.env === 'sandbox' ? 'sandbox' : 'live';
  let found;
  try { found = await verifyConnection({ apiKey, businessId, env }); }
  catch (e) {
    const msg = e?.code === 'auth' ? 'Boulevard refused that API key or Business ID — check both and try again.' : `Boulevard didn’t accept the connection (${String(e?.message || e).slice(0, 120)}).`;
    return res.status(400).json({ ok: false, error: msg });
  }
  const locs = found.locations;
  let loc = b.location_id ? locs.find((l) => l.id === b.location_id) : (locs.length === 1 ? locs[0] : null);
  if (!loc) return res.json({ ok: true, choose: locs, say: 'Which location should Lola book for?' });
  await upsertIntegration(tenant.id, { provider: PROVIDER, accessToken: apiKey, metadata: { business_id: businessId, location_id: loc.id, location_name: loc.name || null, tz: loc.tz || null, env } });
  return res.json({ ok: true, connected: true, location: loc.name, say: `Boulevard connected${loc.name ? ' — ' + loc.name : ''}. Lola now checks your real Boulevard availability and books, and verifies, every appointment there.` });
}
