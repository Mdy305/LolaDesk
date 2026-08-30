/**
 * /api/admin/sync — booking-sync health for the platform operator.
 * ════════════════════════════════════════════════════════════════
 * One screen, every tenant's ingestion engine: when each salon last synced
 * its connected booking providers, whether that run had provider errors,
 * how many appointments are cached, and a rolling error count.
 *
 * Hard-gated exactly like /api/admin: the session's email must be in
 * ADMIN_EMAILS. No env var → nobody is admin → 403.
 *
 *   GET /api/admin/sync → { ok, synced, erroring, never, tenants:[…] }
 *
 * Reads:
 *   • booking_sync_log      — per-run audit (created_at, provider, fetched,
 *                             upserted, stale_removed, error_message, duration_ms)
 *   • cached_availability   — current cache size per tenant
 *   • tenants               — identity/roster
 */

import { bearer, getUserFromToken, isAdminEmail } from '../lib/auth.js';
import { db } from '../lib/db.js';
import { syncTenantAvailability, checkProviderDrift } from '../lib/booking-sync.js';

const RECENT_MS = 7 * 24 * 3600 * 1000;   // consider syncs from the last 7 days
const STALE_AFTER_MS = 2 * 3600 * 1000;   // a tenant whose last sync is older than this is "stale"

async function healthSnapshot(c){
  const since = new Date(Date.now() - RECENT_MS).toISOString();

  const [tenants, logs, cacheRows] = await Promise.all([
    c.from('tenants')
      .select('id,slug,name,plan,billing_status,phone_number,created_at')
      .order('created_at', { ascending:false }).limit(500)
      .then(r => r.data || []),
    // All audit rows from the last 7 days, newest first. Deduped in JS so we
    // keep each tenant's single latest run without an N+1 query per tenant.
    c.from('booking_sync_log')
      .select('tenant_id,provider,kind,fetched,upserted,stale_removed,error_message,duration_ms,created_at')
      .gte('created_at', since)
      .order('created_at', { ascending:false })
      .limit(2000)
      .then(r => r.data || []),
    c.from('cached_availability')
      .select('tenant_id')
      .limit(5000)
      .then(r => r.data || [])
  ]);

  // Latest run + error tally per tenant.
  const latest = new Map();
  const errorCount = new Map();
  for(const log of logs){
    if(!latest.has(log.tenant_id)) latest.set(log.tenant_id, log);
    if(log.error_message) errorCount.set(log.tenant_id, (errorCount.get(log.tenant_id) || 0) + 1);
  }

  // Cache size per tenant.
  const cacheSize = new Map();
  for(const row of cacheRows) cacheSize.set(row.tenant_id, (cacheSize.get(row.tenant_id) || 0) + 1);

  const now = Date.now();
  const out = tenants.map(t => {
    const run = latest.get(t.id);
    const lastAt = run?.created_at ? new Date(run.created_at).getTime() : null;
    let status = 'never';
    if(lastAt){
      status = (now - lastAt) > STALE_AFTER_MS ? 'stale' : 'ok';
      if(run.error_message) status = 'error';
    }
    return {
      id: t.id, slug: t.slug, name: t.name, plan: t.plan || '—',
      billing_status: t.billing_status || 'trial', phone_number: t.phone_number || null,
      status,
      last_sync_at: run?.created_at || null,
      last_sync_age_min: lastAt ? Math.round((now - lastAt) / 60000) : null,
      provider: run?.provider || null,
      fetched: run?.fetched ?? null,
      upserted: run?.upserted ?? null,
      stale_removed: run?.stale_removed ?? null,
      duration_ms: run?.duration_ms ?? null,
      error: run?.error_message || null,
      error_count_7d: errorCount.get(t.id) || 0,
      cached_appointments: cacheSize.get(t.id) || 0
    };
  });

  const counts = { synced: 0, erroring: 0, stale: 0, never: 0 };
  for(const t of out){
    if(t.status === 'ok') counts.synced++;
    else if(t.status === 'error') counts.erroring++;
    else if(t.status === 'stale') counts.stale++;
    else counts.never++;
  }

  return { counts, tenants: out };
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok:false, error:'GET/POST only' });

  const user = await getUserFromToken(bearer(req));
  if(!user) return res.status(401).json({ ok:false, error:'Not signed in' });
  if(!isAdminEmail(user.email)) return res.status(403).json({ ok:false, error:'Not authorized' });

  const c = db();
  if(!c) return res.status(503).json({ ok:false, error:'Database not configured' });

  // POST { tenant_id, action:'sync'|'drift' } — fire a sync for ONE salon
  // right now (writing the cache), or run a read-only drift check comparing
  // each provider's true counts against the cache. Both return the live
  // result plus the refreshed health snapshot so the panel re-renders.
  if(req.method === 'POST'){
    try{
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const tenantId = body.tenant_id || body.tenantId;
      if(!tenantId) return res.status(400).json({ ok:false, error:'tenant_id required' });

      const { data: tenant } = await c.from('tenants').select('id').eq('id', tenantId).maybeSingle();
      if(!tenant) return res.status(404).json({ ok:false, error:'tenant not found' });

      const action = body.action || 'sync';
      if(action === 'drift'){
        const drift = await checkProviderDrift(c, tenantId);
        const snapshot = await healthSnapshot(c);
        return res.status(200).json({ ok:true, drift, ...snapshot });
      }
      if(action !== 'sync') return res.status(400).json({ ok:false, error:'action must be sync|drift' });

      const result = await syncTenantAvailability(c, tenantId);
      const snapshot = await healthSnapshot(c);
      return res.status(200).json({ ok:true, sync: result, ...snapshot });
    }catch(e){
      console.error('[admin/sync] POST', e?.message || e);
      return res.status(500).json({ ok:false, error:String(e?.message || e) });
    }
  }

  try{
    const snapshot = await healthSnapshot(c);
    return res.status(200).json({ ok:true, ...snapshot });
  }catch(e){
    console.error('[admin/sync]', e?.message || e);
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
}
