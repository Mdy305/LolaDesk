/**
 * api/calendar-owner.js — the salon OWNER's calendar (bookings.html).
 * ════════════════════════════════════════════════════════════════════
 * The public engine (api/calendar.js, availability-engine-v2) is strict on
 * purpose: grid times, staff hours, minimum notice, blocked time. The owner
 * at the front desk needs more: a walk-in right now, 10:10, yesterday's visit
 * entered after the fact, a stylist staying late. This endpoint gives the
 * owner that override WITHOUT loosening the public engine:
 *
 *   override:true  (owner/admin/manager only) → the ONLY hard stop is a real
 *                  double-booking of the same stylist (a LolaDesk booking or
 *                  an appointment on the salon's own platform). It comes back
 *                  as 409 {needs_confirmation:true}; resending with force:true
 *                  books it anyway. Blocked time, off-hours, off-grid and past
 *                  times book, with human `warnings` the UI shows.
 *   override:false → every occurrence/segment is validated by the availability
 *                  engine (same rules Lola and the widget follow).
 *
 * All times the browser sends are SALON-LOCAL {date:'YYYY-MM-DD', time:'HH:MM'}
 * and are converted here with zonedLocalToUtc on booking_settings.timezone, so
 * an owner travelling in Los Angeles books 2 PM New York, not 2 PM LA.
 *
 * Every query is scoped to the tenant resolved from the Bearer token.
 *
 * GET  ?action=external&from=YYYY-MM-DD&to=YYYY-MM-DD   platform appointments (read-only)
 * GET  ?action=context&date=YYYY-MM-DD&days=1..14        schedules, hours range, time off, external
 * GET  ?action=clients&q=ann                             client picker (name / phone)
 * GET  ?action=suggest&service_ids=a,b&date=…&staff_id=  free times for the picked services
 * POST {action:'book',   service_ids, staff_id, date, time, client_id|client_name|client_phone,
 *       notes, repeat:{rule,count}, override, force, notify}
 * POST {action:'move',   booking_id, date, time, staff_id?, duration_min?|end_time?,
 *       series_scope:'this'|'following', override, force}
 * POST {action:'status', booking_id, status}   confirmed|checked_in|in_progress|completed|no_show|cancelled
 */
import { randomUUID } from 'node:crypto';
import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantAccessForUser } from './lib/tenant-access.js';
import { db, upsertClient } from './lib/db.js';
import {
  createCanonicalBooking, updateCanonicalBooking, listServices, listStaff, getBookingSettings,
  getStaffSchedules, getStaffTimeOff, getBlockedSlots, sendConfirmationSMS
} from './lib/booking-repository.js';
import { getAvailability } from './lib/availability-engine-v2.js';
import { zonedLocalToUtc, localDateKey, localWeekday, dayBoundsUtc } from './lib/timezone.js';
import { bestStaffAt } from './lib/smart-slots.js';
import { writeThrough } from './lib/booking-outbox.js';
import { bookingGateResponse } from './lib/billing-gate.js';
import { requestDeposit } from './lib/deposits.js';
import { fmtSalon } from './lib/salon-time.js';

const OWNER_ROLES = new Set(['owner', 'admin', 'manager']);
export const OWNER_STATUSES = new Set(['confirmed', 'checked_in', 'in_progress', 'completed', 'no_show', 'cancelled']);
const INACTIVE = /^(cancel|no[-_ ]?show)/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2}(:\d{2})?$/;
const ms = (v) => new Date(v).getTime();
const addMin = (iso, m) => new Date(ms(iso) + Number(m || 0) * 60000).toISOString();

function jsonBody(req) {
  if (typeof req.body === 'string') { try { return JSON.parse(req.body || '{}'); } catch { return {}; } }
  return req.body || {};
}
function addDaysKey(key, n) { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
function addMonthsKey(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
}
function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5); }
const toMin = (t) => { if (!t) return null; const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const hhmm = (min) => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');

/** Salon-local {date, time:'HH:MM', min} for an instant. */
export function localParts(iso, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(iso)).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  const min = (Number(p.hour) % 24) * 60 + Number(p.minute);
  return { date: `${p.year}-${p.month}-${p.day}`, time: hhmm(min), min };
}

