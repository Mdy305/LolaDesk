/**
 * api/lib/zapier-bridge.js — two-way with any booking system Zapier speaks to
 * (Boulevard first), no partner approval needed.
 * ════════════════════════════════════════════════════════════════════════════
 * IN  (their system → Lola, seconds): a Zap on "New Appointment" / "Appointment
 *     Rescheduled" / "Appointment Cancelled" POSTs to the salon's private LolaDesk
 *     hook URL. The appointment becomes busy time in LolaDesk's local calendar
 *     immediately (cancelled → freed), mapped to the stylist by name.
 * OUT (Lola → their system): when Lola books, moves or cancels, LolaDesk POSTs a
 *     flat event to the salon's Zapier "Catch Hook"; their Zap creates (or removes)
 *     a time block in Boulevard so nobody books over Lola's client.
 */
import crypto from 'node:crypto';
import { appUrl } from './telnyx-client.js';
import { encrypt, decrypt } from './crypto.js';
import { zonedLocalToUtc } from './timezone.js';

const seal = (t) => { try { return encrypt(t); } catch (_) { return 'plain:' + t; } };
const unseal = (t) => { const s = String(t || ''); if (s.startsWith('plain:')) return s.slice(6); try { return decrypt(s); } catch (_) { return null; } };
const keyBase = () => String(process.env.SUPABASE_SERVICE_KEY || process.env.TELNYX_API_KEY || 'loladesk') + ':zap-hook';

export function hookKey(tenantId) { return crypto.createHmac('sha256', keyBase()).update(String(tenantId)).digest('hex').slice(0, 32); }
export function inboundUrl(tenantId) { return `${appUrl()}/api/hooks/booking?t=${encodeURIComponent(tenantId)}&k=${hookKey(tenantId)}`; }
export function checkKey(tenantId, k) {
  const want = hookKey(tenantId), got = String(k || '');
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
export function validZapUrl(u) {
  try { const x = new URL(String(u || '').trim()); return x.protocol === 'https:' && /(^|\.)zapier\.com$/.test(x.hostname) ? x.toString() : null; } catch (_) { return null; }
}

// ── OUT ──
export async function getZapUrl(c, tenantId) {
  try { const { data } = await c.from('tenant_channels').select('access_token,status').eq('tenant_id', tenantId).eq('channel', 'zapier').maybeSingle(); return data && data.status === 'active' ? unseal(data.access_token) : null; } catch (_) { return null; }
}
export async function setZapUrl(c, tenantId, url) {
  const row = { tenant_id: tenantId, channel: 'zapier', account_id: String(tenantId), username: url ? new URL(url).hostname : null, access_token: url ? seal(url) : null, status: url ? 'active' : 'disconnected', updated_at: new Date().toISOString() };
  let { error } = await c.from('tenant_channels').upsert(row, { onConflict: 'channel,account_id' });
  if (error && /relation|does not exist|schema cache|PGRST205|42P01/i.test(error.message || '')) {
    try { const { ensureMigrations, resetMigrations } = await import('./migrate.js'); resetMigrations(); await ensureMigrations(); } catch (_) {}
    ({ error } = await c.from('tenant_channels').upsert(row, { onConflict: 'channel,account_id' }));
  }
  if (error) throw new Error(error.message || String(error));
  return true;
}

/** Everything a Zap needs, flat (Zapier maps fields by name). */
export async function bookingEvent(c, tenant, bookingId, event = 'booking.created', extra = {}) {
  const { data: b } = await c.from('bookings').select('*').eq('id', bookingId).eq('tenant_id', tenant.id).maybeSingle();
  if (!b) return null;
  const [svc, st, cl, bs] = await Promise.all([
    b.service_id ? c.from('services').select('name').eq('id', b.service_id).maybeSingle().then((r) => r.data).catch(() => null) : null,
    b.staff_id ? c.from('staff').select('name').eq('id', b.staff_id).maybeSingle().then((r) => r.data).catch(() => null) : null,
    b.client_id ? c.from('clients').select('first_name,last_name,name,phone,email').eq('id', b.client_id).maybeSingle().then((r) => r.data).catch(() => null) : null,
    c.from('booking_settings').select('timezone').eq('tenant_id', tenant.id).maybeSingle().then((r) => r.data).catch(() => null),
  ]);
  const tz = bs?.timezone || 'America/New_York';
  const name = (cl?.name || [cl?.first_name, cl?.last_name].filter(Boolean).join(' ') || '').trim();
  const local = (iso) => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)).replace(',', ''); } catch (_) { return iso; } };
  return {
    event, source: 'LolaDesk', booking_id: b.id, salon: tenant.name || '', timezone: tz,
    starts_at: new Date(b.start_time).toISOString(), ends_at: new Date(b.end_time || b.start_time).toISOString(),
    start_local: local(b.start_time), end_local: local(b.end_time || b.start_time),
    duration_min: Math.round((new Date(b.end_time || b.start_time) - new Date(b.start_time)) / 60e3),
    service: svc?.name || '', stylist_name: st?.name || '', client_name: name, client_phone: cl?.phone && !String(cl.phone).includes(':') ? cl.phone : '', client_email: cl?.email || '',
    title: `Lola: ${name || 'Client'}${svc?.name ? ' — ' + svc.name : ''}`, confirmation_code: b.confirmation_code || '', status: b.status || '',
    ...extra,
  };
}

