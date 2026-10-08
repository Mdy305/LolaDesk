/**
 * api/lib/setup-store.js — the booking SETUP an owner edits (services, team,
 * weekly hours, time off), written exactly where the availability engine
 * (availability-engine-v2.js) reads it:
 *
 *   services.is_active / duration_minutes / active_duration_1_min /
 *     processing_duration_min / active_duration_2_min / buffer_after_min
 *   staff.is_active
 *   staff_services   (tenant_id, staff_id, service_id, custom_price, custom_duration_minutes)
 *   staff_schedules  (tenant_id, staff_id, day_of_week 0=Sun..6, start_time, end_time)
 *   staff_time_off   (tenant_id, staff_id, starts_at, ends_at, reason)
 *
 * Production tables predate parts of this shape, so every write is tolerant:
 * an optional column the live table lacks is dropped and the write retried
 * (api/lib/migrate.js ensureBookingSetupSchema() adds those columns lazily).
 */
import { db } from './db.js';
import { zonedLocalToUtc } from './timezone.js';

// "Could not find the 'color' column of 'staff' in the schema cache" (PostgREST)
// or 'column "color" of relation "staff" does not exist' (Postgres).
export function missingColumn(error){
  const msg = String(error?.message || error || '');
  const m = msg.match(/Could not find the '([^']+)' column/i)
    || msg.match(/column "?([a-zA-Z0-9_]+)"? of relation "?[^"\s]+"? does not exist/i)
    || msg.match(/column [a-zA-Z0-9_]+\.([a-zA-Z0-9_]+) does not exist/i);
  return m ? m[1] : null;
}

/**
 * Run a write, dropping optional columns the live table doesn't have.
 * `run(payload)` must return the supabase promise; `required` columns are
 * never dropped (their absence is a real error).
 */
export async function tolerantWrite(run, payload, { required = [] } = {}){
  let p = Array.isArray(payload) ? payload.map(r => ({ ...r })) : { ...payload };
  const keysOf = () => Array.isArray(p) ? Object.keys(p[0] || {}) : Object.keys(p);
  for(let i = 0; i < 12; i++){
    const res = await run(p);
    if(!res?.error) return res;
    const col = missingColumn(res.error);
    if(!col || required.includes(col) || !keysOf().includes(col)) return res;
    if(Array.isArray(p)) p.forEach(r => { delete r[col]; }); else delete p[col];
  }
  return run(p);
}

const num = (v) => (v === '' || v == null || Number.isNaN(Number(v))) ? null : Number(v);

