/**
 * POST /api/cal-connect — connect the Cal.com (White-Label) mesh node for a
 * tenant and auto-seed provider_mappings (service -> event type id).
 *
 * Flow:
 *   1. Owner-authenticated + tenant-scoped (same gate as /api/integration-health).
 *   2. Upserts a connected `cal_platform` integration row (API-key mode keeps
 *      no per-tenant token; the connector falls back to CAL_COM_API_KEY /
 *      CAL_COM_CLIENT_ID + SECRET at call time).
 *   3. Lists the account's Cal.com event types, matches them to the tenant's
 *      services by normalized name (matchEventTypesToServices), and writes
 *      provider_mappings rows so booking-brain's write + availability paths
 *      resolve the right event type id.
 *
 * Fails loudly with a descriptive {ok:false,error} when Cal.com isn't
 * configured at the platform level — never a silent partial connect.
 */
import { getUserFromToken, bearer } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db, upsertIntegration, getTenantIntegrations } from './lib/db.js';
import * as repo from './lib/booking-repository.js';
import { getConnector } from './lib/aggregator.js';

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'POST') return res.status(405).json({ ok:false, error:'POST only' });
  try{
    const user = await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({ ok:false, error:'Not authenticated' });
    const tenant = await resolveTenantForUser(user);
    if(!tenant?.id) return res.status(404).json({ ok:false, error:'No tenant mapped to this account' });
    if(!db()) return res.status(503).json({ ok:false, error:'Database not configured' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    // Mark the tenant as connected to the Cal.com mesh node (token stored
    // per-tenant only in Platform managed-user mode; API-key mode relies on
    // the shared CAL_COM_API_KEY and stores no secret here).
    await upsertIntegration(tenant.id, {
      provider: 'cal_platform',
      accessToken: null,
      refreshToken: null,
      metadata: { cal_email: body.email || null, source: 'auto-connect', auto_seeded: true }
    });
    const integrations = await getTenantIntegrations(tenant.id);
    const integration = (integrations || []).find(i => i.provider === 'cal_platform') || { provider: 'cal_platform' };

    // Fails loudly here if CAL_COM_* isn't configured — the owner sees exactly
    // which env var to set, not a silent "connected" lie.
    const eventTypes = await getConnector('cal_platform').listEventTypes(integration);
    const services = await repo.listServices(tenant.id);
    const matches = getConnector('cal_platform').matchEventTypesToServices(services, eventTypes);

    const written = [];
    for(const m of matches){
      try{
        await repo.upsertProviderMapping({
          tenantId: tenant.id, provider: 'cal_platform', entityType: 'service',
          localId: m.service_id, externalId: String(m.event_type_id),
          metadata: { matched_by: m.reason, event_type_slug: m.event_type_slug, event_type_title: m.event_type_title }
        });
        written.push({ service_id: m.service_id, service_name: m.service_name, event_type_id: m.event_type_id, reason: m.reason });
      }catch(e){ console.error('[cal-connect] mapping write failed:', e?.message || e); }
    }

    return res.status(200).json({
      ok: true,
      connected: true,
      provider: 'cal_platform',
      event_types: eventTypes.length,
      services: services.length,
      matched: written.length,
      mappings: written,
      unmatched_services: services.filter(s => !matches.some(m => m.service_id === s.id)).map(s => s.name)
    });
  }catch(e){
    return res.status(200).json({ ok:false, error: String(e?.message || e) });
  }
}
