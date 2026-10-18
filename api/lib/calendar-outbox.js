/**
 * api/lib/calendar-outbox.js — the universal calendar bridge, one job per external calendar.
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * Every external schedule the salon links — each calendar (.ics) link, each booking-system API
 * (Boulevard, Vagaro, Square, Fresha, Mindbody, Booksy, Google) — is its OWN row in
 * calendar_sync_jobs (sql/sync-atomic-2026-10.sql). Workers claim due rows with SKIP LOCKED
 * (lola_claim_sync_jobs), so two runs never read the same calendar at once, and a crashed run's
 * lease simply expires.
 *
 * Isolation, by construction:
 *   • each job reads one calendar, inside its own time limit — a link that hangs or drops fails
 *     ONLY its job; the rest of the schedule syncs on time;
 *   • a failed job writes nothing and prunes nothing: that calendar's booked times stay LOCKED in
 *     cached_availability until it answers again (retried with back-off: 1, 2, 5, 10, 30, 60 min);
 *   • a successful job only ever prunes its own rows (its provider, its calendar key);
 *   • unconfirmed / tentative outside appointments are stored as 'unconfirmed' — still busy;
 *   • an outside appointment on top of a LolaDesk booking for the same stylist is a double booking:
 *     the row is marked 'conflict' (still busy) and recorded in calendar_conflicts for the owner.
 */
import { db, getTenantIntegrations } from './db.js';
import { getConnector } from './aggregator.js';
import { feedsOf, feedKey } from './connectors/ical.js';
import { syncSchemaReady } from './sync-schema.js';

export const OUTBOX_PROVIDERS = ['square', 'boulevard', 'vagaro', 'mindbody', 'fresha', 'booksy', 'google_calendar', 'ical'];
const LOOKBACK_MS = 12 * 3600e3;
const RANGE_DAYS = 45;
const OK_EVERY_MS = 2 * 60e3;
const BACKOFF_MIN = [1, 2, 5, 10, 30, 60];
const JOB_MS = () => Number(process.env.SYNC_CONNECTOR_MS || 20000);
const CONCURRENCY = 6;

export function outboxStatus(s) {
  const v = String(s || '').toLowerCase();
  if (['cancelled', 'canceled', 'deleted', 'void', 'declined'].includes(v)) return 'cancelled';
  if (['completed', 'done', 'checked_out', 'finished'].includes(v)) return 'completed';
  if (/tentative|pending|unconfirmed|requested|hold|awaiting|needs?_confirm/.test(v)) return 'unconfirmed';   // still busy
  return 'booked';
}
export const backoffMs = (attempts) => BACKOFF_MIN[Math.min(BACKOFF_MIN.length - 1, Math.max(0, attempts - 1))] * 60e3;

