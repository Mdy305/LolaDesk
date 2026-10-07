/**
 * api/lib/operator-db.js — Data layer for the owner-facing "Jarvis" assistant.
 * ════════════════════════════════════════════════════════════════════════
 * These operations are PRIVILEGED: read the schedule, move/cancel bookings,
 * compute revenue, surface clients due for rebooking, and pull the roster
 * for a broadcast. Everything is scoped to a single tenant (one salon).
 *
 * Two pieces of security machinery live here too:
 *   - the owner gate (caller-ID soft signal + hashed PIN), and
 *   - stateless HMAC-signed confirmation tokens, so a destructive action can
 *     be previewed and then confirmed across two webhook calls without us
 *     keeping any server-side pending-action state.
 *
 * ENV: SUPABASE_URL, SUPABASE_SERVICE_KEY (via db.js), OPERATOR_TOOLS_SECRET
 */
import { derivedSecret } from './derived-secret.js';
import crypto from 'node:crypto';
import { db, e164 } from './db.js';
import { salonTz } from './salon-time.js';
import { localDateKey, localWeekday, dayBoundsUtc, zonedLocalToUtc } from './timezone.js';

// ── small date helpers ───────────────────────────────────────────────────
// Days are SALON-local (Vercel runs in UTC: server-local midnight is the
// salon's 8 PM the evening before).
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
function addDaysKey(key, n){ const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
function dayKeyOf(v, tz){
  if(v == null) return localDateKey(new Date(), tz);
  if(typeof v === 'string' && DATE_KEY.test(v)) return v;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? localDateKey(new Date(), tz) : localDateKey(d, tz);
}
async function salonRange(tenantId, from, to, tz){
  const zone = tz || await salonTz(tenantId);
  const fKey = dayKeyOf(from, zone), tKey = dayKeyOf(to ?? from, zone);
  return { tz: zone, start: dayBoundsUtc(fKey, zone).start, end: dayBoundsUtc(tKey, zone).end };
}

// Parse a loose phrase the assistant might pass: "today" | "tomorrow" | ISO date.
// (Server-clock Date; kept for older callers — new code uses resolveDateKey.)
export function resolveDate(phrase){
  if(!phrase) return new Date();
  const p = String(phrase).trim().toLowerCase();
  const now = new Date();
  if(p === 'today') return now;
  if(p === 'tomorrow'){ const t = new Date(now); t.setDate(t.getDate() + 1); return t; }
  if(p === 'day after tomorrow'){ const t = new Date(now); t.setDate(t.getDate() + 2); return t; }

  // "in N days"
  const inDays = p.match(/^in\s+(\d+)\s+days?$/);
  if(inDays){ const t = new Date(now); t.setDate(t.getDate() + parseInt(inDays[1], 10)); return t; }

  // weekday names, optionally prefixed with this / next / coming
  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const wd = p.match(/^(?:(this|next|coming)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/);
  if(wd){
    const mod = wd[1];
    const target = days.indexOf(wd[2]);
    const t = new Date(now);
    let delta = (target - t.getDay() + 7) % 7;
    if(delta === 0) delta = 7;       // a bare weekday that equals today -> next occurrence
    if(mod === 'next') delta += 7;   // "next friday" -> the following week
    t.setDate(t.getDate() + delta);
    return t;
  }

  if(p === 'next week'){ const t = new Date(now); t.setDate(t.getDate() + 7); return t; }

  const d = new Date(phrase);
  return isNaN(d) ? now : d;
}

/**
 * The same phrases, answered as a SALON-local calendar date "YYYY-MM-DD".
 * "tomorrow" at 9 PM in Miami is the salon's tomorrow — not UTC's day after.
 * Returns null for a phrase that isn't a date (never silently "today").
 */
export function resolveDateKey(phrase, tz = 'America/New_York', now = new Date()){
  const today = localDateKey(now, tz);
  if(phrase == null || String(phrase).trim() === '') return today;
  const p = String(phrase).trim().toLowerCase();
  if(DATE_KEY.test(p)) return p;
  if(p === 'today' || p === 'tonight') return today;
  if(p === 'tomorrow') return addDaysKey(today, 1);
  if(p === 'day after tomorrow') return addDaysKey(today, 2);
  const inDays = p.match(/^in\s+(\d+)\s+days?$/);
  if(inDays) return addDaysKey(today, parseInt(inDays[1], 10));
  if(p === 'next week') return addDaysKey(today, 7);
  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const wd = p.match(/^(?:(this|next|coming)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/);
  if(wd){
    const cur = localWeekday(now, tz);
    let delta = (days.indexOf(wd[2]) - cur + 7) % 7;
    if(delta === 0) delta = 7;
    if(wd[1] === 'next') delta += 7;
    return addDaysKey(today, delta);
  }
  const d = new Date(phrase);
  if(Number.isNaN(d.getTime())) return null;
  // An ISO instant → its salon-local date; a bare "Oct 9" parses as local midnight.
  return /\d{1,2}:\d{2}|T\d/.test(String(phrase)) ? localDateKey(d, tz)
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// "2:00 PM" | "14:00" | "3pm" | "noon" -> "HH:MM:00"; null when there is no time
// (a missing time is a question for the caller, never a silent 10 AM).
export function to24(t){
  if(t == null || String(t).trim() === '') return null;
  const v = String(t).trim().toLowerCase();
  if(v === 'noon' || v === 'midday') return '12:00:00';
  if(v === 'midnight') return '00:00:00';
  if(/^\d{1,2}:\d{2}$/.test(v)){ const [h, m] = v.split(':').map(Number); return h < 24 && m < 60 ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00` : null; }
  const m = v.match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|am|pm)?$/i) || v.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if(!m) return null;
  let h = +m[1]; const min = m[2] || '00'; const ap = (m[3] || '').replace(/\./g, '').toLowerCase();
  if(h > 23 || +min > 59) return null;
  if(ap === 'pm' && h < 12) h += 12;
  if(ap === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${min}:00`;
}

/**
 * Salon-local date + time → UTC ISO. Missing/unparseable time → null.
 * dateKey may be a phrase ("tomorrow", "friday") or "YYYY-MM-DD".
 */
export function salonInstant(datePhrase, timeText, tz = 'America/New_York', now = new Date()){
  const hhmm = to24(timeText);
  if(!hhmm) return null;
  const key = resolveDateKey(datePhrase, tz, now);
  if(!key) return null;
  return zonedLocalToUtc(key, hhmm, tz);
}

// Given the original booking time + the requested new date/time, produce an ISO
// string in the SALON's timezone. No new time → null (ask; never guess a time).
// A new time with no new date keeps the booking's own salon-local day.
export function computeNewStart(currentIso, { new_date, new_time } = {}, tz = 'America/New_York', now = new Date()){
  if(!new_time) return null;
  const key = new_date ? resolveDateKey(new_date, tz, now) : localDateKey(new Date(currentIso), tz);
  if(!key) return null;
  const hhmm = to24(new_time);
  return hhmm ? zonedLocalToUtc(key, hhmm, tz) : null;
}

// ── owner gate ───────────────────────────────────────────────────────────
export function hashPin(pin){
  return crypto.createHash('sha256').update(String(pin || '').trim()).digest('hex');
}
// Caller ID is spoofable, so this is only a soft signal for the spoken UX.
export function isKnownOperator(tenant, fromPhone){
  if(!tenant?.operator_phone || !fromPhone) return false;
  return e164(tenant.operator_phone) === e164(fromPhone);
}
// The real authorization for any destructive action.
export function pinOk(tenant, pin){
  if(!tenant?.operator_pin_hash) return false; // no PIN set => destructive actions disabled
  return hashPin(pin) === tenant.operator_pin_hash;
}
export async function setOperatorPin(tenantId, pin){
  const c = db(); if(!c) return null;
  const { data } = await c.from('tenants')
    .update({ operator_pin_hash: hashPin(pin) })
    .eq('id', tenantId).select('id').maybeSingle();
  return data;
}

// ── stateless confirmation tokens (HMAC) ─────────────────────────────────
// OPERATOR_TOOLS_SECRET when set (unchanged); otherwise a secret derived from the server key — never a string in the source.
function secret(){ return process.env.OPERATOR_TOOLS_SECRET || derivedSecret('operator-tools') || crypto.randomBytes(32).toString('hex'); }

// Per-tenant tool secret: derived from the master so each salon's webhook
// header is unique. A leaked header only works for that one tenant.
export function tenantToolSecret(slug){
  return crypto.createHmac('sha256', secret()).update('operator-tool:' + String(slug || '')).digest('hex');
}
export function signAction(payload, ttlSec = 300){
  const body = { ...payload, exp: Date.now() + ttlSec * 1000 };
  const data = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(data).digest('base64url');
  return `${data}.${sig}`;
}
export function verifyAction(token){
  try{
    const [data, sig] = String(token).split('.');
    if(!data || !sig) return null;
    const expect = crypto.createHmac('sha256', secret()).update(data).digest('base64url');
    // constant-time compare
    if(sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const body = JSON.parse(Buffer.from(data, 'base64url').toString());
    if(Date.now() > body.exp) return null;
    return body;
  }catch{ return null; }
}

// ── tenant ───────────────────────────────────────────────────────────────
export async function getTenantById(tenantId){
  const c = db(); if(!c) return null;
  const { data } = await c.from('tenants').select('*').eq('id', tenantId).maybeSingle();
  return data;
}

// ── schedule ──────────────────────────────────────────────────────────────
export async function listBookings(tenantId, { from, to, limit = 25, tz = null } = {}){
  const c = db(); if(!c) return [];
  const r = await salonRange(tenantId, from, to, tz);
  const { data } = await c.from('bookings')
    .select('id, service:services(name), stylist:staff(name), starts_at:start_time, end_time, price:total_amount, status, client_id, external_source:external_provider')
    .eq('tenant_id', tenantId)
    .gte('start_time', r.start).lt('start_time', r.end)
    .neq('status', 'cancelled')
    .order('start_time', { ascending: true })
    .limit(limit);
  return (data || []).map(b0 => { const b = { ...b0, starts_at: b0.starts_at || b0.start_time };
    return { ...b, service: b.service?.name || b.service || null, stylist: b.stylist?.name || b.stylist || null, duration_min: b.starts_at ? Math.max(0, Math.round((new Date(b.end_time || b.starts_at).getTime() - new Date(b.starts_at).getTime()) / 60000)) : null }; });
}

// Attach client name + phone to a set of booking rows.
export async function enrichBookings(tenantId, rows){
  const c = db(); if(!c || !rows?.length) return rows || [];
  const ids = [...new Set(rows.map(r => r.client_id).filter(Boolean))];
  if(!ids.length) return rows.map(r => ({ ...r, client_name: null, client_phone: null }));
  const { data } = await c.from('clients').select('id, name, phone_number').in('id', ids);
  const map = Object.fromEntries((data || []).map(cl => [cl.id, cl]));
  return rows.map(r => ({
    ...r,
    client_name: map[r.client_id]?.name || null,
    client_phone: map[r.client_id]?.phone_number || null
  }));
}

// Resolve a booking from a loose description (client name and/or hour-of-day),
// on the salon-local day, matching the hour in the salon's timezone.
export async function findBooking(tenantId, { client_name, date, time } = {}, tz = null){
  const zone = tz || await salonTz(tenantId);
  const day = resolveDateKey(date, zone) || localDateKey(new Date(), zone);
  let rows = await enrichBookings(tenantId, await listBookings(tenantId, { from: day, to: day, limit: 50, tz: zone }));
  const hhmm = to24(time);
  if(hhmm){
    const hour = parseInt(hhmm.slice(0, 2), 10);
    const hourOf = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? -1 : Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(d)); };
    rows = rows.filter(b => hourOf(b.starts_at) === hour);
  }
  if(client_name){
    const q = String(client_name).toLowerCase();
    rows = rows.filter(b => (b.client_name || '').toLowerCase().includes(q));
  }
  return rows;
}

// Owner-line cancel/move go through the canonical repository (status history,
// client text, upstream cancel/update, fee void) — never a bare row write.
export async function cancelBooking(tenantId, bookingId, { source = 'operator', reason = 'owner_request' } = {}){
  const { updateCanonicalBooking } = await import('./booking-repository.js');
  return updateCanonicalBooking(tenantId, bookingId, { status: 'cancelled' }, { source, reason });
}

export async function moveBooking(tenantId, bookingId, newStartsAt, { source = 'operator' } = {}){
  const c = db(); if(!c) return null;
  const { data: cur } = await c.from('bookings').select('start_time,end_time').eq('tenant_id', tenantId).eq('id', bookingId).maybeSingle();
  if(!cur) return null;
  const start = new Date(newStartsAt).toISOString();
  const len = cur.end_time ? new Date(cur.end_time).getTime() - new Date(cur.start_time).getTime() : null;   // keep its real length
  const { updateCanonicalBooking } = await import('./booking-repository.js');
  return updateCanonicalBooking(tenantId, bookingId, { start_time: start, ...(len > 0 ? { end_time: new Date(new Date(start).getTime() + len).toISOString() } : {}) }, { source, reason: 'rescheduled' });
}

// ── revenue ────────────────────────────────────────────────────────────────
export async function revenueSummary(tenantId, { from, to, tz = null } = {}){
  const c = db(); if(!c) return { total: 0, count: 0 };
  const r = await salonRange(tenantId, from, to, tz);
  const { data } = await c.from('bookings')
    .select('price:total_amount, status')
    .eq('tenant_id', tenantId)
    .gte('start_time', r.start).lt('start_time', r.end)
    .in('status', ['confirmed', 'completed']);
  const rows = data || [];
  const total = rows.reduce((s, r) => s + (Number(r.price) || 0), 0);
  return { total, count: rows.length };
}

// ── rebooking + broadcast audience ───────────────────────────────────────
export async function dueForRebooking(tenantId, { sinceDays = 42, limit = 25 } = {}){
  const c = db(); if(!c) return [];
  const cutoff = new Date(Date.now() - sinceDays * 864e5).toISOString().slice(0, 10);
  const { data } = await c.from('clients')
    .select('id, name, phone_number, last_service, last_visit, is_vip')
    .eq('tenant_id', tenantId)
    .eq('opted_out', false)
    .not('last_visit', 'is', null)
    .lte('last_visit', cutoff)
    .order('last_visit', { ascending: true })
    .limit(limit);
  return data || [];
}

// segment: 'all' | 'vip' | 'due'. Opted-out and number-less clients are always excluded.
export async function broadcastAudience(tenantId, { segment = 'all', limit = 500 } = {}){
  const c = db(); if(!c) return [];
  let q = c.from('clients')
    .select('id, name, phone_number, is_vip, last_visit')
    .eq('tenant_id', tenantId)
    .eq('opted_out', false)
    .not('phone_number', 'is', null);
  if(segment === 'vip') q = q.eq('is_vip', true);
  if(segment === 'due') q = q.lte('last_visit', new Date(Date.now() - 42 * 864e5).toISOString().slice(0, 10));
  const { data } = await q.limit(limit);
  return data || [];
}
