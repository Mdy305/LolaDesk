/**
 * api/lib/blocks.js — blocked time (lunch, maintenance, days off), one engine.
 * ════════════════════════════════════════════════════════════════
 * The calendar (/api/salon resource:'block') and Lola (owner app chat/voice,
 * owner texts, the owner phone line) write blocks through the SAME code here.
 * staff_id null = the whole salon. A block with no start/end time runs from
 * opening / to closing (the availability engine reads null as the day edge).
 *
 * Lola never cancels a client because of a block: planBlock lists whoever is
 * already booked in that window so the owner decides, and the block only
 * stops NEW bookings.
 */
import { localDateKey, zonedLocalToUtc, dayBoundsUtc } from './timezone.js';
import { getBookingSettings } from './booking-repository.js';
import { salonDay } from './availability-engine-v2.js';

const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const tKey = (v) => (v ? String(v).slice(0, 5).padStart(5, '0') : null);
export const blockTimeOk = (v) => v == null || v === '' || /^\d{1,2}:\d{2}(:\d{2})?$/.test(String(v));
export const blockDateOk = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
export const addDaysKey = (key, n) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

async function staffOk(c, T, sid) {
  if (!sid) return true;
  const { data: s } = await c.from('staff').select('id').eq('tenant_id', T).eq('id', sid).maybeSingle();
  return !!s;
}

/**
 * Create a block (+ weekly copies). Same rules and messages /api/salon always had.
 * body: { date, start_time?, end_time?, reason?, staff_id?, repeat_weeks?:1..52 }
 * → { ok:true, rows } | { ok:false, status, error }. A database error throws.
 */
export async function createBlocks(c, T, body = {}) {
  if (!blockDateOk(body.date)) return { ok: false, status: 400, error: 'Pick a valid date.' };
  if (!blockTimeOk(body.start_time) || !blockTimeOk(body.end_time)) return { ok: false, status: 400, error: 'Invalid time.' };
  if (body.start_time && body.end_time && toMin(body.end_time) <= toMin(body.start_time)) return { ok: false, status: 400, error: 'End time must be after start time.' };
  if (!(await staffOk(c, T, body.staff_id))) return { ok: false, status: 404, error: 'Stylist not found' };
  const weeks = Math.min(52, Math.max(1, parseInt(body.repeat_weeks, 10) || 1));
  const rows = [];
  for (let n = 0; n < weeks; n++) {
    const { data, error } = await c.from('blocked_slots').insert({
      tenant_id: T, staff_id: body.staff_id || null,
      blocked_date: addDaysKey(String(body.date), 7 * n), start_time: body.start_time || null, end_time: body.end_time || null,
      reason: body.reason || '',
    }).select().single();
    if (error) throw error;
    rows.push(data);
  }
  return { ok: true, rows };
}

/**
 * Delete a block; scope 'following' also removes its later weekly copies
 * (same stylist, times, reason and weekday). → { ok:true, deleted } | { ok:false, status, error }
 */
export async function deleteBlocks(c, T, { id, scope } = {}) {
  const { data: cur } = await c.from('blocked_slots').select('*').eq('id', id || '').eq('tenant_id', T).maybeSingle();
  if (!cur) return { ok: false, status: 404, error: 'Block not found' };
  let ids = [cur.id];
  if (String(scope || '') === 'following') {
    const { data: later } = await c.from('blocked_slots').select('*').eq('tenant_id', T).gt('blocked_date', String(cur.blocked_date));
    const dow = (k) => new Date(String(k).slice(0, 10) + 'T12:00:00Z').getUTCDay();
    ids = ids.concat((later || []).filter((b) => (b.staff_id || null) === (cur.staff_id || null) && tKey(b.start_time) === tKey(cur.start_time) && tKey(b.end_time) === tKey(cur.end_time)
      && String(b.reason || '') === String(cur.reason || '') && dow(b.blocked_date) === dow(cur.blocked_date)).map((b) => b.id));
  }
  for (const bid of ids) {
    const { error } = await c.from('blocked_slots').delete().eq('id', bid).eq('tenant_id', T);
    if (error) return { ok: false, status: 500, error: 'Could not remove block: ' + (error.message || JSON.stringify(error)) };
  }
  return { ok: true, deleted: ids.length };
}

// ── Lola's side: words → a block plan the owner confirms ──

/** "2pm" | "2:30 pm" | "14:00" | "noon" → "HH:MM" (bare 1–7 = PM, salon hours). */
export function parseClock(input) {
  const s = String(input || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'noon' || s === 'midday') return '12:00';
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm|a|p)?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10); const min = m[2] ? parseInt(m[2], 10) : 0; const ap = m[3];
  if (ap && ap.startsWith('p') && h < 12) h += 12;
  if (ap && ap.startsWith('a') && h === 12) h = 0;
  if (!ap && h >= 1 && h <= 7) h += 12;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
