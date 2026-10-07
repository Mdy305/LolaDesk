/**
 * api/lib/booking-sync.js — the Supabase Ingestion Engine (blueprint §2)
 * ════════════════════════════════════════════════════════════════════
 * Polls a tenant's connected booking providers, normalizes the appointments
 * they report, upserts them into `cached_availability`, prunes rows the
 * provider no longer lists, and writes a `booking_sync_log` row per run.
 *
 * The cron (api/cron/sync-availability.js) calls syncTenantAvailability()
 * once per tenant per minute; the booking engine fast-reads the cache in
 * availability-engine-v2 so the voice path reflects external calendars
 * without a live provider round-trip.
 */

import { getTenantIntegrations } from './db.js';
import { getConnector } from './aggregator.js';

// The six sync targets. shopify is retail-only (no appointments API), so it
// is deliberately not polled.
export const SYNC_LOOKBACK_MS = 12 * 3600e3;
export const SYNC_PROVIDERS = ['square', 'boulevard', 'vagaro', 'mindbody', 'fresha', 'booksy', 'google_calendar', 'ical'];

function normStatus(status){
  const s = String(status || '').toLowerCase();
  if(['cancelled', 'canceled'].includes(s)) return 'cancelled';
  if(s === 'completed' || s === 'done') return 'completed';
  return 'booked';
}

/**
 * Fetch + normalize + upsert one tenant's provider appointments.
 * Returns a summary for the caller (cron / manual) to relay or log.
 */
export async function syncTenantAvailability(client, tenantId, { provider = null, rangeDays = 45 } = {}){
  if(!client) return { ok: false, error: 'db_not_configured' };
  const started = Date.now();

  let integrations = [];
  try{ integrations = await getTenantIntegrations(tenantId); }
  catch(e){ return { ok: false, error: `integrations unavailable: ${e?.message || e}` }; }

  const targets = integrations.filter(i =>
    SYNC_PROVIDERS.includes(i.provider) && (!provider || i.provider === provider));
  if(!targets.length) return { ok: true, skipped: true, note: 'no connected booking integrations' };

  // From 12h ago: an appointment that started an hour ago is still in the chair
  // — it must stay busy (syncing from "now" dropped in-progress visits).
  const from = new Date(Date.now() - SYNC_LOOKBACK_MS).toISOString();
  const to = new Date(Date.now() + rangeDays * 86400000).toISOString();

  const appointments = [];
  const providerErrors = [];
  const fetchedOk = new Set();   // providers whose list we actually received
  for(const integration of targets){
    try{
      // Call the connector directly (not via listAllAppointments, which
      // swallows per-provider errors) so a failing provider is visible in
      // the audit log instead of silently returning zero rows.
      const connector = getConnector(integration.provider);
      const apps = await connector.listAppointments(integration, { from, to });
      if(!Array.isArray(apps)) throw new Error('provider returned no appointment list');
      appointments.push(...apps.map(a => ({ ...a, provider: integration.provider })));
      fetchedOk.add(integration.provider);
    }catch(e){
      providerErrors.push({ provider: integration.provider, error: String(e?.message || e).slice(0, 200) });
    }
  }

  // Normalize into cache rows. Providers with no stable id get a synthetic
  // key so upsert/dedup still works.
  const rows = appointments.map(a => ({
    tenant_id: tenantId,
    provider: a.provider,
    external_booking_id: String(a.id || `${a.provider}:${a.starts_at}:${a.stylist || a.client?.name || ''}`),
    starts_at: a.starts_at,
    ends_at: a.ends_at || new Date(new Date(a.starts_at).getTime() + (a.duration_min || 60) * 60000).toISOString(),
    duration_min: a.duration_min || 60,
    staff_id: a.stylist ? String(a.stylist) : null,
    service: a.service || null,
    client_name: a.client?.name || null,
    status: normStatus(a.status),
    last_synced_at: new Date().toISOString()
  }));

  let upserted = 0;
  if(rows.length){
    const { error } = await client.from('cached_availability')
      .upsert(rows, { onConflict: 'tenant_id,provider,external_booking_id' });
    if(error) return { ok: false, error: error.message };
    upserted = rows.length;
  }

  // Prune rows the provider no longer reports (removed or cancelled upstream).
  // ONLY for providers we heard from this run: a provider whose fetch failed
  // (outage, expired token) keeps its cached busy time — wiping it would open
  // those chairs to double bookings until the next good sync.
  const freshIds = new Set(rows.map(r => `${r.provider}\u0000${r.external_booking_id}`));
  const providerList = targets.map(t => t.provider);
  const prunable = providerList.filter(p => fetchedOk.has(p));
  let stale = [];
  try{
    const { data: cached } = prunable.length ? await client.from('cached_availability')
      .select('id,provider,external_booking_id,starts_at').eq('tenant_id', tenantId).in('provider', prunable) : { data: [] };
    // Rows starting beyond the window we just listed are not judged by it (kept);
    // anything earlier — inside the window, or history before the look-back — goes.
    const toMs = new Date(to).getTime();
    stale = (cached || []).filter(r => prunable.includes(r.provider) && !freshIds.has(`${r.provider}\u0000${r.external_booking_id}`)
      && (!r.starts_at || new Date(r.starts_at).getTime() < toMs));
    if(stale.length){
      await client.from('cached_availability').delete()
        .eq('tenant_id', tenantId).in('id', stale.map(s => s.id));
    }
  }catch(e){ /* prune failure shouldn't fail the sync */ }

  await client.from('booking_sync_log').insert({
    tenant_id: tenantId,
    provider: providerList.join(','),
    kind: 'availability',
    fetched: appointments.length,
    upserted,
    stale_removed: stale.length,
    error_message: providerErrors.length ? JSON.stringify(providerErrors.slice(0, 3)) : null,
    duration_ms: Date.now() - started
  });

  return {
    ok: true,
    providers: providerList,
    fetched: appointments.length,
    upserted,
    stale_removed: stale.length,
    provider_errors: providerErrors,
    pruned_providers: prunable,
    duration_ms: Date.now() - started
  };
}

