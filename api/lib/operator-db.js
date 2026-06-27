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
import crypto from 'node:crypto';
import { db, e164 } from './db.js';

// ── small date helpers ───────────────────────────────────────────────────
function startOfDay(d){ const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function endOfDay(d){ const x = new Date(d); x.setHours(23, 59, 59, 999); return x; }

// Parse a loose phrase the assistant might pass: "today" | "tomorrow" | ISO date.
export function resolveDate(phrase){
  if(!phrase) return new Date();
  const p = String(phrase).trim().toLowerCase();
  const now = new Date();
  if(p === 'today') return now;
  if(p === 'tomorrow'){ const t = new Date(now); t.setDate(t.getDate() + 1); return t; }
  const d = new Date(phrase);
  return isNaN(d) ? now : d;
}

// "2:00 PM" | "14:00" | "3pm" -> "HH:MM:00"
export function to24(t){
  if(!t) return '10:00:00';
  if(/^\d{1,2}:\d{2}$/.test(t)) return t + ':00';
  const m = String(t).match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if(!m) return '10:00:00';
  let h = +m[1]; const min = m[2] || '00'; const ap = (m[3] || '').toLowerCase();
  if(ap === 'pm' && h < 12) h += 12;
  if(ap === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${min}:00`;
}

// Given the original booking time + the requested new date/time, produce an ISO string.
export function computeNewStart(currentIso, { new_date, new_time } = {}){
  const base = new_date ? resolveDate(new_date) : new Date(currentIso);
  if(new_time){
    const [h, m] = to24(new_time).split(':');
    base.setHours(+h, +m, 0, 0);
  }
  return base.toISOString();
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
function secret(){ return process.env.OPERATOR_TOOLS_SECRET || 'dev-only-secret-change-me'; }
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
export async function listBookings(tenantId, { from, to, limit = 25 } = {}){
  const c = db(); if(!c) return [];
  const f = (from ? startOfDay(from) : startOfDay(new Date())).toISOString();
  const t = (to ? endOfDay(to) : endOfDay(from || new Date())).toISOString();
  const { data } = await c.from('bookings')
    .select('id, service, stylist, starts_at, duration_min, price, status, client_id, external_source')
    .eq('tenant_id', tenantId)
    .gte('starts_at', f).lte('starts_at', t)
    .neq('status', 'cancelled')
    .order('starts_at', { ascending: true })
    .limit(limit);
  return data || [];
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

// Resolve a booking from a loose description (client name and/or hour-of-day).
export async function findBooking(tenantId, { client_name, date, time } = {}){
  const day = resolveDate(date);
  let rows = await enrichBookings(tenantId, await listBookings(tenantId, { from: day, to: day, limit: 50 }));
  if(time){
    const hour = parseInt(to24(time).slice(0, 2), 10);
    rows = rows.filter(b => new Date(b.starts_at).getHours() === hour);
  }
  if(client_name){
    const q = String(client_name).toLowerCase();
    rows = rows.filter(b => (b.client_name || '').toLowerCase().includes(q));
  }
  return rows;
}

export async function cancelBooking(tenantId, bookingId){
  const c = db(); if(!c) return null;
  const { data } = await c.from('bookings')
    .update({ status: 'cancelled' })
    .eq('tenant_id', tenantId).eq('id', bookingId)
    .select().maybeSingle();
  return data;
}

export async function moveBooking(tenantId, bookingId, newStartsAt){
  const c = db(); if(!c) return null;
  const { data } = await c.from('bookings')
    .update({ starts_at: new Date(newStartsAt).toISOString() })
    .eq('tenant_id', tenantId).eq('id', bookingId)
    .select().maybeSingle();
  return data;
}

// ── revenue ────────────────────────────────────────────────────────────────
export async function revenueSummary(tenantId, { from, to } = {}){
  const c = db(); if(!c) return { total: 0, count: 0 };
  const f = (from ? startOfDay(from) : startOfDay(new Date())).toISOString();
  const t = (to ? endOfDay(to) : endOfDay(from || new Date())).toISOString();
  const { data } = await c.from('bookings')
    .select('price, status')
    .eq('tenant_id', tenantId)
    .gte('starts_at', f).lte('starts_at', t)
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