const hhmm = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
export function clockLabel(t) {
  if (!t) return '';
  const [h, m] = String(t).split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM', h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, '0')} ${ap}` : `${h12} ${ap}`;
}
const andList = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
const dayLabel = (key) => new Date(`${key}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
const timeLabel = (iso, tz) => { try { return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }).replace(':00', ''); } catch { return iso; } };

/** Salon opening hours for a day → { open:'HH:MM', close:'HH:MM' } | { closed:true } | null (unknown). */
export async function salonHoursFor(tenantId, dateKey) {
  try {
    const settings = await getBookingSettings(tenantId);
    const d = salonDay(settings, dateKey, new Date(`${dateKey}T12:00:00Z`).getUTCDay());
    if (!d) return null;
    if (d.closed) return { closed: true };
    return { open: hhmm(d.open), close: hhmm(Math.min(d.close, 1439)) };
  } catch { return null; }
}

function resolveDate(input, tz, now) {
  const today = localDateKey(now, tz);
  const s = String(input || '').trim().toLowerCase();
  if (!s || s === 'today' || s === 'tonight') return { key: today, word: false };
  if (blockDateOk(s)) return { key: s, word: false };
  if (s === 'tomorrow') return { key: addDaysKey(today, 1), word: false };
  const w = WEEKDAYS.findIndex((d) => s.includes(d));
  if (w >= 0) {
    let diff = (w - new Date(`${today}T12:00:00Z`).getUTCDay() + 7) % 7;
    if (s.includes('next') && diff === 0) diff = 7;
    return { key: addDaysKey(today, diff), word: true };
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : { key: localDateKey(new Date(t), tz), word: false };
}

const WHOLE_SALON = /^(?:everyone|everybody|all|the salon|salon|whole salon|the whole salon|all staff|the team|team)$/i;
async function resolveStaff(c, T, name) {
  const q = String(name || '').trim();
  if (!q || WHOLE_SALON.test(q)) return { staff: null };
  const { data } = await c.from('staff').select('id,name,is_active').eq('tenant_id', T);
  const list = (data || []).filter((s) => s.is_active !== false);
  const lc = q.toLowerCase();
  const hits = list.filter((s) => String(s.name || '').toLowerCase() === lc);
  const loose = hits.length ? hits : list.filter((s) => String(s.name || '').toLowerCase().split(/\s+/)[0] === lc.split(/\s+/)[0]);
  if (loose.length === 1) return { staff: loose[0] };
  if (loose.length > 1) return { error: `More than one stylist is called ${q}: ${loose.map((s) => s.name).join(', ')}. Which one?` };
  return { error: `I don't see a stylist called ${q}.` };
}

/** Booked clients (not cancelled / no-show) inside the window — they are listed, never cancelled. */
export async function blockClashes(c, T, { date, start_time, end_time, staff_id = null, tz }) {
  const day = dayBoundsUtc(date, tz);
  const s = new Date(start_time ? zonedLocalToUtc(date, `${tKey(start_time)}:00`, tz) : day.start).getTime();
  const e = new Date(end_time ? zonedLocalToUtc(date, `${tKey(end_time)}:00`, tz) : day.end).getTime();
  const { data } = await c.from('bookings').select('*').eq('tenant_id', T)
    .gte('start_time', new Date(s - 12 * 3600e3).toISOString()).lt('start_time', new Date(e).toISOString());
  const rows = (data || []).filter((b) => b.tenant_id === T && !/cancel|no.?show/i.test(String(b.status || ''))
    && (!staff_id || !b.staff_id || b.staff_id === staff_id)
    && new Date(b.start_time).getTime() < e
    && new Date(b.end_time || new Date(new Date(b.start_time).getTime() + 60 * 60e3).toISOString()).getTime() > s)
    .sort((a, b) => (a.start_time < b.start_time ? -1 : 1));
  const ids = [...new Set(rows.map((b) => b.client_id).filter(Boolean))];
  const { data: cls } = ids.length ? await c.from('clients').select('id,name,first_name,last_name').eq('tenant_id', T).in('id', ids) : { data: [] };
  const byId = Object.fromEntries((cls || []).map((x) => [x.id, x]));
  return rows.map((b) => {
    const cl = byId[b.client_id];
    const name = (cl && (cl.name || [cl.first_name, cl.last_name].filter(Boolean).join(' '))) || b.client_name || 'a client';
    return { booking_id: b.id, name, first: String(name).split(' ')[0], time: timeLabel(b.start_time, tz), start_time: b.start_time };
  });
}

/**
 * Words → the exact block to write, plus who's already booked then.
 * args: { staff?, date?, part?: morning|afternoon|evening|all day, start?, end?, reason?, repeat_weeks? }
 * → { ok:false, say } | { ok:true, plan:{date,start_time,end_time,staff_id,staff_name,reason,repeat_weeks}, what, clashes, say }
 */