/** A service's real length (processing phases when present, else duration_minutes). */
export function serviceMinutes(s) {
  const a1 = Math.max(0, Number(s?.active_duration_1_min ?? 0)), p = Math.max(0, Number(s?.processing_duration_min ?? 0)), a2 = Math.max(0, Number(s?.active_duration_2_min ?? 0));
  if (a1 || p || a2) return a1 + p + a2;
  return Math.max(5, Number(s?.duration_minutes || 60));
}

/** Salon-local date+time → UTC instant (date/time win over starts_at). */
function resolveStart(body, tz, prefix = '') {
  const date = body[prefix + 'date'], time = body[prefix + 'time'];
  if (DATE_RE.test(String(date || '')) && TIME_RE.test(String(time || ''))) {
    const [h, m] = String(time).split(':').map(Number);
    if (h > 23 || m > 59) return null;
    return zonedLocalToUtc(String(date), hhmm(h * 60 + m) + ':00', tz);
  }
  const raw = body[prefix ? prefix + 'at' : 'starts_at'];
  if (raw) { const d = new Date(raw); if (!Number.isNaN(d.getTime())) return d.toISOString(); }
  return null;
}

/** The salon's own platform's appointments (Square, Vagaro, Boulevard…) in a window, stylist-mapped. */
export async function externalAppointments(c, tenantId, fromIso, toIso) {
  try {
    const { data, error } = await c.from('cached_availability').select('*')
      .eq('tenant_id', tenantId).lt('starts_at', toIso).gt('ends_at', fromIso);
    if (error || !data?.length) return [];
    const rows = data.filter((r) => !INACTIVE.test(String(r.status || '')));
    if (!rows.length) return [];
    // LolaDesk bookings already written upstream are not shown twice.
    const { data: ours } = await c.from('bookings').select('id,external_id').eq('tenant_id', tenantId).lt('start_time', toIso).gt('end_time', fromIso);
    const mine = new Set((ours || []).map((b) => b.external_id).filter(Boolean).map(String));
    const { data: maps } = await c.from('provider_mappings').select('provider,external_id,local_id').eq('tenant_id', tenantId).eq('entity_type', 'staff');
    const toLocal = new Map((maps || []).map((m) => [m.provider + ':' + m.external_id, m.local_id]));
    return rows.filter((r) => !mine.has(String(r.external_booking_id))).map((r) => {
      const sid = r.staff_id ? String(r.staff_id) : '';
      const staffId = sid.startsWith('local:') ? sid.slice(6) : (sid && toLocal.get(r.provider + ':' + sid)) || null;
      return { id: r.id || (r.provider + ':' + r.external_booking_id), provider: r.provider || 'external', external_booking_id: r.external_booking_id || null,
        starts_at: new Date(r.starts_at).toISOString(), ends_at: new Date(r.ends_at).toISOString(), staff_id: staffId, status: r.status || 'booked', read_only: true };
    });
  } catch (_) { return []; }
}

/** Real double-bookings of one stylist in [start,end) — LolaDesk rows + the salon platform's rows. */
export async function stylistClashes(c, tenantId, staffId, startIso, endIso, exclude = new Set()) {
  if (!staffId) return [];
  const { data } = await c.from('bookings').select('id,start_time,end_time,status,client_id,service_id')
    .eq('tenant_id', tenantId).eq('staff_id', staffId).lt('start_time', endIso).gt('end_time', startIso);
  const local = (data || []).filter((b) => !exclude.has(b.id) && !INACTIVE.test(String(b.status || '')) && ms(b.start_time) < ms(endIso) && ms(b.end_time) > ms(startIso))
    .map((b) => ({ id: b.id, kind: 'booking', start_time: b.start_time, end_time: b.end_time, client_id: b.client_id || null }));
  const ext = (await externalAppointments(c, tenantId, startIso, endIso)).filter((x) => x.staff_id === staffId)
    .map((x) => ({ id: x.id, kind: 'external', provider: x.provider, start_time: x.starts_at, end_time: x.ends_at }));
  return [...local, ...ext];
}

