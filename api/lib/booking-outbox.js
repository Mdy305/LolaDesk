/**
 * api/lib/booking-outbox.js — write-through to the salon's own booking platform.
 * ════════════════════════════════════════════════════════════════════════════
 * On a live call Lola never waits on Square / Vagaro / Boulevard / Fresha /
 * Mindbody / Google: she books in LolaDesk's local engine (conflict-safe hold →
 * booking, sub-100ms) and says "You're all set". The write to the salon's
 * platform is a durable outbox row, committed:
 *   • right after the reply (Vercel waitUntil — the caller never waits), and
 *   • by the every-minute cron for anything still pending (retries with backoff).
 * If the platform refuses (slot taken there, auth expired, service unmapped) the
 * owner gets a text naming the client and time — the booking stays in LolaDesk,
 * nothing is silently lost. Idempotent per booking (one row per booking + op).
 */
import { commitToExternalProvider } from './booking-brain.js';
import { db } from './db.js';

const BACKOFF_MIN = [0, 1, 2, 5, 15, 60];          // attempt n waits BACKOFF_MIN[n] minutes
export const MAX_ATTEMPTS = BACKOFF_MIN.length;
const CONFLICT = /conflict|already (?:booked|taken)|slot (?:is )?taken|time (?:is )?taken|overlap|double[- ]?book/i;
const AUTH = /401|403|unauthori[sz]ed|invalid[_ ]?token|expired|revoked|forbidden/i;

/** Hand a promise to Vercel so it finishes after the response (no package needed). */
export function afterResponse(promise) {
  try {
    const ctx = globalThis[Symbol.for('@vercel/request-context')]?.get?.();
    if (ctx && typeof ctx.waitUntil === 'function') { ctx.waitUntil(Promise.resolve(promise).catch(() => {})); return true; }
  } catch (_) {}
  Promise.resolve(promise).catch(() => {});
  return false;
}

async function healTable(c) {
  try { const { ensureMigrations, resetMigrations } = await import('./migrate.js'); resetMigrations(); await ensureMigrations(); } catch (_) {}
}

/** Queue the upstream write for a booking LolaDesk already holds. Fast: one insert. */
export async function enqueueUpstream(c, { tenantId, bookingId, ctx, op = 'create' }) {
  if (!c || !tenantId || !bookingId) return { ok: false, reason: 'missing' };
  const row = { tenant_id: tenantId, booking_id: bookingId, op, payload: ctx, status: 'pending', attempts: 0, next_attempt_at: new Date().toISOString() };
  const ins = async () => c.from('booking_outbox').upsert(row, { onConflict: 'booking_id,op', ignoreDuplicates: true }).select().maybeSingle();
  let { data, error } = await ins();
  if (error && /relation|does not exist|schema cache|PGRST205|42P01/i.test(error.message || '')) { await healTable(c); ({ data, error } = await ins()); }
  if (error) return { ok: false, reason: error.message || String(error) };
  return { ok: true, id: data?.id || null };
}

async function alertOwner(c, tenantId, text, { send } = {}) {
  try {
    const { data: t } = await c.from('tenants').select('id,name,operator_phone').eq('id', tenantId).maybeSingle();
    if (!t?.operator_phone) return false;
    const sms = send || (await import('./sms.js')).sendSms;
    await sms({ tenantId, to: t.operator_phone, text, skipOptOut: true });
    return true;
  } catch (_) { return false; }
}