// ── weekly hours ──────────────────────────────────────────────────────
export function clockToMinutes(text){
  if(text == null || text === '') return null;
  const s = String(text).trim().toLowerCase();
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm|a|p)?$/);
  if(!m) return null;
  let h = Number(m[1]); const min = Number(m[2] || 0);
  if(m[3]){ const pm = m[3][0] === 'p'; if(h === 12) h = 0; if(pm) h += 12; }
  if(h > 24 || min > 59) return null;
  return Math.min(24 * 60, h * 60 + min);
}
export function minutesToClock(min){
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Accepts [{day_of_week,start_time,end_time,off?}] or {0:{start,end,off}, …}
 * or {sun:{open,close,closed}, …}. Returns clean working rows (off days are
 * simply absent) or throws a readable error.
 */
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export function normalizeHours(input){
  let list = [];
  if(Array.isArray(input)) list = input;
  else if(input && typeof input === 'object'){
    list = Object.entries(input).map(([k, v]) => ({ ...(v || {}), day_of_week: /^\d$/.test(k) ? Number(k) : DAY_KEYS.indexOf(String(k).slice(0, 3).toLowerCase()) }));
  }
  const out = [];
  for(const r of list){
    const d = Number(r.day_of_week ?? r.day);
    if(!(d >= 0 && d <= 6)) continue;
    if(r.off === true || r.closed === true || r.working === false) continue;
    const s = clockToMinutes(r.start_time ?? r.start ?? r.open);
    const e = clockToMinutes(r.end_time ?? r.end ?? r.close);
    if(s == null || e == null) continue;
    if(e <= s) throw new Error(`${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d]}: end time must be after start time`);
    out.push({ day_of_week: d, start_time: minutesToClock(s), end_time: minutesToClock(e) });
  }
  // one shift per day (the engine reads one row per day)
  const byDay = new Map(); out.forEach(r => byDay.set(r.day_of_week, r));
  return [...byDay.values()].sort((a, b) => a.day_of_week - b.day_of_week);
}

/**
 * The salon's opening hours (booking_settings.business_hours, or its metadata
 * copy) as staff_schedules rows — the week a stylist gets when nobody set
 * theirs. null when the salon has no usable hours.
 */
export function salonWeekRows(settings){
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const md = isObj(settings?.metadata) ? settings.metadata : {};
  const bh = isObj(settings?.business_hours) ? settings.business_hours : (isObj(md.business_hours) ? md.business_hours : null);
  if(!bh) return null;
  try{ const rows = normalizeHours(bh); return rows.length ? rows : null; }catch{ return null; }
}

/**
 * Give a stylist with NO schedule rows at all the salon's hours (fallback:
 * 09:00–19:00 every day, the booking seed's default). A stylist with any
 * row — including the "off every day" marker — is the owner's choice and is
 * never touched. Returns the rows written ([] when nothing was missing).
 */
export async function fillMissingStaffHours(c, tenantId, staffId, settings){
  const { data: have, error } = await c.from('staff_schedules').select('staff_id').eq('tenant_id', tenantId).eq('staff_id', staffId).limit(1);
  if(error || (have || []).length) return [];
  const week = salonWeekRows(settings) || [0, 1, 2, 3, 4, 5, 6].map(d => ({ day_of_week: d, start_time: '09:00', end_time: '19:00' }));
  const ins = await c.from('staff_schedules').insert(week.map(r => ({ tenant_id: tenantId, staff_id: staffId, ...r })));
  if(ins?.error) throw ins.error;
  return week;
}

/** Working rows only (a 00:00–00:00 row is the "fully off" marker). */
export function workingRows(rows){
  return (rows || []).filter(r => {
    const s = clockToMinutes(r.start_time), e = clockToMinutes(r.end_time);
    return s != null && e != null && e > s;
  }).map(r => ({ day_of_week: Number(r.day_of_week), start_time: minutesToClock(clockToMinutes(r.start_time)), end_time: minutesToClock(clockToMinutes(r.end_time)) }));
}

/**
 * Replace one stylist's week. A stylist off every day gets a single
 * zero-length marker row so booking-seed.js (which gives a default week to
 * staff with NO rows) doesn't silently re-open them; the engine skips it.
 */
export async function replaceSchedule(c, tenantId, staffId, hours){
  const rows = normalizeHours(hours);
  const del = await c.from('staff_schedules').delete().eq('tenant_id', tenantId).eq('staff_id', staffId);
  if(del?.error) throw del.error;
  const insert = rows.length
    ? rows.map(r => ({ tenant_id: tenantId, staff_id: staffId, ...r }))
    : [{ tenant_id: tenantId, staff_id: staffId, day_of_week: 0, start_time: '00:00', end_time: '00:00' }];
  const ins = await c.from('staff_schedules').insert(insert);
  if(ins?.error) throw ins.error;
  return rows;
}

// ── which stylist does which service ──────────────────────────────────
/**
 * Replace a stylist's service picker. `services` is [id] and/or
 * [{service_id, custom_price, custom_duration_minutes}]. Only the tenant's
 * own services are linked (ids from another salon are ignored).
 */
export async function replaceStaffServices(c, tenantId, staffId, services){
  const wanted = new Map();
  for(const s of (services || [])){
    if(!s) continue;
    const id = typeof s === 'object' ? (s.service_id || s.id) : s;
    if(!id) continue;
    wanted.set(String(id), {
      custom_price: typeof s === 'object' ? num(s.custom_price) : null,
      custom_duration_minutes: typeof s === 'object' ? num(s.custom_duration_minutes) : null
    });
  }
  let ids = [];
  if(wanted.size){
    const { data: own, error } = await c.from('services').select('id').eq('tenant_id', tenantId).in('id', [...wanted.keys()]);
    if(error) throw error;
    ids = (own || []).map(r => String(r.id));
  }
  // staffId was verified to be this tenant's; staff_services may lack tenant_id on older DBs.
  const del = await c.from('staff_services').delete().eq('staff_id', staffId);
  if(del?.error) throw del.error;
  if(!ids.length) return [];
  const rows = ids.map(id => ({ tenant_id: tenantId, staff_id: staffId, service_id: id, ...wanted.get(id) }));
  const ins = await tolerantWrite(p => c.from('staff_services').insert(p), rows, { required: ['staff_id', 'service_id'] });
  if(ins?.error) throw ins.error;
  return rows;
}

// ── time off ──────────────────────────────────────────────────────────
function nextDateKey(key){
  const d = new Date(key + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
/**
 * {start_date, end_date?, start_time?, end_time?} in salon-local time (whole
 * days when no times) or {starts_at, ends_at} ISO instants.
 */
export function timeOffWindow(body, timeZone){
  let start, end;
  if(body.starts_at && body.ends_at){ start = new Date(body.starts_at); end = new Date(body.ends_at); }
  else {
    const sd = String(body.start_date || '').slice(0, 10);
    const ed = String(body.end_date || sd).slice(0, 10);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(sd) || !/^\d{4}-\d{2}-\d{2}$/.test(ed)) throw new Error('Pick a start date');
    start = new Date(zonedLocalToUtc(sd, body.start_time || '00:00', timeZone));
    end = new Date(body.end_time ? zonedLocalToUtc(ed, body.end_time, timeZone) : zonedLocalToUtc(nextDateKey(ed), '00:00', timeZone));
  }
  if(Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new Error('Invalid dates');
  if(end <= start) throw new Error('Time off must end after it starts');
  return { starts_at: start.toISOString(), ends_at: end.toISOString() };
}

export async function addTimeOff(c, tenantId, staffId, { starts_at, ends_at, reason }){
  const row = { tenant_id: tenantId, staff_id: staffId, starts_at, ends_at, reason: reason ? String(reason).slice(0, 200) : null };
  let res = await tolerantWrite(p => c.from('staff_time_off').insert(p).select().single(), row, { required: ['tenant_id', 'staff_id'] });
  if(res?.error && /starts_at|ends_at/.test(String(res.error.message || ''))){
    // older shape: start_time / end_time
    const alt = { tenant_id: tenantId, staff_id: staffId, start_time: starts_at, end_time: ends_at, reason: row.reason };
    res = await tolerantWrite(p => c.from('staff_time_off').insert(p).select().single(), alt, { required: ['tenant_id', 'staff_id'] });
  }
  if(res?.error) throw res.error;
  const d = res.data || row;
  return { id: d.id, staff_id: staffId, starts_at: d.starts_at || d.start_time, ends_at: d.ends_at || d.end_time, reason: d.reason || null };
}

// ── read everything the team / services pages need, in 3 queries ─────
export async function loadSetup(c, tenantId){
  const [staffRes, schedRes, offRes] = await Promise.all([
    c.from('staff').select('*').eq('tenant_id', tenantId),
    c.from('staff_schedules').select('*').eq('tenant_id', tenantId),
    c.from('staff_time_off').select('*').eq('tenant_id', tenantId)
  ]);
  if(staffRes.error) throw staffRes.error;
  const staff = staffRes.data || [];
  const ids = staff.map(s => s.id);
  let links = [];
  if(ids.length){
    const l = await c.from('staff_services').select('*').in('staff_id', ids);
    if(!l.error) links = l.data || [];
  }
  const now = Date.now();
  const timeOff = (offRes.error ? [] : (offRes.data || []))
    .map(r => ({ id: r.id, staff_id: r.staff_id, starts_at: r.starts_at || r.start_time, ends_at: r.ends_at || r.end_time, reason: r.reason || null }))
    .filter(r => r.ends_at && new Date(r.ends_at).getTime() > now)
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  const schedules = schedRes.error ? [] : (schedRes.data || []);
  return { staff, links, schedules, timeOff };
}

/** A staff row decorated for the UI: is_active flag, services[], hours[], time_off[]. */
export function decorateStaff(s, { links, schedules, timeOff }){
  const mine = links.filter(l => l.staff_id === s.id);
  const hours = workingRows(schedules.filter(r => r.staff_id === s.id)).sort((a, b) => a.day_of_week - b.day_of_week);
  const active = s.is_active !== false && s.active !== false;
  return {
    ...s,
    is_active: active,
    active,
    services: mine.map(l => l.service_id),
    service_links: mine.map(l => ({ service_id: l.service_id, custom_price: l.custom_price ?? null, custom_duration_minutes: l.custom_duration_minutes ?? null })),
    hours,
    has_hours: hours.length > 0,
    time_off: timeOff.filter(t => t.staff_id === s.id)
  };
}

export async function staffBelongsToTenant(c, tenantId, staffId){
  if(!staffId) return false;
  const { data } = await c.from('staff').select('id').eq('id', staffId).eq('tenant_id', tenantId).maybeSingle();
  return !!data;
}

export { db };