export async function postZap(url, payload, { fetchImpl = fetch } = {}) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ac.signal });
    return r.ok ? { ok: true } : { ok: false, error: `Zapier answered ${r.status}` };
  } catch (e) { return { ok: false, error: String(e?.name === 'AbortError' ? 'Zapier timed out' : (e?.message || e)) }; }
  finally { clearTimeout(t); }
}

/** Tell the salon's Zap about one of Lola's bookings (no-op when no Zap is connected). */
export async function emitBooking(c, tenant, bookingId, event, extra) {
  const url = await getZapUrl(c, tenant.id);
  if (!url) return { ok: true, skipped: true };
  const payload = await bookingEvent(c, tenant, bookingId, event, extra);
  if (!payload) return { ok: false, error: 'booking not found' };
  return postZap(url, payload);
}

// ── IN ──
const pick = (o, keys) => { for (const k of keys) { const v = k.split('.').reduce((a, p) => (a == null ? a : a[p]), o); if (v != null && v !== '') return v; } return null; };
function toIso(v, tz) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) { const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toISOString() : null; }
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) { try { return zonedLocalToUtc(m[1], `${m[2].padStart(2, '0')}:${m[3]}:${m[4] || '00'}`, tz); } catch (_) {} }
  const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** One event from their system → LolaDesk's local busy time. */
export async function inboundEvent(c, tenant, body, { tz = 'America/New_York' } = {}) {
  const b = typeof body === 'string' ? (() => { try { return JSON.parse(body); } catch (_) { return {}; } })() : (body || {});
  const kind = String(pick(b, ['event', 'type', 'trigger', 'action']) || 'new').toLowerCase();
  const id = String(pick(b, ['id', 'appointment_id', 'appointmentId', 'appointment.id', 'node.id']) || '');
  if (!id) return { ok: false, error: 'missing appointment id' };
  const state = String(pick(b, ['state', 'status', 'appointment.state']) || '').toLowerCase();
  const cancelled = /cancel|delete|remove|no.?show/.test(kind) || /cancel/.test(state);
  if (cancelled) {
    await c.from('cached_availability').delete().eq('tenant_id', tenant.id).eq('provider', 'zapier').eq('external_booking_id', id);
    return { ok: true, action: 'freed', id };
  }
  const start = toIso(pick(b, ['start', 'starts_at', 'startAt', 'start_time', 'appointment.startAt']), tz);
  let end = toIso(pick(b, ['end', 'ends_at', 'endAt', 'end_time', 'appointment.endAt']), tz);
  const dur = Number(pick(b, ['duration', 'duration_min', 'duration_minutes']));
  if (!start) return { ok: false, error: 'missing start time' };
  if (!end) end = new Date(Date.parse(start) + (dur > 0 ? dur : 60) * 60e3).toISOString();
  if (Date.parse(end) <= Date.parse(start)) return { ok: false, error: 'end is before start' };
  const staffName = String(pick(b, ['staff', 'staff_name', 'stylist', 'provider', 'staff.name', 'staffName']) || '').trim();
  let staff = null;
  if (staffName) {
    try {
      const { data } = await c.from('staff').select('id,name').eq('tenant_id', tenant.id);
      const n = staffName.toLowerCase();
      const hit = (data || []).find((s) => String(s.name || '').toLowerCase() === n) || (data || []).find((s) => String(s.name || '').toLowerCase().split(' ')[0] === n.split(' ')[0]);
      if (hit) staff = 'local:' + hit.id;
    } catch (_) {}
  }
  const row = {
    tenant_id: tenant.id, provider: 'zapier', external_booking_id: id, starts_at: start, ends_at: end,
    duration_min: Math.round((Date.parse(end) - Date.parse(start)) / 60e3), staff_id: staff,
    service: String(pick(b, ['service', 'service_name', 'serviceName']) || '').slice(0, 80) || null,
    client_name: String(pick(b, ['client', 'client_name', 'clientName']) || '').slice(0, 80) || null,
    status: 'booked', last_synced_at: new Date().toISOString(),
  };
  const { error } = await c.from('cached_availability').upsert(row, { onConflict: 'tenant_id,provider,external_booking_id' });
  if (error) return { ok: false, error: error.message || String(error) };
  return { ok: true, action: /resched|update|move|change/.test(kind) ? 'moved' : 'blocked', id, staff_matched: !!staff };
}