function who(ctx) {
  const name = String(ctx?.client?.name || '').split(' ')[0] || 'a client';
  let when = '';
  try { when = new Date(ctx.startsAt).toLocaleString('en-US', { timeZone: ctx.timezone || 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (_) {}
  return `${name}${ctx?.service?.name ? ` (${ctx.service.name})` : ''}${when ? ' ' + when : ''}`;
}

/** Commit one row. Exactly-once: the row is claimed with a status-conditional update first. */
/** The salon's Zap (Boulevard via Zapier…): sent once per booking, remembered in the row. */
async function zapOnce(c, row, zap) {
  if (zap === false || row.payload?.zap_sent) return { skipped: true };
  try {
    const { emitBooking } = await import('./zapier-bridge.js');
    const { data: tenant } = await c.from('tenants').select('id,name').eq('id', row.tenant_id).maybeSingle();
    if (!tenant) return { skipped: true };
    const z = await (zap || emitBooking)(c, tenant, row.booking_id, row.op === 'create' ? 'booking.created' : 'booking.' + row.op);
    if (z?.ok && !z.skipped) { row.payload = { ...(row.payload || {}), zap_sent: true }; await c.from('booking_outbox').update({ payload: row.payload }).eq('id', row.id); }
    return z || { skipped: true };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
}

export async function commitRow(c, row, { commit = commitToExternalProvider, send, now = Date.now(), zap } = {}) {
  const claim = await c.from('booking_outbox').update({ status: 'working', updated_at: new Date(now).toISOString() })
    .eq('id', row.id).eq('status', row.status).select().maybeSingle();
  if (!claim?.data) return { id: row.id, skipped: 'claimed_elsewhere' };
  const attempts = Number(row.attempts || 0) + 1;
  let r;
  try { r = await commit(row.tenant_id, row.payload || {}); } catch (e) { r = { ok: false, error: String(e?.message || e) }; }
  const z = await zapOnce(c, row, zap);
  // No API platform, but the salon's Zap took it → that's the write-through.
  if (r?.skipped && z?.ok && !z.skipped) r = { ok: true, external: { provider: 'zapier', id: null } };
  if (r?.skipped && z && z.ok === false) r = { ok: false, error: z.error || 'Zapier did not accept the booking' };
  const stamp = new Date(now).toISOString();
  if (r?.ok) {
    await c.from('booking_outbox').update({ status: 'done', attempts, provider: r.external?.provider || null, external_id: r.external?.id || null, last_error: null, updated_at: stamp }).eq('id', row.id);
    try { await c.from('bookings').update({ external_id: r.external?.id || null, external_provider: r.external?.provider || null }).eq('id', row.booking_id).eq('tenant_id', row.tenant_id); } catch (_) {}
    try { if (r.external?.id) { const repo = await import('./booking-repository.js'); await repo.upsertProviderMapping({ tenantId: row.tenant_id, provider: r.external.provider, entityType: 'booking', localId: row.booking_id, externalId: String(r.external.id), metadata: { starts_at: row.payload?.startsAt || null } }); } } catch (_) {}
    return { id: row.id, done: true, external: r.external };
  }
  if (r?.skipped) {
    await c.from('booking_outbox').update({ status: 'skipped', attempts, last_error: r.error || 'no booking platform connected', updated_at: stamp }).eq('id', row.id);
    return { id: row.id, skipped: r.error || 'no_platform' };
  }
  const err = String(r?.error || 'unknown error').slice(0, 300);
  const final = r?.conflict || CONFLICT.test(err) || attempts >= MAX_ATTEMPTS;
  if (final) {
    await c.from('booking_outbox').update({ status: 'failed', attempts, last_error: err, updated_at: stamp }).eq('id', row.id);
    const reason = (r?.conflict || CONFLICT.test(err)) ? 'that time is already taken there' : AUTH.test(err) ? 'LolaDesk needs to be reconnected to it (Settings → Integrations)' : 'it kept refusing';
    const alerted = await alertOwner(c, row.tenant_id, `LolaDesk: I booked ${who(row.payload)} in LolaDesk, but your booking system didn't accept it — ${reason}. Please add it there or move it. Reply to me here if you need help.`, { send });
    return { id: row.id, failed: true, error: err, alerted };
  }
  const wait = BACKOFF_MIN[Math.min(attempts, BACKOFF_MIN.length - 1)];
  await c.from('booking_outbox').update({ status: 'pending', attempts, last_error: err, next_attempt_at: new Date(now + wait * 60e3).toISOString(), updated_at: stamp }).eq('id', row.id);
  return { id: row.id, retry_in_min: wait, error: err };
}

/** Commit everything due (cron), or one booking's rows right away (after a booking). */
export async function processOutbox(c = db(), { now = Date.now(), limit = 25, bookingId = null, commit, send, zap } = {}) {
  if (!c) return { ok: false, error: 'no_db' };
  let q = c.from('booking_outbox').select('*').eq('status', 'pending');
  q = bookingId ? q.eq('booking_id', bookingId) : q.lte('next_attempt_at', new Date(now).toISOString());
  const { data, error } = await q.order('next_attempt_at', { ascending: true }).limit(limit);
  if (error) return { ok: false, error: error.message || String(error) };
  const results = [];
  for (const row of data || []) results.push(await commitRow(c, row, { commit, send, now, zap }));
  // A worker that died mid-commit leaves 'working' rows: put them back after 10 minutes.
  if (!bookingId) { try { await c.from('booking_outbox').update({ status: 'pending' }).eq('status', 'working').lt('updated_at', new Date(now - 10 * 60e3).toISOString()); } catch (_) {} }
  return { ok: true, processed: results.length, done: results.filter((x) => x.done).length, failed: results.filter((x) => x.failed).length, retrying: results.filter((x) => x.retry_in_min != null).length, results };
}

/** After a local booking: queue it and start committing without making anyone wait. */
export async function writeThrough(c, { tenantId, booking, ctx }) {
  const q = await enqueueUpstream(c, { tenantId, bookingId: booking.id, ctx });
  if (q.ok) afterResponse(processOutbox(c, { bookingId: booking.id }));
  return q;
}