/** Things the owner should know but that never block an owner booking. */
async function softWarnings(tenantId, staff, startIso, endIso, tz) {
  const out = [];
  if (ms(startIso) < Date.now() - 5 * 60000) out.push('This time is in the past.');
  if (!staff) return out;
  const { date } = localParts(startIso, tz);
  const dow = localWeekday(new Date(startIso), tz);
  const [schedules, blocks, timeOff] = await Promise.all([
    getStaffSchedules(tenantId).catch(() => []), getBlockedSlots(tenantId, date).catch(() => []),
    getStaffTimeOff(tenantId, startIso, endIso).catch(() => [])
  ]);
  const sch = (schedules || []).find((x) => x.staff_id === staff.id && Number(x.day_of_week) === dow);
  const s = localParts(startIso, tz).min, e = s + Math.round((ms(endIso) - ms(startIso)) / 60000);
  if (!sch) out.push(`${staff.name || 'This stylist'} is not scheduled that day.`);
  else if (s < toMin(sch.start_time) || e > toMin(sch.end_time)) out.push(`Outside ${staff.name || 'the stylist'}'s hours (${String(sch.start_time).slice(0, 5)}–${String(sch.end_time).slice(0, 5)}).`);
  const bounds = dayBoundsUtc(date, tz);
  const hit = (blocks || []).find((b) => (!b.staff_id || b.staff_id === staff.id) &&
    ms(startIso) < ms(b.end_time ? zonedLocalToUtc(date, b.end_time, tz) : bounds.end) &&
    ms(b.start_time ? zonedLocalToUtc(date, b.start_time, tz) : bounds.start) < ms(endIso));
  if (hit) out.push(`During blocked time${hit.reason ? ' (' + hit.reason + ')' : ''}.`);
  if ((timeOff || []).some((x) => x.staff_id === staff.id)) out.push(`${staff.name || 'The stylist'} has time off then.`);
  return out;
}

/** Strict path: each service segment must be a real engine slot for this stylist. */
async function engineFits(tenantId, seq, staffId, startIso, excludeBookingId = null) {
  let at = startIso;
  for (const s of seq) {
    const av = await getAvailability({ tenantId, serviceId: s.id, date: at, staffId, limit: 5000, excludeBookingId });
    const hit = (av.slots || []).find((x) => x.staff_id === staffId && ms(x.starts_at) === ms(at));
    if (!hit) return { ok: false, service: s.name };
    at = hit.ends_at;
  }
  return { ok: true, end: at };
}

function clientLabel(cl) { return cl ? (cl.name || [cl.first_name, cl.last_name].filter(Boolean).join(' ') || 'Client') : 'Client'; }