export async function planBlock(c, tenant, args = {}, { tz = 'America/New_York', now = new Date() } = {}) {
  const T = tenant.id;
  const who = await resolveStaff(c, T, args.staff);
  if (who.error) return { ok: false, say: who.error };
  let d = resolveDate(args.date, tz, now);
  if (!d) return { ok: false, say: 'Which day should I block?' };
  const part = String(args.part || '').toLowerCase().replace(/[^a-z ]/g, '').trim();
  // Never guess a span: no times and no morning/afternoon/evening/all day → ask.
  if (!args.start && !args.end && !/after ?noon|morning|evening|night|all ?day|whole ?day|full ?day|entire ?day|day off/.test(part)) {
    const at = args.at ? parseClock(args.at) : null;
    return { ok: false, say: at ? `Block from ${clockLabel(at)} until when? Or say morning, afternoon or all day.` : 'Which part should I block: morning, afternoon, all day, or a time like 2 to 4pm?' };
  }
  let start = args.start ? parseClock(args.start) : null, end = args.end ? parseClock(args.end) : null;
  if ((args.start && !start) || (args.end && !end)) return { ok: false, say: "I didn't catch the times. Say something like 2pm to 4pm." };
  const window = async (key) => {
    const hours = await salonHoursFor(T, key);
    let s = start, e = end;
    if (!args.start && !args.end) {
      if (/after ?noon/.test(part)) { s = '12:00'; e = null; }
      else if (/morning/.test(part)) { s = null; e = '12:00'; }
      else if (/evening|night/.test(part)) { s = '17:00'; e = null; }
    }
    // "To close" / "from opening": write the salon's real hours when known (null = the day's edge).
    const fromOpen = !s && !!e, toClose = !!s && !e;
    if (hours && !hours.closed) { if (fromOpen) s = hours.open; if (toClose) e = hours.close; }
    return { hours, s, e, fromOpen, toClose };
  };
  let w = await window(d.key);
  const endsAt = (key, e) => new Date(e ? zonedLocalToUtc(key, `${e}:00`, tz) : dayBoundsUtc(key, tz).end);
  if (endsAt(d.key, w.e) <= now) {
    if (!d.word) return { ok: false, say: 'That time has already passed. Which day did you mean?' };
    d = { key: addDaysKey(d.key, 7), word: true };
    w = await window(d.key);
  }
  if (w.s && w.e && toMin(w.e) <= toMin(w.s)) return { ok: false, say: 'The end time has to be after the start time.' };
  const h = w.hours;
  if (h && !h.closed && w.s && toMin(w.s) >= toMin(h.close)) return { ok: false, say: `You close at ${clockLabel(h.close)} on ${dayLabel(d.key)}, so there's nothing to block after ${clockLabel(w.s)}.` };
  if (h && !h.closed && w.e && toMin(w.e) <= toMin(h.open)) return { ok: false, say: `You open at ${clockLabel(h.open)} on ${dayLabel(d.key)}, so there's nothing to block before ${clockLabel(w.e)}.` };
  const reason = String(args.reason || '').trim().slice(0, 120);
  const plan = {
    date: d.key, start_time: w.s, end_time: w.e,
    staff_id: who.staff ? who.staff.id : null, staff_name: who.staff ? who.staff.name : null,
    reason: reason || 'Blocked', repeat_weeks: Math.min(52, Math.max(1, parseInt(args.repeat_weeks, 10) || 1)),
  };
  const span = !w.s && !w.e ? 'all day'
    : `from ${w.fromOpen ? `opening${w.s ? ` (${clockLabel(w.s)})` : ''}` : clockLabel(w.s)} to ${w.toClose ? `close${w.e ? ` (${clockLabel(w.e)})` : ''}` : clockLabel(w.e)}`;
  const what = `${dayLabel(d.key)} ${span} for ${plan.staff_name || 'the whole salon'}${reason ? ` (${reason})` : ''}${plan.repeat_weeks > 1 ? `, every week for ${plan.repeat_weeks} weeks` : ''}`;
  const clashes = await blockClashes(c, T, { date: d.key, start_time: w.s, end_time: w.e, staff_id: plan.staff_id, tz });
  const closedNote = h && h.closed ? " You're already closed that day, so this just makes it official." : '';
  const clashNote = clashes.length
    ? ` ${clashes.length === 1 ? '1 client is' : `${clashes.length} clients are`} booked then: ${clashes.slice(0, 5).map((x) => `${x.first} ${x.time}`).join(', ')}${clashes.length > 5 ? '…' : ''}. Block anyway? I won't cancel ${clashes.length === 1 ? 'them' : 'anyone'}.`
    : ' Nobody is booked then.';
  return { ok: true, plan, what, clashes, say: `I'll block ${what}.${closedNote}${clashNote}` };
}

