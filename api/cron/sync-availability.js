/**
 * /api/cron/sync-availability — the Supabase Ingestion Engine (blueprint §2).
 *
 * Fired by Vercel Cron every minute (see vercel.json `crons`). Requires the
 * CRON_SECRET env var: Vercel sends `Authorization: Bearer <CRON_SECRET>` on
 * cron GETs; we also accept POST with the same header for manual runs.
 *
 * For every tenant: pulls their connected booking integrations, normalizes
 * the appointments each provider reports, upserts them into
 * `cached_availability`, prunes rows the provider no longer lists, and writes
 * a `booking_sync_log` row. The voice/web booking engine fast-reads the cache
 * so external calendars block slots without a live provider round-trip.
 *
 * Time-budgeted: Vercel caps these functions at 60s (vercel.json `maxDuration`),
 * so we stop starting new tenants once the budget is spent and report how many
 * were synced vs deferred to the next tick.
 */

import { db } from '../lib/db.js';
import { syncTenantAvailability } from '../lib/booking-sync.js';

const MAX_TENANTS_PER_RUN = 50;      // hard cap even with budget left
const BUDGET_MS = Number(process.env.SYNC_CRON_BUDGET_MS || 45000);
const CURSOR_KEY = 'sync_availability_cursor';

// Rotation: each run starts where the last one stopped (a cursor in
// platform_settings), so with more than 50 tenants — or a run cut short by the
// time budget — every salon still gets its turn. Without the table, the start
// rotates by the minute instead.
export async function readCursor(client, total, now = Date.now()){
  try{
    const { data, error } = await client.from('platform_settings').select('value').eq('key', CURSOR_KEY).maybeSingle();
    if(!error && data && Number.isFinite(Number(data.value?.next))) return { start: Number(data.value.next) % Math.max(1, total), stored: true };
  }catch(_){}
  return { start: (Math.floor(now / 60000) * MAX_TENANTS_PER_RUN) % Math.max(1, total), stored: false };
}
async function writeCursor(client, next){
  try{ await client.from('platform_settings').upsert({ key: CURSOR_KEY, value: { next, at: new Date().toISOString() }, updated_at: new Date().toISOString() }, { onConflict: 'key' }); }catch(_){}
}
export function rotate(list, start){
  if(!list.length) return list;
  const s = ((start % list.length) + list.length) % list.length;
  return list.slice(s).concat(list.slice(0, s));
}

function authorized(req){
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${process.env.CRON_SECRET}`;
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET/POST only' });

  if(!process.env.CRON_SECRET){
    return res.status(503).json({ ok: false, error: 'CRON_SECRET is not set — sync cron is disabled' });
  }
  if(!authorized(req)){
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const client = db();
  if(!client) return res.status(503).json({ ok: false, error: 'Database not configured' });

  const started = Date.now();
  const { data: rawTenants, error } = await client.from('tenants').select('id').order('id', { ascending: true });
  if(error) return res.status(500).json({ ok: false, error: error.message });
  if(!rawTenants?.length) return res.status(200).json({ ok: true, synced: 0, note: 'No tenants' });

  // Stable order (by id) + a rotating start, so tenant #51+ isn't starved.
  const all = rawTenants.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const cursor = await readCursor(client, all.length);
  const tenants = rotate(all, cursor.start);

  const results = [];
  let synced = 0, deferred = 0, failed = 0, attempted = 0;
  const errors = [];

  for(const tenant of tenants.slice(0, MAX_TENANTS_PER_RUN)){
    if(Date.now() - started > BUDGET_MS) break;
    attempted++;
    try{
      const r = await syncTenantAvailability(client, tenant.id);
      results.push({ tenant_id: tenant.id, ...r });
      synced++;
    }catch(e){
      failed++;
      errors.push({ tenant_id: tenant.id, error: String(e?.message || e).slice(0, 200) });
    }
  }
  deferred = all.length - attempted;
  await writeCursor(client, (cursor.start + attempted) % all.length);

  return res.status(200).json({
    ok: true,
    synced,
    failed,
    deferred,
    started_at_index: cursor.start,
    duration_ms: Date.now() - started,
    results: results.slice(0, 20),
    errors: errors.slice(0, 10)
  });
}