function withTimeout(p, ms, name) {
  let t;
  return Promise.race([Promise.resolve(p).finally(() => clearTimeout(t)), new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${name} didn't answer within ${Math.round(ms / 1000)}s`)), ms); })]);
}
const meta = (p) => { try { return getConnector(p)?.META?.name || p; } catch (_) { return p; } };

/** The jobs one connected integration needs. */
export function jobsFor(integration) {
  if (!integration?.id || !OUTBOX_PROVIDERS.includes(integration.provider)) return [];
  if (integration.provider === 'ical') return feedsOf(integration).map((f) => ({ feed_key: feedKey(f), label: String(f.label || 'Calendar').slice(0, 60) }));
  return [{ feed_key: 'api', label: meta(integration.provider) }];
}
/** Does this cached row belong to this job? */
export function rowOfJob(row, job) {
  if (row.provider !== job.provider) return false;
  return job.feed_key === 'api' ? true : String(row.external_booking_id || '').endsWith('#' + job.feed_key);
}

/** Make calendar_sync_jobs match the salon's linked calendars. Removed calendars: job and busy rows go. */
export async function ensureJobs(c, tenantId, integrations = null) {
  const ints = integrations || await getTenantIntegrations(tenantId).catch(() => []);
  const want = [];
  for (const i of ints) for (const j of jobsFor(i)) want.push({ tenant_id: tenantId, integration_id: i.id, provider: i.provider, feed_key: j.feed_key, label: j.label });
  const { data: have } = await c.from('calendar_sync_jobs').select('id,integration_id,provider,feed_key').eq('tenant_id', tenantId);
  const key = (x) => `${x.integration_id}|${x.feed_key}`;
  const wantKeys = new Set(want.map(key));
  const haveKeys = new Set((have || []).map(key));
  const add = want.filter((w) => !haveKeys.has(key(w)));
  if (add.length) await c.from('calendar_sync_jobs').upsert(add.map((w) => ({ ...w, status: 'new', next_run_at: new Date().toISOString() })), { onConflict: 'tenant_id,integration_id,feed_key', ignoreDuplicates: true });
  const gone = (have || []).filter((h) => !wantKeys.has(key(h)));
  for (const g of gone) {
    // The owner removed that calendar: its busy time is no longer real.
    try {
      const { data: rows } = await c.from('cached_availability').select('id,provider,external_booking_id').eq('tenant_id', tenantId).eq('provider', g.provider);
      const mine = (rows || []).filter((r) => rowOfJob(r, g)).map((r) => r.id);
      const stillApi = g.feed_key === 'api' && want.some((w) => w.provider === g.provider);
      if (mine.length && !stillApi) await c.from('cached_availability').delete().eq('tenant_id', tenantId).in('id', mine);
    } catch (_) {}
    await c.from('calendar_sync_jobs').delete().eq('id', g.id);
  }
  return { added: add.length, removed: gone.length, total: want.length };
}

/** Double bookings: fresh outside rows on top of a LolaDesk booking for the same stylist. */
async function findConflicts(c, tenantId, rows, from, to) {
  const mapped = rows.filter((r) => r.staff_id && r.status !== 'cancelled' && r.status !== 'completed');
  if (!mapped.length) return [];
  const [{ data: books }, { data: maps }] = await Promise.all([
    c.from('bookings').select('id,staff_id,start_time,end_time,status,external_id').eq('tenant_id', tenantId).gte('start_time', from).lt('start_time', to),
    c.from('provider_mappings').select('provider,external_id,local_id').eq('tenant_id', tenantId).eq('entity_type', 'staff'),
  ]);
  const live = (books || []).filter((b) => b.staff_id && !/^(cancel|no[_ -]?show|noshow|declined|void)/i.test(String(b.status || '')));
  const ours = new Set(live.map((b) => b.external_id).filter(Boolean).map(String));
  const toLocal = new Map((maps || []).map((m) => [m.provider + ':' + m.external_id, m.local_id]));
  const out = [];
  for (const r of mapped) {
    if (ours.has(String(r.external_booking_id))) continue;               // our own booking, written upstream
    const sid = String(r.staff_id).startsWith('local:') ? String(r.staff_id).slice(6) : toLocal.get(r.provider + ':' + r.staff_id);
    if (!sid) continue;
    const s = Date.parse(r.starts_at), e = Date.parse(r.ends_at);
    for (const b of live) {
      if (String(b.staff_id) !== String(sid)) continue;
      const bs = Date.parse(b.start_time), be = Date.parse(b.end_time || b.start_time) || bs + 3600e3;
      if (s < be && bs < e) out.push({ row: r, booking: b });
    }
  }
  return out;
}

/** Run ONE job: read one calendar, write its rows, prune only its rows. Never throws. */
export async function runJob(c, job, { now = Date.now(), integrations = null } = {}) {
  const from = new Date(now - LOOKBACK_MS).toISOString();
  const to = new Date(now + RANGE_DAYS * 864e5).toISOString();
  const started = Date.now();
  const done = async (patch) => { try { await c.from('calendar_sync_jobs').update({ ...patch, lease_until: null, updated_at: new Date().toISOString() }).eq('id', job.id); } catch (_) {} };
  const fail = async (error) => {
    const attempts = Number(job.attempts || 0) + 1;
    const msg = String(error?.message || error).slice(0, 240);
    await done({ status: attempts >= 3 ? 'failing' : 'retrying', attempts, last_error: msg, next_run_at: new Date(Date.now() + backoffMs(attempts)).toISOString() });
    try { await c.from('booking_sync_log').insert({ tenant_id: job.tenant_id, provider: job.provider, kind: 'availability', fetched: 0, upserted: 0, stale_removed: 0, error_message: JSON.stringify([{ provider: job.provider, calendar: job.label, error: msg, kept: true }]), duration_ms: Date.now() - started }); } catch (_) {}
    return { ok: false, job: job.id, provider: job.provider, calendar: job.label, error: msg, kept_locked: true };
  };
  try {
    const ints = integrations || await getTenantIntegrations(job.tenant_id);
    const integration = ints.find((i) => i.id === job.integration_id);
    if (!integration) { await c.from('calendar_sync_jobs').delete().eq('id', job.id); return { ok: true, removed: true, job: job.id }; }
    let target = integration;
    if (integration.provider === 'ical') {
      const feed = feedsOf(integration).find((f) => feedKey(f) === job.feed_key);
      if (!feed) { await c.from('calendar_sync_jobs').delete().eq('id', job.id); return { ok: true, removed: true, job: job.id }; }
      target = { ...integration, access_token: JSON.stringify([feed]) };
    }
    const connector = getConnector(integration.provider);
    const apps = await withTimeout(connector.listAppointments(target, { from, to }), JOB_MS(), job.label || integration.provider);
    if (!Array.isArray(apps)) throw new Error('no appointment list');
    if (apps.failed_feeds?.length) throw new Error(apps.failed_feeds[0].error || 'calendar not answering');

    const stamp = new Date().toISOString();
    const seen = new Map();
    for (const a of apps) {
      if (!a || !a.starts_at || Number.isNaN(Date.parse(a.starts_at))) continue;
      const ext = String(a.id || `${integration.provider}:${a.starts_at}:${a.stylist || a.client?.name || ''}`) + (integration.provider === 'ical' && a.id && !String(a.id).includes('#') ? '#' + job.feed_key : '');
      seen.set(ext, {
        tenant_id: job.tenant_id, provider: integration.provider, external_booking_id: ext,
        starts_at: new Date(a.starts_at).toISOString(),
        ends_at: a.ends_at ? new Date(a.ends_at).toISOString() : new Date(Date.parse(a.starts_at) + (a.duration_min || 60) * 60e3).toISOString(),
        duration_min: a.duration_min || 60, staff_id: a.stylist ? String(a.stylist) : null, service: a.service || null,
        client_name: a.client?.name || null, status: outboxStatus(a.status), last_synced_at: stamp,
      });
    }
    const rows = [...seen.values()];
    // A calendar that had appointments and suddenly lists none is confirmed once more before its times are released.
    if (!rows.length && Number(job.last_count) >= 5 && !String(job.last_error || '').startsWith('empty_pending')) {
      await done({ status: 'retrying', last_error: `empty_pending: listed no appointments (had ${job.last_count}) — re-checking before releasing those times`, next_run_at: new Date(Date.now() + 60e3).toISOString() });
      return { ok: false, job: job.id, provider: job.provider, calendar: job.label, error: 'listed no appointments — re-checking', kept_locked: true };
    }
    // Double bookings stay blocked and are recorded for the owner.
    const conflicts = await findConflicts(c, job.tenant_id, rows, from, to).catch(() => []);
    for (const k of conflicts) k.row.status = 'conflict';
    if (rows.length) {
      const { error } = await c.from('cached_availability').upsert(rows, { onConflict: 'tenant_id,provider,external_booking_id' });
      if (error) throw new Error('cache write failed: ' + (error.message || error));
    }
    if (conflicts.length) {
      try {
        await c.from('calendar_conflicts').upsert(conflicts.map((k) => ({ tenant_id: job.tenant_id, booking_id: k.booking.id, provider: k.row.provider, external_booking_id: k.row.external_booking_id, starts_at: k.row.starts_at, ends_at: k.row.ends_at, staff_id: k.row.staff_id, status: 'open' })), { onConflict: 'tenant_id,provider,external_booking_id,booking_id', ignoreDuplicates: true });
      } catch (_) {}
    }
    // Prune ONLY this calendar's rows that it no longer lists (inside the window it just read).
    let pruned = 0;
    try {
      const { data: cached } = await c.from('cached_availability').select('id,provider,external_booking_id,starts_at').eq('tenant_id', job.tenant_id).eq('provider', integration.provider);
      const toMs = Date.parse(to);
      const stale = (cached || []).filter((r) => rowOfJob(r, job) && !seen.has(String(r.external_booking_id)) && (!r.starts_at || Date.parse(r.starts_at) < toMs));
      if (stale.length) {
        await c.from('cached_availability').delete().eq('tenant_id', job.tenant_id).in('id', stale.map((r) => r.id));
        pruned = stale.length;
        try { await c.from('calendar_conflicts').update({ status: 'resolved', resolved_at: stamp }).eq('tenant_id', job.tenant_id).eq('provider', integration.provider).in('external_booking_id', stale.map((r) => r.external_booking_id)).eq('status', 'open'); } catch (_) {}
      }
    } catch (_) {}
    await done({ status: 'ok', attempts: 0, last_ok_at: stamp, last_error: null, last_count: rows.length, next_run_at: new Date(Date.now() + OK_EVERY_MS).toISOString() });
    try { await c.from('booking_sync_log').insert({ tenant_id: job.tenant_id, provider: job.provider, kind: 'availability', fetched: apps.length, upserted: rows.length, stale_removed: pruned, error_message: null, duration_ms: Date.now() - started }); } catch (_) {}
    return { ok: true, job: job.id, provider: job.provider, calendar: job.label, fetched: apps.length, upserted: rows.length, pruned, conflicts: conflicts.length };
  } catch (e) { return fail(e); }
}

async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

/**
 * One pass of the outbox. tenantId: only that salon, every job now (after a link is added).
 * → { ok, unavailable?, ensured, claimed, results }
 */
export async function runOutbox({ client = null, tenantId = null, limit = 40, budgetMs = 45000, leaseSeconds = 90 } = {}) {
  const c = client || db();
  if (!c) return { ok: false, error: 'db_not_configured' };
  if (!(await syncSchemaReady())) return { ok: false, unavailable: true };
  const started = Date.now();
  // Keep the job list in step with every salon's linked calendars.
  let tenants = [];
  if (tenantId) tenants = [tenantId];
  else {
    const { data } = await c.from('integrations').select('tenant_id,provider,status').in('provider', OUTBOX_PROVIDERS).eq('status', 'connected');
    tenants = [...new Set((data || []).map((r) => r.tenant_id))].slice(0, 300);
  }
  const intsBy = new Map();
  let ensured = 0;
  for (const t of tenants) {
    if (Date.now() - started > budgetMs / 3) break;
    try { const ints = await getTenantIntegrations(t); intsBy.set(t, ints); ensured += (await ensureJobs(c, t, ints)).added; } catch (_) {}
  }
  const { data: claimed, error } = await c.rpc('lola_claim_sync_jobs', { p_limit: limit, p_lease_seconds: leaseSeconds, p_tenant_id: tenantId });
  if (error) return { ok: false, error: String(error.message || error) };
  const jobs = Array.isArray(claimed) ? claimed : [];
  const results = await pool(jobs, CONCURRENCY, async (job) => {
    if (Date.now() - started > budgetMs) { try { await c.from('calendar_sync_jobs').update({ lease_until: null }).eq('id', job.id); } catch (_) {} return { ok: true, deferred: true, job: job.id }; }
    let ints = intsBy.get(job.tenant_id);
    if (!ints) { ints = await getTenantIntegrations(job.tenant_id).catch(() => []); intsBy.set(job.tenant_id, ints); }
    return runJob(c, job, { integrations: ints });
  });
  return { ok: true, ensured, claimed: jobs.length, results, failed: results.filter((r) => r && r.ok === false).length, duration_ms: Date.now() - started };
}