async function describeClashes(c, tenantId, clashes, tz) {
  const ids = [...new Set(clashes.map((x) => x.client_id).filter(Boolean))];
  const { data: cls } = ids.length ? await c.from('clients').select('id,name,first_name,last_name').eq('tenant_id', tenantId).in('id', ids) : { data: [] };
  const byId = new Map((cls || []).map((x) => [x.id, x]));
  return clashes.map((x) => ({ ...x, label: (x.kind === 'external' ? (x.provider || 'Platform') + ' appointment' : clientLabel(byId.get(x.client_id))) + ' · ' + fmtSalon(x.start_time, tz, 'time') + '–' + fmtSalon(x.end_time, tz, 'time') }));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const c = db();
  if (!c) return res.status(503).json({ ok: false, error: 'Database not configured' });
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'Not authenticated' });
    const access = await resolveTenantAccessForUser(user);
    const tenant = access?.tenant;
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'Salon not found' });
    const T = tenant.id;
    const isOwner = OWNER_ROLES.has(String(access.role || 'owner'));
    const body = { ...(req.query || {}), ...jsonBody(req) };
    const action = String(body.action || '');
    const settings = (await getBookingSettings(T)) || {};
    const tz = settings.timezone || 'America/New_York';

    // ── Platform appointments, read-only, for a date range ──
    if (action === 'external') {
      const from = DATE_RE.test(String(body.from || body.date || '')) ? String(body.from || body.date) : localDateKey(new Date(), tz);
      let to = DATE_RE.test(String(body.to || '')) ? String(body.to) : from;
      if (to < from) to = from;
      if (daysBetween(from, to) > 31) to = addDaysKey(from, 31);
      const start = zonedLocalToUtc(from, '00:00:00', tz), end = zonedLocalToUtc(addDaysKey(to, 1), '00:00:00', tz);
      return res.json({ ok: true, timezone: tz, from, to, appointments: await externalAppointments(c, T, start, end) });
    }

    // ── Everything the grid needs besides bookings: hours range, schedules, time off, platform rows ──
    if (action === 'context') {
      const date = DATE_RE.test(String(body.date || '')) ? String(body.date) : localDateKey(new Date(), tz);
      const days = Math.max(1, Math.min(14, Number(body.days || 1)));
      const start = zonedLocalToUtc(date, '00:00:00', tz), end = zonedLocalToUtc(addDaysKey(date, days), '00:00:00', tz);
      const [staff, schedules, timeOff, external] = await Promise.all([
        listStaff(T), getStaffSchedules(T).catch(() => []), getStaffTimeOff(T, start, end).catch(() => []), externalAppointments(c, T, start, end)]);
      const active = new Set(staff.map((s) => s.id));
      const sch = (schedules || []).filter((s) => active.has(s.staff_id)).map((s) => ({ staff_id: s.staff_id, day_of_week: Number(s.day_of_week), start_time: String(s.start_time || '').slice(0, 5), end_time: String(s.end_time || '').slice(0, 5) }));
      const starts = sch.map((s) => toMin(s.start_time)).filter((x) => x != null), ends = sch.map((s) => toMin(s.end_time)).filter((x) => x != null);
      const hours = starts.length ? { start_min: Math.min(...starts), end_min: Math.max(...ends) } : { start_min: 8 * 60, end_min: 21 * 60 };
      return res.json({ ok: true, timezone: tz, date, days, hours, schedules: sch,
        time_off: (timeOff || []).map((x) => ({ staff_id: x.staff_id, start_time: x.start_time, end_time: x.end_time, reason: x.reason || null })), external,
        deposits_enabled: !!settings?.metadata?.deposits?.enabled, role: access.role || 'owner', can_override: isOwner });
    }

    // ── Client picker ──
    if (action === 'clients') {
      const q = String(body.q || '').replace(/[,()%*\\]/g, ' ').trim().slice(0, 60);
      if (q.length < 2) return res.json({ ok: true, clients: [] });
      const digits = q.replace(/\D/g, '');
      let query = c.from('clients').select('id,name,first_name,last_name,phone,email,is_vip').eq('tenant_id', T);
      const ors = [`first_name.ilike.%${q}%`, `last_name.ilike.%${q}%`, `name.ilike.%${q}%`];
      if (digits.length >= 3) ors.push(`phone.ilike.%${digits}%`);
      query = query.or(ors.join(','));
      const { data } = await query.limit(200);
      const needle = q.toLowerCase();
      const hits = (data || []).filter((x) => {
        const nm = clientLabel(x).toLowerCase();
        const ph = String(x.phone || '').replace(/\D/g, '');
        return nm.includes(needle) || (digits.length >= 3 && ph.includes(digits));
      }).filter((x) => !String(x.phone || '').startsWith('web:') || clientLabel(x) !== 'Website visitor')
        .slice(0, 12).map((x) => ({ id: x.id, name: clientLabel(x), phone: String(x.phone || '').includes(':') ? '' : (x.phone || ''), email: x.email || '', is_vip: !!x.is_vip }));
      return res.json({ ok: true, clients: hits });
    }

    // ── Suggested free times for the picked services (whole chain must fit) ──
    if (action === 'suggest') {
      const ids = String(body.service_ids || body.service_id || '').split(',').map((x) => x.trim()).filter(Boolean);
      const services = await listServices(T);
      const seq = ids.map((id) => services.find((s) => s.id === id)).filter(Boolean);
      if (!seq.length) return res.status(400).json({ ok: false, error: 'service required' });
      const date = DATE_RE.test(String(body.date || '')) ? String(body.date) : localDateKey(new Date(), tz);
      const staffId = body.staff_id || null;
      const av = await getAvailability({ tenantId: T, serviceId: seq[0].id, date, staffId, limit: 5000 });
      const out = [], seen = new Set();
      for (const slot of av.slots || []) {
        if (out.length >= 8) break;
        const key = slot.starts_at + '|' + slot.staff_id;
        if (seen.has(key)) continue; seen.add(key);
        if (staffId == null && out.some((o) => o.starts_at === slot.starts_at)) continue; // one stylist per time
        if (seq.length > 1 && !(await engineFits(T, seq, slot.staff_id, slot.starts_at)).ok) continue;
        const lp = localParts(slot.starts_at, tz);
        out.push({ starts_at: slot.starts_at, date: lp.date, time: lp.time, label: fmtSalon(slot.starts_at, tz, 'time'), staff_id: slot.staff_id, staff_name: slot.staff_name });
      }
      return res.json({ ok: true, timezone: tz, date, slots: out });
    }

    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });

    // ── Status: always through the canonical update (history, fee void on no-show/cancel) ──
    if (action === 'status') {
      const status = String(body.status || '').toLowerCase();
      if (!OWNER_STATUSES.has(status)) return res.status(400).json({ ok: false, error: 'Invalid status. Use one of: ' + [...OWNER_STATUSES].join(', ') });
      const { data: before } = await c.from('bookings').select('*').eq('tenant_id', T).eq('id', body.booking_id || body.id || '').maybeSingle();
      if (!before) return res.status(404).json({ ok: false, error: 'Booking not found' });
      if (before.status === status) return res.json({ ok: true, booking: before, unchanged: true });
      const updated = await updateCanonicalBooking(T, before.id, { status }, { source: 'dashboard', reason: body.reason || 'owner_' + status });
      if (!updated) return res.status(404).json({ ok: false, error: 'Booking not found' });
      // Pending → confirmed is the moment the client is told (and asked for a deposit if the salon requires one).
      if (status === 'confirmed' && String(before.status) === 'pending' && ms(before.start_time) > Date.now()) {
        sendConfirmationSMS({ tenantId: T, clientId: before.client_id, serviceId: before.service_id, startTime: before.start_time, confirmationCode: before.confirmation_code, verb: 'Booked' }).catch(() => {});
        requestDeposit({ tenantId: T, booking: updated }).catch(() => {});
      }
      if (status === 'completed') {
        import('./lib/rebooking.js').then(({ offerRebooking }) => offerRebooking({ tenantId: T, booking: { ...updated, completed_at: updated.updated_at || new Date().toISOString() } })).catch(() => {});
      }
      return res.json({ ok: true, booking: updated });
    }

    const override = body.override === true && isOwner;
    const force = body.force === true;
    if (body.override === true && !isOwner) return res.status(403).json({ ok: false, error: 'Only the salon owner or a manager can override the booking rules.' });

    // ── Create (single, multi-service, recurring, walk-in) ──
    if (action === 'book') {
      const gate = bookingGateResponse(tenant, 'operator');
      if (gate) return res.status(402).json({ ...gate, error: gate.speak });
      const ids = (Array.isArray(body.service_ids) ? body.service_ids : String(body.service_ids || body.service_id || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
      const services = await listServices(T, { activeOnly: false });
      const seq = ids.map((id) => services.find((s) => s.id === id));
      if (!seq.length || seq.some((s) => !s)) return res.status(400).json({ ok: false, error: 'Pick at least one service.' });
      const startIso = resolveStart(body, tz);
      if (!startIso) return res.status(400).json({ ok: false, error: 'Pick a valid date and time.' });
      const total = seq.reduce((t, s) => t + serviceMinutes(s), 0);
      const price = seq.reduce((t, s) => t + Number(s.price || 0), 0);
      const staffList = await listStaff(T, { activeOnly: false });

      let clientId = null;
      if (body.client_id) {
        const { data: cl } = await c.from('clients').select('id').eq('tenant_id', T).eq('id', body.client_id).maybeSingle();
        if (!cl) return res.status(404).json({ ok: false, error: 'Client not found' });
        clientId = cl.id;
      }

      let staffId = body.staff_id || null;
      if (staffId && !staffList.some((s) => s.id === staffId)) return res.status(404).json({ ok: false, error: 'Stylist not found' });
      if (!staffId && !override) {
        const best = await bestStaffAt({ tenantId: T, serviceId: seq[0].id, startsAt: startIso, clientId });
        staffId = best?.staff_id || null;
        if (!staffId) return res.status(409).json({ ok: false, conflict: true, error: 'Nobody is free at that time.' });
      }
      const staff = staffList.find((s) => s.id === staffId) || null;

      // Occurrences: same salon-local wall time on every date (DST-safe).
      const rule = String(body.repeat?.rule || '').toLowerCase();
      const count = ['weekly', 'biweekly', 'monthly'].includes(rule) ? Math.min(52, Math.max(1, parseInt(body.repeat?.count, 10) || 1)) : 1;
      const lp = localParts(startIso, tz);
      const occ = [];
      for (let n = 0; n < count; n++) {
        const key = rule === 'monthly' ? addMonthsKey(lp.date, n) : addDaysKey(lp.date, (rule === 'biweekly' ? 14 : 7) * n);
        const s = n === 0 ? startIso : zonedLocalToUtc(key, lp.time + ':00', tz);
        occ.push({ n: n + 1, date: key, start: s, end: addMin(s, total) });
      }

      const problems = [], warnings = [];
      for (const o of occ) {
        if (override) {
          const clash = await stylistClashes(c, T, staffId, o.start, o.end);
          if (clash.length) problems.push({ occurrence: o.n, date: o.date, starts_at: o.start, kind: 'double_booked', with: await describeClashes(c, T, clash, tz) });
          for (const w of await softWarnings(T, staff, o.start, o.end, tz)) warnings.push(count > 1 ? `${o.date}: ${w}` : w);
        } else {
          const fit = await engineFits(T, seq, staffId, o.start);
          if (!fit.ok) problems.push({ occurrence: o.n, date: o.date, starts_at: o.start, kind: 'unavailable', service: fit.service });
        }
      }
      const blocking = problems.filter((p) => !(override && force && p.kind === 'double_booked'));
      if (blocking.length) {
        const first = blocking[0];
        const who = staff?.name || 'This stylist';
        const msg = first.kind === 'double_booked'
          ? `${who} is already booked then${first.with?.[0] ? ' — ' + first.with[0].label : ''}${blocking.length > 1 ? ` (and ${blocking.length - 1} more date${blocking.length > 2 ? 's' : ''})` : ''}.`
          : `${count > 1 ? `Occurrence ${first.occurrence} (${first.date}): ` : ''}${who} isn't available for ${first.service || 'that service'} at that time.`;
        return res.status(409).json({ ok: false, conflict: true, needs_confirmation: override && blocking.every((p) => p.kind === 'double_booked'), conflicts: blocking, error: msg, created_count: 0 });
      }

      if (!clientId) {
        const name = String(body.client_name || '').trim() || (body.walk_in ? 'Walk-in' : '');
        const phone = String(body.client_phone || '').trim();
        if (name || phone) clientId = (await upsertClient(T, { phone: phone || null, name: name || 'Client' }))?.id || null;
      }
      const notify = body.notify !== false && !body.walk_in;
      const seriesId = count > 1 ? randomUUID() : null;
      const created = [];
      for (const o of occ) {
        const booking = await createCanonicalBooking({
          tenantId: T, clientId, serviceId: seq[0].id, staffId, startTime: o.start, endTime: o.end,
          status: 'confirmed', totalAmount: price, notes: body.notes || null, source: 'dashboard',
          sendConfirmation: notify && o.n === 1, // one text (and one deposit request) per series
          series: seriesId ? { id: seriesId, pos: o.n, total: count, rule } : null
        });
        created.push(booking);
        if (seq.length > 1) {
          for (const [i, s] of seq.entries()) {
            const phased = Number(s.active_duration_1_min || 0) || Number(s.processing_duration_min || 0);
            const { error: lineErr } = await c.from('booking_services').insert({ booking_id: booking.id, service_id: s.id, staff_id: staffId, sequence_no: i + 1,
              active_duration_1_min: phased ? Number(s.active_duration_1_min || 0) : serviceMinutes(s),
              processing_duration_min: phased ? Number(s.processing_duration_min || 0) : 0,
              active_duration_2_min: phased ? Number(s.active_duration_2_min || 0) : 0, price: Number(s.price || 0) });
            if (lineErr) console.warn('[calendar-owner] booking_services', lineErr.message || lineErr);
          }
        }
        try {
          await writeThrough(c, { tenantId: T, booking, ctx: {
            client: { id: clientId, name: body.client_name || null, phone: body.client_phone || null },
            service: { id: seq[0].id, name: seq.map((s) => s.name).join(' + ') }, staff: { id: staffId },
            startsAt: o.start, endsAt: o.end, durationMin: total, price, timezone: tz, notes: body.notes || 'Booked from the LolaDesk calendar' } });
        } catch (_) { /* the outbox never fails a booking */ }
      }
      return res.json({ ok: true, booking: created[0], booking_id: created[0].id, bookings: created.map((b) => b.id), warnings,
        series: seriesId ? { id: seriesId, total: count, rule, sms_sent: notify ? 1 : 0 } : null, forced: override && force && problems.length > 0 });
    }

    // ── Move / resize (drag on the grid, Reschedule sheet) — status is kept as-is ──
    if (action === 'move') {
      const { data: cur } = await c.from('bookings').select('*').eq('tenant_id', T).eq('id', body.booking_id || body.id || '').maybeSingle();
      if (!cur) return res.status(404).json({ ok: false, error: 'Booking not found' });
      if (INACTIVE.test(String(cur.status || '')) && String(cur.status).startsWith('cancel')) return res.status(409).json({ ok: false, error: 'A cancelled appointment cannot be moved.' });
      const startIso = resolveStart(body, tz) || cur.start_time;
      const oldLen = Math.max(5, Math.round((ms(cur.end_time) - ms(cur.start_time)) / 60000) || 60);
      let len = oldLen;
      if (Number(body.duration_min) > 0) len = Math.round(Number(body.duration_min));
      else if (body.end_time && TIME_RE.test(String(body.end_time))) {
        const sl = localParts(startIso, tz);
        len = toMin(body.end_time) - sl.min;
      }
      if (!(len >= 5 && len <= 16 * 60)) return res.status(400).json({ ok: false, error: 'The end time must be after the start.' });
      const endIso = addMin(startIso, len);
      const staffId = body.staff_id === undefined ? cur.staff_id : (body.staff_id || null);
      const staffList = await listStaff(T, { activeOnly: false });
      if (staffId && !staffList.some((s) => s.id === staffId)) return res.status(404).json({ ok: false, error: 'Stylist not found' });
      const staff = staffList.find((s) => s.id === staffId) || null;

      // series_scope 'following' moves this + later occurrences by the same salon-local shift.
      const scope = String(body.series_scope || 'this').toLowerCase();
      const plan = [{ id: cur.id, start: startIso, end: endIso, staff_id: staffId, pos: cur.series_pos || 1, service_id: cur.service_id }];
      if (scope === 'following' && cur.series_id) {
        const a = localParts(cur.start_time, tz), b = localParts(startIso, tz);
        const dDays = daysBetween(a.date, b.date), dMin = b.min - a.min;
        const { data: later } = await c.from('bookings').select('*').eq('tenant_id', T).eq('series_id', cur.series_id).gt('start_time', cur.start_time).order('start_time');
        for (const o of (later || []).filter((x) => !INACTIVE.test(String(x.status || '')))) {
          const p = localParts(o.start_time, tz);
          let m = p.min + dMin, key = addDaysKey(p.date, dDays);
          while (m < 0) { m += 1440; key = addDaysKey(key, -1); }
          while (m >= 1440) { m -= 1440; key = addDaysKey(key, 1); }
          const s = zonedLocalToUtc(key, hhmm(m) + ':00', tz);
          const olen = Math.round((ms(o.end_time) - ms(o.start_time)) / 60000) || oldLen;
          plan.push({ id: o.id, start: s, end: addMin(s, olen + (len - oldLen)), staff_id: body.staff_id === undefined ? o.staff_id : staffId, pos: o.series_pos || null, service_id: o.service_id });
        }
      }
      const moving = new Set(plan.map((p) => p.id));
      const problems = [], warnings = [];
      const allServices = override ? [] : await listServices(T, { activeOnly: false });
      for (const p of plan) {
        if (override) {
          const clash = await stylistClashes(c, T, p.staff_id, p.start, p.end, moving);
          if (clash.length) problems.push({ occurrence: p.pos, booking_id: p.id, starts_at: p.start, kind: 'double_booked', with: await describeClashes(c, T, clash, tz) });
          if (p.id === cur.id) warnings.push(...await softWarnings(T, staffList.find((s) => s.id === p.staff_id) || null, p.start, p.end, tz));
        } else {
          const svc = allServices.find((s) => s.id === p.service_id);
          const fit = svc && p.staff_id ? await engineFits(T, [svc], p.staff_id, p.start, p.id) : { ok: false };
          const tailFree = fit.ok && (ms(fit.end) >= ms(p.end) || !(await stylistClashes(c, T, p.staff_id, fit.end, p.end, moving)).length);
          if (!fit.ok || !tailFree) problems.push({ occurrence: p.pos, booking_id: p.id, starts_at: p.start, kind: 'unavailable' });
        }
      }
      const blocking = problems.filter((p) => !(override && force && p.kind === 'double_booked'));
      if (blocking.length) {
        const f = blocking[0];
        return res.status(409).json({ ok: false, conflict: true, needs_confirmation: override && blocking.every((p) => p.kind === 'double_booked'), conflicts: blocking, moved_count: 0,
          error: f.kind === 'double_booked' ? `${staff?.name || 'That stylist'} is already booked then${f.with?.[0] ? ' — ' + f.with[0].label : ''}.` : 'That time isn\'t available — nothing was moved.' });
      }
      let moved = null;
      for (const p of plan) {
        const u = await updateCanonicalBooking(T, p.id, { start_time: p.start, end_time: p.end, staff_id: p.staff_id }, { source: 'dashboard', reason: 'owner_moved' });
        if (p.id === cur.id) moved = u;
      }
      if (ms(startIso) !== ms(cur.start_time) || staffId !== cur.staff_id) {
        import('./lib/booking-reminders.js').then(({ offerFreedSlot }) => offerFreedSlot({ tenantId: T, serviceId: cur.service_id || null, freedAt: cur.start_time })).catch(() => {});
      }
      return res.json({ ok: true, booking: moved, moved_count: plan.length, series_moved: plan.length - 1, warnings });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action: ' + action });
  } catch (e) {
    console.error('[calendar-owner]', e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
