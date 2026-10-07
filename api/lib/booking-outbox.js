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

/**
 * Queue the upstream write for a booking LolaDesk already holds. Fast: one insert.
 * op: 'create' (new booking) | 'cancel' | 'update' (moved / restaffed).
 * replace:true re-arms an existing (booking, op) row with the newest payload —
 * a second reschedule must reach the salon's system too.
 */
export const OUTBOX_OPS = ['create', 'cancel', 'update'];
export async function enqueueUpstream(c, { tenantId, bookingId, ctx, op = 'create', replace = false }) {
  if (!c || !tenantId || !bookingId) return { ok: false, reason: 'missing' };
  if (!OUTBOX_OPS.includes(op)) return { ok: false, reason: 'unknown_op' };
  const row = { tenant_id: tenantId, booking_id: bookingId, op, payload: ctx, status: 'pending', attempts: 0, last_error: null, next_attempt_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  const ins = async () => c.from('booking_outbox').upsert(row, { onConflict: 'booking_id,op', ignoreDuplicates: !replace }).select().maybeSingle();
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

// ── cancel / update upstream ────────────────────────────────────────────
// The booking row is the source of truth: re-read it at commit time so the
// newest time is what lands, and so a cancel queued before the create finished
// waits for the create (retry) instead of failing.
export async function commitChangeToProvider(c, row) {
  const { data: b } = await c.from('bookings').select('*').eq('id', row.booking_id).eq('tenant_id', row.tenant_id).maybeSingle();
  if (!b) return { ok: false, skipped: true, error: 'booking gone' };
  let externalId = b.external_id || row.payload?.externalId || null;
  let provider = b.external_provider || row.payload?.provider || null;
  if (!externalId) {
    const { data: creates } = await c.from('booking_outbox').select('status').eq('booking_id', row.booking_id).eq('op', 'create');
    if ((creates || []).some((x) => x.status === 'pending' || x.status === 'working')) return { ok: false, wait: true, error: 'create still queued upstream' };
    return { ok: false, skipped: true, error: 'booking was never written upstream' };
  }
  if (provider === 'boulevard_client') return { ok: false, skipped: true, error: 'boulevard_client ' + row.op + ' not supported — LolaDesk only' };
  if (provider === 'zapier') return { ok: false, skipped: true, error: 'the salon Zap handles ' + row.op };
  const { getTenantIntegrations } = await import('./db.js');
  const integrations = await getTenantIntegrations(row.tenant_id).catch(() => []);
  const integration = (integrations || []).find((i) => i.provider === provider);
  if (!integration) return { ok: false, error: `unsupported: ${provider || 'the booking system'} is no longer connected` };
  const { getConnector } = await import('./aggregator.js');
  const connector = getConnector(provider);
  if (row.op === 'cancel') {
    if (typeof connector.cancelAppointment !== 'function') return { ok: false, unsupported: true, error: `unsupported: ${provider} cancel is not available through its API` };
    await connector.cancelAppointment(integration, { id: externalId, tenantId: row.tenant_id });
    return { ok: true, external: { provider, id: externalId } };
  }
  if (typeof connector.updateAppointment !== 'function') return { ok: false, unsupported: true, error: `unsupported: ${provider} reschedule is not available through its API` };
  const repo = await import('./booking-repository.js');
  const staffMap = b.staff_id ? await repo.getProviderMapping(row.tenant_id, provider, 'staff', b.staff_id).catch(() => null) : null;
  await connector.updateAppointment(integration, {
    id: externalId, tenantId: row.tenant_id, starts_at: b.start_time, ends_at: b.end_time,
    duration_min: b.end_time ? Math.round((new Date(b.end_time) - new Date(b.start_time)) / 60000) : undefined,
    team_member_id: staffMap?.external_id || undefined, timezone: row.payload?.timezone || undefined
  });
  return { ok: true, external: { provider, id: externalId } };
}

const UNSUPPORTED = /unsupported|not supported|not available through/i;
const VERB = { create: 'booked', cancel: 'cancelled', update: 'moved' };

export async function commitRow(c, row, { commit = commitToExternalProvider, change = commitChangeToProvider, send, now = Date.now(), zap } = {}) {
  const claim = await c.from('booking_outbox').update({ status: 'working', updated_at: new Date(now).toISOString() })
    .eq('id', row.id).eq('status', row.status).select().maybeSingle();
  if (!claim?.data) return { id: row.id, skipped: 'claimed_elsewhere' };
  const op = row.op || 'create';
  const attempts = Number(row.attempts || 0) + 1;
  let r;
  try { r = op === 'create' ? await commit(row.tenant_id, { bookingId: row.booking_id, ...(row.payload || {}) }) : await change(c, row); } catch (e) { r = { ok: false, error: String(e?.message || e) }; }
  const z = op === 'create' ? await zapOnce(c, row, zap) : null;
  // No API platform, but the salon's Zap took it → that's the write-through.
  if (r?.skipped && z?.ok && !z.skipped) r = { ok: true, external: { provider: 'zapier', id: null } };
  if (r?.skipped && z && z.ok === false) r = { ok: false, error: z.error || 'Zapier did not accept the booking' };
  const stamp = new Date(now).toISOString();
  if (r?.ok) {
    await c.from('booking_outbox').update({ status: 'done', attempts, provider: r.external?.provider || null, external_id: r.external?.id || null, last_error: null, updated_at: stamp }).eq('id', row.id);
    if (op === 'create') {
      try { await c.from('bookings').update({ external_id: r.external?.id || null, external_provider: r.external?.provider || null }).eq('id', row.booking_id).eq('tenant_id', row.tenant_id); } catch (_) {}
      try { if (r.external?.id) { const repo = await import('./booking-repository.js'); await repo.upsertProviderMapping({ tenantId: row.tenant_id, provider: r.external.provider, entityType: 'booking', localId: row.booking_id, externalId: String(r.external.id), metadata: { starts_at: row.payload?.startsAt || null } }); } } catch (_) {}
    }
    return { id: row.id, op, done: true, external: r.external };
  }
  if (r?.skipped) {
    await c.from('booking_outbox').update({ status: 'skipped', attempts, last_error: r.error || 'no booking platform connected', updated_at: stamp }).eq('id', row.id);
    return { id: row.id, op, skipped: r.error || 'no_platform' };
  }
  const err = String(r?.error || 'unknown error').slice(0, 300);
  const conflict = !!(r?.conflict || (op === 'create' && CONFLICT.test(err)));
  const unsupported = !!(r?.unsupported || UNSUPPORTED.test(err));
  const final = !r?.wait && (conflict || unsupported || attempts >= MAX_ATTEMPTS);
  if (final) {
    await c.from('booking_outbox').update({ status: 'failed', attempts, last_error: err, updated_at: stamp }).eq('id', row.id);
    const reason = conflict ? 'that time is already taken there'
      : unsupported ? "LolaDesk can't change appointments in that system automatically"
      : AUTH.test(err) ? 'LolaDesk needs to be reconnected to it (Settings → Integrations)' : 'it kept refusing';
    const text = op === 'create'
      ? `LolaDesk: I booked ${who(row.payload)} in LolaDesk, but your booking system didn't accept it — ${reason}. Please add it there or move it. Reply to me here if you need help.`
      : `LolaDesk: ${who(await changeCtx(c, row))} was ${VERB[op]} in LolaDesk, but your booking system didn't take the change — ${reason}. Please ${op === 'cancel' ? 'cancel it there too' : 'move it there too'} so the two calendars match.`;
    const alerted = await alertOwner(c, row.tenant_id, text, { send });
    return { id: row.id, op, failed: true, conflict, unsupported, error: err, alerted };
  }
  const wait = BACKOFF_MIN[Math.min(attempts, BACKOFF_MIN.length - 1)] || 1;
  await c.from('booking_outbox').update({ status: 'pending', attempts: r?.wait ? Math.min(attempts, MAX_ATTEMPTS - 1) : attempts, last_error: err, next_attempt_at: new Date(now + wait * 60e3).toISOString(), updated_at: stamp }).eq('id', row.id);
  return { id: row.id, op, retry_in_min: wait, error: err };
}

// Owner-alert context for a cancel/update row: client first name, service, time.
async function changeCtx(c, row) {
  try {
    const { data: b } = await c.from('bookings').select('client_id,service_id,start_time').eq('id', row.booking_id).maybeSingle();
    const [{ data: cl }, { data: sv }] = await Promise.all([
      b?.client_id ? c.from('clients').select('name').eq('id', b.client_id).maybeSingle() : Promise.resolve({ data: null }),
      b?.service_id ? c.from('services').select('name').eq('id', b.service_id).maybeSingle() : Promise.resolve({ data: null })
    ]);
    const { salonTz } = await import('./salon-time.js');
    return { client: { name: cl?.name || null }, service: { name: sv?.name || null }, startsAt: row.op === 'cancel' ? (b?.start_time || row.payload?.startsAt) : (b?.start_time || row.payload?.startsAt), timezone: await salonTz(row.tenant_id) };
  } catch (_) { return row.payload || {}; }
}

/** Commit everything due (cron), or one booking's rows right away (after a booking). */
export async function processOutbox(c = db(), { now = Date.now(), limit = 25, bookingId = null, commit, change, send, zap } = {}) {
  if (!c) return { ok: false, error: 'no_db' };
  let q = c.from('booking_outbox').select('*').eq('status', 'pending');
  q = bookingId ? q.eq('booking_id', bookingId) : q.lte('next_attempt_at', new Date(now).toISOString());
  const { data, error } = await q.order('next_attempt_at', { ascending: true }).limit(limit);
  if (error) return { ok: false, error: error.message || String(error) };
  const results = [];
  for (const row of data || []) results.push(await commitRow(c, row, { commit, change, send, now, zap }));
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