/** Write the confirmed plan. → { ok, say, rows } */
export async function applyBlock(c, tenantId, plan, { tz = 'America/New_York' } = {}) {
  const r = await createBlocks(c, tenantId, {
    date: plan.date, start_time: plan.start_time, end_time: plan.end_time,
    staff_id: plan.staff_id || null, reason: plan.reason || 'Blocked', repeat_weeks: plan.repeat_weeks || 1,
  });
  if (!r.ok) return { ok: false, say: `I couldn't block it: ${r.error}` };
  const clashes = await blockClashes(c, tenantId, { ...plan, tz }).catch(() => []);
  const span = !plan.start_time && !plan.end_time ? 'all day' : `${plan.start_time ? clockLabel(plan.start_time) : 'opening'}–${plan.end_time ? clockLabel(plan.end_time) : 'close'}`;
  return {
    ok: true, rows: r.rows,
    say: `Done — ${dayLabel(plan.date)} ${span} is blocked for ${plan.staff_name || 'the whole salon'}${r.rows.length > 1 ? `, ${r.rows.length} weeks` : ''}. No new bookings can land there.${clashes.length ? ` ${andList(clashes.map((x) => x.first).slice(0, 5))} ${clashes.length === 1 ? 'is' : 'are'} still booked — nothing was cancelled.` : ''}`,
  };
}

/** Which block(s) to remove. args: { date?, staff?, reason? } → { ok:false, say } | { ok:true, ids, what, say } */
export async function planUnblock(c, tenant, args = {}, { tz = 'America/New_York', now = new Date() } = {}) {
  const T = tenant.id;
  const today = localDateKey(now, tz);
  let q = c.from('blocked_slots').select('*').eq('tenant_id', T);
  let d = null;
  if (args.date) {
    d = resolveDate(args.date, tz, now);
    if (!d) return { ok: false, say: 'Which day is the block on?' };
    q = q.eq('blocked_date', d.key);
  } else q = q.gte('blocked_date', today);
  const { data } = await q;
  let rows = (data || []).filter((b) => b.tenant_id === T);
  // A weekday word with nothing that day: try the same weekday next week (the block may be a week out).
  if (d && d.word && !rows.length) {
    const next = addDaysKey(d.key, 7);
    const { data: more } = await c.from('blocked_slots').select('*').eq('tenant_id', T).eq('blocked_date', next);
    rows = (more || []).filter((b) => b.tenant_id === T);
  }
  if (args.staff && !WHOLE_SALON.test(String(args.staff).trim())) {
    const who = await resolveStaff(c, T, args.staff);
    if (who.error) return { ok: false, say: who.error };
    rows = rows.filter((b) => b.staff_id === who.staff.id);
  }
  if (args.reason) { const r = String(args.reason).toLowerCase(); const hit = rows.filter((b) => String(b.reason || '').toLowerCase().includes(r)); if (hit.length) rows = hit; }
  rows.sort((a, b) => (String(a.blocked_date) + (a.start_time || '') < String(b.blocked_date) + (b.start_time || '') ? -1 : 1));
  const describe = (b) => `${dayLabel(String(b.blocked_date).slice(0, 10))} ${!b.start_time && !b.end_time ? 'all day' : `${b.start_time ? clockLabel(tKey(b.start_time)) : 'opening'}–${b.end_time ? clockLabel(tKey(b.end_time)) : 'close'}`}${b.reason ? ` (${b.reason})` : ''}`;
  if (!rows.length) return { ok: false, say: d ? `There's no block on ${dayLabel(d.key)}.` : "You don't have any blocks coming up." };
  if (!d) {
    const days = [...new Set(rows.map((b) => String(b.blocked_date).slice(0, 10)))];
    if (days.length > 1) return { ok: false, say: `You have blocks on ${rows.slice(0, 3).map(describe).join('; ')}${rows.length > 3 ? '…' : ''}. Which day should I clear?` };
  }
  const what = rows.length === 1 ? `the ${describe(rows[0])} block` : `${rows.length} blocks: ${rows.slice(0, 3).map(describe).join('; ')}`;
  return { ok: true, ids: rows.map((b) => b.id), what, say: `Remove ${what}? Clients will be able to book that time again.` };
}

/** Remove the confirmed blocks (tenant-scoped). → { ok, say, deleted } */
export async function applyUnblock(c, tenantId, ids = []) {
  let deleted = 0;
  for (const id of ids) {
    const r = await deleteBlocks(c, tenantId, { id });
    if (r.ok) deleted += r.deleted;
  }
  if (!deleted) return { ok: false, say: 'That block was already gone.' };
  return { ok: true, deleted, say: `Done — removed ${deleted === 1 ? 'the block' : `${deleted} blocks`}. That time is open for bookings again.` };
}
