/**
 * api/lib/owner-money.js — "how much is locked in?" for any range.
 * ════════════════════════════════════════════════════════════════
 * One answer for every owner channel (app chat/voice, owner texts, the owner
 * phone line): booked revenue = the total_amount (the stylist's price) of
 * confirmed / arrived / completed bookings whose start falls on the given
 * SALON-LOCAL days. Works forward ("next week" = Mon–Sun of next week in the
 * salon's timezone) and back ("last week"), with a by-day and by-stylist
 * breakdown and the deposits already collected for those bookings.
 */
import { localDateKey, zonedLocalToUtc } from './timezone.js';

export const LOCKED_STATUSES = ['confirmed', 'arrived', 'completed'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const KEY = /^\d{4}-\d{2}-\d{2}$/;

export const addDays = (key, n) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const dow = (key) => new Date(`${key}T12:00:00Z`).getUTCDay();
const short = (key) => new Date(`${key}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const weekday = (key) => new Date(`${key}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
export const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');

/** A spoken/typed phrase → a period name the resolver understands, or null. */
export function periodFromText(text) {
  const t = String(text || '').toLowerCase();
  let m;
  if ((m = t.match(/\b(\d{4}-\d{2}-\d{2})\s*(?:to|through|thru|until|-|–)\s*(\d{4}-\d{2}-\d{2})\b/))) return { from: m[1], to: m[2] };
  if ((m = t.match(/\bnext (\d{1,2}) days\b/))) return `next_${m[1]}_days`;
  if (/\bnext week(?!end)\b/.test(t)) return 'next_week';
  if (/\blast week(?!end)\b/.test(t)) return 'last_week';
  if (/\bnext weekend\b/.test(t)) return 'next_weekend';
  if (/\bweekend\b/.test(t)) return 'weekend';
  if (/\bthis week\b|\brest of (?:the|this) week\b/.test(t)) return 'this_week';
  if (/\bnext month\b/.test(t)) return 'next_month';
  if (/\blast month\b/.test(t)) return 'last_month';
  if (/\bthis month\b/.test(t)) return 'this_month';
  if (/\btomorrow\b/.test(t)) return 'tomorrow';
  if (/\byesterday\b/.test(t)) return 'yesterday';
  if ((m = t.match(/\b(\d{4}-\d{2}-\d{2})\b/))) return m[1];
  if ((m = t.match(/\b(?:(next|this|on|last|past|previous)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/))) {
    if (m[1] === 'next') return 'next ' + m[2];
    // Past tense looks back: "how much did we make (last) Saturday" = the previous Saturday.
    const past = /^(?:last|past|previous)$/.test(m[1] || '') || (/\b(did|made|was|were|earned|brought in|took in|had)\b/.test(t) && !/\b(locked|coming|upcoming|ahead|on the books|will|going to)\b/.test(t));
    return (past ? 'last ' : '') + m[2];
  }
  if (/\btoday\b|\btonight\b/.test(t)) return 'today';
  return null;
}

/**
 * Period (name, {from,to}, weekday or YYYY-MM-DD) → { from, to, label } as
 * inclusive salon-local day keys. Weeks run Monday–Sunday. Null if unknown.
 */
export function resolvePeriod(period, tz = 'America/New_York', now = new Date()) {
  const today = localDateKey(now, tz);
  const monday = addDays(today, -((dow(today) + 6) % 7));
  const [y, mo] = today.split('-').map(Number);
  const monthStart = (dy, dm) => new Date(Date.UTC(dy, dm - 1, 1)).toISOString().slice(0, 10);
  const range = (from, to, name) => ({ from, to, label: from === to ? `${name || weekday(from)} (${short(from)})` : `${name} (${short(from)} – ${short(to)})` });
  if (period && typeof period === 'object') {
    const f = String(period.from || '').slice(0, 10), t = String(period.to || period.from || '').slice(0, 10);
    if (!KEY.test(f) || !KEY.test(t)) return null;
    return f <= t ? range(f, t, 'That range') : range(t, f, 'That range');
  }
  const p = String(period || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!p) return null;
  if (KEY.test(p)) return range(p, p, null);
  let m;
  if ((m = p.match(/^next_(\d{1,2})_days$/))) { const n = Math.max(1, Math.min(90, Number(m[1]))); return range(today, addDays(today, n - 1), `The next ${n} days`); }
  switch (p.replace(/ /g, '_')) {
    case 'today': return range(today, today, 'Today');
    case 'tomorrow': return range(addDays(today, 1), addDays(today, 1), 'Tomorrow');
    case 'yesterday': return range(addDays(today, -1), addDays(today, -1), 'Yesterday');
    case 'this_week': return range(monday, addDays(monday, 6), 'This week');
    case 'next_week': return range(addDays(monday, 7), addDays(monday, 13), 'Next week');
    case 'last_week': return range(addDays(monday, -7), addDays(monday, -1), 'Last week');
    case 'weekend': case 'this_weekend': {
      const d = dow(today);
      if (d === 0) return range(today, today, 'This weekend');
      const sat = addDays(today, 6 - d);
      return range(sat, addDays(sat, 1), 'This weekend');
    }
    case 'next_weekend': { const sat = addDays(monday, 12); return range(sat, addDays(sat, 1), 'Next weekend'); }
    case 'this_month': return range(monthStart(y, mo), addDays(monthStart(y, mo + 1), -1), 'This month');
    case 'next_month': return range(monthStart(y, mo + 1), addDays(monthStart(y, mo + 2), -1), 'Next month');
    case 'last_month': return range(monthStart(y, mo - 1), addDays(monthStart(y, mo), -1), 'Last month');
    default: break;
  }
  const wd = p.match(/^(?:(next|this|on|coming|last|past|previous) )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/);
  if (wd && /^(?:last|past|previous)$/.test(wd[1] || '')) {
    const back = ((dow(today) - WEEKDAYS.indexOf(wd[2]) + 7) % 7) || 7;
    const k = addDays(today, -back);
    return range(k, k, `Last ${weekday(k)}`);
  }
  if (wd) {
    let diff = (WEEKDAYS.indexOf(wd[2]) - dow(today) + 7) % 7;
    if (wd[1] === 'next' && diff === 0) diff = 7;
    const k = addDays(today, diff);
    return range(k, k, null);
  }
  return null;
}

/**
 * Locked-in revenue for salon-local days [from..to] (inclusive), tenant-scoped.
 * → { from, to, total, count, by_day:[{date,total,count}], by_stylist:[{name,total,count}], deposits_collected }
 */
export async function bookedRevenue(c, tenantId, { from, to, tz = 'America/New_York' } = {}) {
  const out = { from, to, total: 0, count: 0, by_day: [], by_stylist: [], deposits_collected: 0 };
  if (!c || !tenantId || !KEY.test(String(from || '')) || !KEY.test(String(to || ''))) return out;
  const startIso = zonedLocalToUtc(from, '00:00:00', tz), endIso = zonedLocalToUtc(addDays(to, 1), '00:00:00', tz);
  const { data } = await c.from('bookings').select('*').eq('tenant_id', tenantId)
    .gte('start_time', startIso).lt('start_time', endIso).in('status', LOCKED_STATUSES);
  const rows = (data || []).filter((b) => b.tenant_id === tenantId);
  const staffIds = [...new Set(rows.map((b) => b.staff_id).filter(Boolean))];
  let names = {};
  if (staffIds.length) {
    try {
      const { data: st } = await c.from('staff').select('id,name').eq('tenant_id', tenantId).in('id', staffIds);
      names = Object.fromEntries((st || []).map((s) => [s.id, s.name]));
    } catch { /* names are a nicety */ }
  }
  const days = new Map(), stylists = new Map();
  for (const b of rows) {
    const amt = Number(b.total_amount || 0) || 0;
    out.total += amt; out.count++;
    const k = localDateKey(new Date(b.start_time), tz);
    const d = days.get(k) || { date: k, total: 0, count: 0 }; d.total += amt; d.count++; days.set(k, d);
    const n = names[b.staff_id] || b.stylist || 'Unassigned';
    const s = stylists.get(n) || { name: n, total: 0, count: 0 }; s.total += amt; s.count++; stylists.set(n, s);
  }
  out.total = Math.round(out.total * 100) / 100;
  out.by_day = [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  out.by_stylist = [...stylists.values()].sort((a, b) => b.total - a.total);
  const ids = rows.map((b) => b.id).filter(Boolean);
  if (ids.length) {
    try {
      const { data: dep } = await c.from('deposits').select('booking_id,amount,status,tenant_id').eq('tenant_id', tenantId).in('booking_id', ids);
      out.deposits_collected = Math.round((dep || []).filter((d) => /^(paid|kept)$/.test(String(d.status || ''))).reduce((s, d) => s + (Number(d.amount) || 0), 0) * 100) / 100;
    } catch { /* deposits table may not exist yet */ }
  }
  return out;
}

/** One short owner-facing sentence (works spoken or texted). */
export function sayRevenue(r, label, { future = null } = {}) {
  const lead = future === null ? 'booked' : future ? 'locked in' : 'booked';
  if (!r.count) return `${label}: nothing ${lead} yet.`;
  let say = `${label}: ${money(r.total)} ${lead} across ${r.count} appointment${r.count === 1 ? '' : 's'}.`;
  if (r.by_day.length > 1) { const top = r.by_day.slice().sort((a, b) => b.total - a.total)[0]; say += ` Biggest day: ${weekday(top.date)}, ${money(top.total)}.`; }
  const named = r.by_stylist.filter((s) => s.name !== 'Unassigned');
  if (named.length > 1 || (named.length === 1 && r.by_stylist.length > 1)) say += ` By stylist: ${r.by_stylist.slice(0, 4).map((s) => `${s.name} ${money(s.total)}`).join(', ')}.`;
  if (r.deposits_collected) say += ` Deposits collected: ${money(r.deposits_collected)}.`;
  return say;
}

/** Everything in one call: phrase/period → numbers + sentence. */
export async function revenueFor(c, tenantId, period, tz, now = new Date()) {
  const rng = resolvePeriod(period, tz, now);
  if (!rng) return null;
  const r = await bookedRevenue(c, tenantId, { from: rng.from, to: rng.to, tz });
  const future = rng.from > localDateKey(now, tz) ? true : rng.to < localDateKey(now, tz) ? false : null;
  return { ...r, label: rng.label, say: sayRevenue(r, rng.label, { future }) };
}