/**
 * Read-only drift check for one tenant: compare the appointments each
 * connected provider ACTUALLY reports right now against how many are cached
 * in cached_availability. Unlike syncTenantAvailability this writes nothing —
 * it's the panel's "is my cache accurate?" signal.
 *
 * Returns per-provider { provider, provider_count, cached_count, drift, drift_pct }
 * where drift = provider_count - cached_count (positive = cache is behind,
 * negative = cache has rows the provider no longer lists).
 */
export async function checkProviderDrift(client, tenantId, { rangeDays = 45 } = {}){
  if(!client) return { ok: false, error: 'db_not_configured' };

  let integrations = [];
  try{ integrations = await getTenantIntegrations(tenantId); }
  catch(e){ return { ok: false, error: `integrations unavailable: ${e?.message || e}` }; }

  const targets = integrations.filter(i => SYNC_PROVIDERS.includes(i.provider));
  if(!targets.length) return { ok: true, skipped: true, note: 'no connected booking integrations' };

  const from = new Date(Date.now() - SYNC_LOOKBACK_MS).toISOString();
  const to = new Date(Date.now() + rangeDays * 86400000).toISOString();

  const providers = [];
  let totalDrift = 0;
  for(const integration of targets){
    let providerCount = 0;
    let error = null;
    try{
      const connector = getConnector(integration.provider);
      const apps = await connector.listAppointments(integration, { from, to });
      providerCount = apps.length;
    }catch(e){
      error = String(e?.message || e).slice(0, 200);
    }

    let cachedCount = 0;
    try{
      const { count } = await client.from('cached_availability')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId).eq('provider', integration.provider);
      cachedCount = Number(count || 0);
    }catch{ /* cache table may be missing pre-migration */ }

    const drift = error ? null : providerCount - cachedCount;
    if(drift !== null) totalDrift += Math.abs(drift);
    providers.push({
      provider: integration.provider,
      provider_count: providerCount,
      cached_count: cachedCount,
      drift,
      drift_pct: (error || cachedCount === 0) ? null
        : Math.round(((providerCount - cachedCount) / cachedCount) * 100),
      error
    });
  }

  const drifted = providers.filter(p => p.drift !== null && p.drift !== 0);
  return {
    ok: true,
    providers,
    drifted: drifted.length,
    total_drift: totalDrift,
    accurate: drifted.length === 0
  };
}

export default { SYNC_PROVIDERS, syncTenantAvailability, checkProviderDrift };
