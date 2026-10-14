/**
 * api/lib/owner-awareness.js — what Lola KNOWS before the owner says a word.
 * ════════════════════════════════════════════════════════════════════════════
 *   • THE BUSINESS  the real menu, team and hours from the live tables (what onboarding
 *                   synced from the website + Google), the Google rating, the competitors,
 *                   and what is still missing — never the stale copy on the tenant row.
 *   • RIGHT NOW     today and tomorrow (clients, money locked in, the next client), the week
 *                   ahead, who needs a call back, who hasn't confirmed, and the biggest open
 *                   window in the book.
 *   • THE ONE MOVE  the single thing worth doing next, as a short offer.
 *   • THE VOICE     a chief of staff: answer first, number first, one offer, no filler.
 * Read-only, deterministic, fail-open: a slow or missing table never blocks Lola's answer.
 */
import { db } from './db.js';
import { getBookingSettings, listServices, listStaff } from './booking-repository.js';
import { localDateKey, dayBoundsUtc } from './timezone.js';
import { parseKnowledge } from './business-learn.js';
import { bookedRevenue, LOCKED_STATUSES } from './owner-money.js';
import { awayBrief } from './owner-brief.js';

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_NAME = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const JS_DAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const plural = (n, w, many) => `${n} ${n === 1 ? w : (many || w + 's')}`;
const money = (n) => `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
const first = (s) => String(s || '').trim().split(/\s+/)[0] || '';
const nameOf = (c) => (c && (c.name || [c.first_name, c.last_name].filter(Boolean).join(' '))) || '';
const DEAD = /^(cancel|no[_ -]?show|noshow)/i;

const CACHE = new Map();               // tenantId:kind → { at, value }
const TTL = { snap: 60e3, now: 20e3 };
async function cached(key, ttl, fn, fresh) {
  const hit = CACHE.get(key);
  if (!fresh && hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await fn();
  CACHE.set(key, { at: Date.now(), value });
  if (CACHE.size > 500) CACHE.delete(CACHE.keys().next().value);
  return value;
}
export function _resetAwareness() { CACHE.clear(); }
/** The setup just changed (onboarding scan, menu or team edit): Lola re-reads it on the next turn. */
export function forgetTenant(tenantId) { for (const k of [...CACHE.keys()]) if (k.startsWith(`${tenantId}:`)) CACHE.delete(k); }
/** Never let awareness slow Lola down: whatever isn't ready in `ms` is skipped. */
export function within(ms, p, fallback = null) {
  return Promise.race([Promise.resolve(p).catch(() => fallback), new Promise((r) => setTimeout(() => r(fallback), ms))]);
}

// ── time helpers ──
const hm = (t) => { const m = String(t || '').match(/^(\d{1,2}):(\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
export function clock(min) {
  const h = Math.floor(min / 60), m = min % 60, ap = h >= 12 ? 'pm' : 'am', h12 = ((h + 11) % 12) + 1;
  return m ? `${h12}:${String(m).padStart(2, '0')}${ap}` : `${h12}${ap}`;
}
function localMinutes(iso, tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  const g = (t) => Number(p.find((x) => x.type === t)?.value || 0);
  return g('hour') * 60 + g('minute');
}
const addDays = (key, n) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const dayKeyOf = (key) => JS_DAY[new Date(`${key}T12:00:00Z`).getUTCDay()];

/** A week of { open, close, closed } → "Tue–Sat 10am–7pm · Sun–Mon closed". */
export function hoursText(week) {
  if (!week || typeof week !== 'object') return '';
  const label = (d) => { const x = week[d]; if (!x || x.closed) return 'closed'; const o = hm(x.open), c = hm(x.close); return o == null || c == null ? 'closed' : `${clock(o)}–${clock(c)}`; };
  const groups = [];
  for (const d of DAY_KEYS) {
    const l = label(d), g = groups[groups.length - 1];
    if (g && g.l === l) g.days.push(d); else groups.push({ l, days: [d] });
  }
  const open = groups.filter((g) => g.l !== 'closed'), shut = groups.filter((g) => g.l === 'closed').flatMap((g) => g.days);
  const span = (days) => (days.length > 1 ? `${DAY_NAME[days[0]]}–${DAY_NAME[days[days.length - 1]]}` : DAY_NAME[days[0]]);
  const parts = open.map((g) => `${span(g.days)} ${g.l}`);
  if (shut.length && shut.length < 7) parts.push(`${shut.length > 2 ? shut.map((d) => DAY_NAME[d]).join(', ') : shut.map((d) => DAY_NAME[d]).join(' & ')} closed`);
  return parts.join(' · ');
}

function weekFrom(bs) {
  const w = bs?.business_hours || bs?.metadata?.business_hours;
  if (!w || typeof w !== 'object') return null;
  return DAY_KEYS.some((d) => w[d]) ? w : null;
}

/**
 * The business as onboarding synced it: live services, team and hours, plus what Google and the
 * website said. → { services, staff, week, hours, tz, google, knowledge, learned, gaps, prompt }
 */
export async function businessSnapshot(tenant, { fresh = false } = {}) {
  if (!tenant?.id) return null;
  return cached(`${tenant.id}:snap`, TTL.snap, async () => {
    const [svcs, staff, bs] = await Promise.all([
      listServices(tenant.id).catch(() => []), listStaff(tenant.id).catch(() => []), getBookingSettings(tenant.id).catch(() => null),
    ]);
    const k = parseKnowledge(tenant.knowledge);
    const named = (svcs || []).filter((s) => s && s.name);
    const services = (named.length > 1 ? named.filter((s) => !/^consultation$/i.test(s.name)) : named)
      .map((s) => ({ id: s.id, name: s.name, price: Number(s.price) > 0 ? Number(s.price) : null, duration_minutes: Number(s.duration_minutes) || null, category: s.category || null }));
    const team = (staff || []).filter((s) => s && s.name && !/^(owner|stylist|staff)( \d+)?$/i.test(s.name))
      .map((s) => ({ id: s.id, name: s.name, role: s.role || s.title || null }));
    const week = weekFrom(bs);
    const hours = hoursText(week) || String(tenant.hours || '');
    const g = k.google && !k.google.pending ? k.google : null;
    const google = g ? {
      rating: Number(g.rating) || null, reviews_count: Number(g.reviews_count) || null, address: g.address || null,
      review_link: g.review_link || tenant.google_review_url || null,
      competitors: (g.competitors || []).filter((x) => x && x.name).slice(0, 3).map((x) => ({ name: x.name, rating: Number(x.rating) || null, reviews: Number(x.reviews_count ?? x.reviews) || null })),
      recent: (g.reviews || []).slice(0, 2).map((r) => ({ rating: r.rating, text: String(r.text || '').slice(0, 160) })),
    } : null;
    const gaps = [];
    const unpriced = services.filter((s) => !s.price).length;
    if (!services.length) gaps.push({ key: 'menu', say: "I don't have your menu yet — send me your website or paste your prices and I'll load it." });
    else if (unpriced) gaps.push({ key: 'prices', say: `${plural(unpriced, 'service')} on your menu still ${unpriced === 1 ? 'needs' : 'need'} a price before I can quote ${unpriced === 1 ? 'it' : 'them'}.` });
    if (!week && !tenant.hours) gaps.push({ key: 'hours', say: "I don't know your opening hours yet — tell me and I'll set the booking calendar." });
    if (!tenant.phone_number) gaps.push({ key: 'line', say: "You don't have a Lola phone line yet — say 'set up my line' and I'll do it." });
    if (!g && !k.google?.maps_url && !tenant.gmb_url) gaps.push({ key: 'google', say: "I haven't read your Google profile yet — send me the Google Maps link and I'll pull your rating, reviews and competitors." });
    const learned = k.learned || null;
    const snap = { services, staff: team, week, hours, tz: bs?.timezone || 'America/New_York', google, knowledge: k, learned, gaps,
      booking_system: k.booking_system || null, salon_phone: k.salon_phone || null };
    snap.prompt = snapshotPrompt(tenant, snap);
    return snap;
  }, fresh);
}

function snapshotPrompt(tenant, s) {
  const lines = ['THE BUSINESS (live from the salon\'s own setup — this is the truth; it overrides anything else about services, prices, team or hours):'];
  lines.push(`Salon: ${tenant.name || 'the salon'}${tenant.location ? ` — ${tenant.location}` : ''}`);
  if (s.hours) lines.push(`Hours: ${s.hours}`);
  if (s.services.length) {
    const shown = s.services.slice(0, 40).map((x) => `${x.name}${x.price ? ` $${x.price}` : ' (no price yet)'}${x.duration_minutes ? ` ${x.duration_minutes}min` : ''}`);
    lines.push(`Menu (${s.services.length}): ${shown.join('; ')}${s.services.length > 40 ? '; …' : ''}`);
  }
  if (s.staff.length) lines.push(`Team (${s.staff.length}): ${s.staff.map((x) => `${x.name}${x.role ? ` (${x.role})` : ''}`).join(', ')}`);
  if (s.google) {
    const g = s.google;
    if (g.rating) lines.push(`Google: ${g.rating}★ from ${g.reviews_count || 'some'} reviews${g.address ? ` · ${g.address}` : ''}`);
    if (g.competitors.length) lines.push(`Nearby competitors: ${g.competitors.map((c) => `${c.name}${c.rating ? ` ${c.rating}★` : ''}${c.reviews ? ` (${c.reviews})` : ''}`).join('; ')}`);
  }
  if (s.booking_system) lines.push(`Clients book today through: ${s.booking_system}`);
  if (tenant.phone_number) lines.push(`Lola's line: ${tenant.phone_number}`);
  if (s.gaps.length) lines.push(`STILL MISSING (offer to fix only when relevant): ${s.gaps.map((x) => x.key).join(', ')}`);
  return lines.join('\n');
}

/** The menu and team in the legacy tenant shape, so every older fast path sees the real data. */
export function hydrateTenant(tenant, snap) {
  if (!tenant || !snap) return tenant;
  const out = { ...tenant };
  if (snap.services.length) out.services = snap.services.map((s) => ({ id: s.id, name: s.name, price: s.price, duration: s.duration_minutes ? `${s.duration_minutes} min` : null, duration_minutes: s.duration_minutes }));
  if (snap.staff.length) out.team = snap.staff.map((s) => ({ id: s.id, name: s.name, role: s.role }));
  if (snap.hours) out.hours = snap.hours;
  return out;
}

// ── the book ──
async function dayBook(c, tenantId, key, tz) {
  const b = dayBoundsUtc(key, tz);
  const { data } = await c.from('bookings').select('*').eq('tenant_id', tenantId).gte('start_time', b.start).lt('start_time', b.end).order('start_time', { ascending: true });
  return (data || []).filter((x) => x.tenant_id === tenantId && !DEAD.test(String(x.status || '')));
}

/** The biggest open stretch (≥ 90 min) on a day, per stylist when there is a team. */
export function biggestOpening({ week, key, bookings, staff, tz, notBefore = null }) {
  const day = week && week[dayKeyOf(key)];
  if (!day || day.closed) return null;
  const open = hm(day.open), close = hm(day.close);
  if (open == null || close == null || close <= open) return null;
  const lanes = staff && staff.length ? staff.map((s) => ({ id: s.id, name: s.name })) : [{ id: null, name: null }];
  let best = null;
  for (const lane of lanes) {
    const busy = bookings.filter((b) => !lane.id || b.staff_id === lane.id || (!b.staff_id && lanes.length === 1))
      .map((b) => [localMinutes(b.start_time, tz), localMinutes(b.end_time || new Date(new Date(b.start_time).getTime() + 3600e3).toISOString(), tz)])
      .sort((a, b) => a[0] - b[0]);
    let cur = Math.max(open, notBefore ?? open);
    for (const [s, e] of [...busy, [close, close]]) {
      if (s - cur >= 90 && (!best || s - cur > best.end - best.start)) best = { start: cur, end: s, stylist: lane.name, staff_id: lane.id };
      cur = Math.max(cur, e);
    }
  }
  return best;
}

/**
 * Right now: today, tomorrow, the week, who needs the owner, and the one move.
 * → { today, tomorrow, week, needs, unconfirmed, opening, focus, oneMove, prompt }
 */
// calls:false — the per-turn context never depends on telephony state (the briefing reads who needs a call back).
export async function situation(tenant, { snap = null, now = new Date(), fresh = false, calls = true } = {}) {
  if (!tenant?.id) return null;
  return cached(`${tenant.id}:now:${calls ? 1 : 0}`, TTL.now, async () => {
    const c = db(); if (!c) return null;
    snap = snap || await businessSnapshot(tenant).catch(() => null);
    const tz = snap?.tz || 'America/New_York';
    const todayKey = localDateKey(now, tz), tomKey = addDays(todayKey, 1);
    const nowMin = localMinutes(now.toISOString(), tz);
    const td = snap?.week?.[dayKeyOf(todayKey)];
    const closedNow = !td || td.closed || (hm(td.close) != null && nowMin >= hm(td.close) - 30);
    const [todayRows, tomRows, week, brief] = await Promise.all([
      dayBook(c, tenant.id, todayKey, tz).catch(() => []),
      dayBook(c, tenant.id, tomKey, tz).catch(() => []),
      bookedRevenue(c, tenant.id, { from: todayKey, to: addDays(todayKey, 6), tz }).catch(() => null),
      calls ? awayBrief(c, tenant, new Date(now.getTime() - 24 * 3600e3).toISOString(), { now }).catch(() => null) : null,
    ]);
    const ids = [...new Set([...todayRows, ...tomRows].map((b) => b.client_id).filter(Boolean))];
    const { data: cls } = ids.length ? await c.from('clients').select('id,name,first_name,last_name').in('id', ids) : { data: [] };
    const who = Object.fromEntries((cls || []).map((x) => [x.id, nameOf(x)]));
    const svc = Object.fromEntries((snap?.services || []).map((s) => [s.id, s.name]));
    const stf = Object.fromEntries((snap?.staff || []).map((s) => [s.id, s.name]));
    const sum = (rows) => Math.round(rows.filter((b) => LOCKED_STATUSES.includes(String(b.status || 'confirmed').toLowerCase())).reduce((s, b) => s + (Number(b.total_amount) || 0), 0));
    const describe = (b) => b && ({ time: clock(localMinutes(b.start_time, tz)), client: who[b.client_id] || 'a client', service: svc[b.service_id] || b.service || '', stylist: stf[b.staff_id] || b.stylist || '' });
    const upcoming = todayRows.filter((b) => new Date(b.start_time) > now);
    const today = { key: todayKey, count: todayRows.length, total: sum(todayRows), left: upcoming.length, next: describe(upcoming[0]) };
    const tomorrow = { key: tomKey, count: tomRows.length, total: sum(tomRows), first: describe(tomRows[0]) };
    // A client's confirmation is a booking_reminders row with status 'confirmed' (appointment-confirm.js).
    let unconfirmed = 0;
    if (tomRows.length) {
      const { data: rem } = await c.from('booking_reminders').select('booking_id,status').in('booking_id', tomRows.map((b) => b.id)).then((x) => x, () => ({ data: [] }));
      const yes = new Set((rem || []).filter((r) => r.status === 'confirmed').map((r) => r.booking_id));
      unconfirmed = tomRows.filter((b) => !yes.has(b.id)).length;
    }
    const needs = (brief?.needs || []).map((n) => ({ name: n.known ? first(n.name) : 'a new caller', reason: n.reason, vip: !!n.vip }));
    const focus = closedNow ? tomorrow : today;
    const opening = snap?.week ? biggestOpening({ week: snap.week, key: focus.key, bookings: closedNow ? tomRows : todayRows, staff: snap.staff, tz, notBefore: closedNow ? null : nowMin + 30 }) : null;
    const out = { tz, closedNow, today, tomorrow, week: week ? { total: Math.round(week.total), count: week.count } : null, needs, unconfirmed, opening, focusDay: closedNow ? 'tomorrow' : 'today' };
    out.oneMove = oneMove(out, snap);
    out.prompt = situationPrompt(out);
    return out;
  }, fresh);
}

/** The single most valuable next step, in priority order. → { say, suggestion } | null */
export function oneMove(s, snap) {
  if (!s) return null;
  if (s.needs.length) {
    const n = s.needs[0];
    const why = n.reason === 'unhappy' ? 'sounded unhappy' : n.reason === 'asked_for_you' ? 'asked for you' : 'called and I missed them';
    return { say: `${n.name === 'a new caller' ? 'A new caller' : n.name}${n.vip ? ' (VIP)' : ''} ${why}${s.needs.length > 1 ? ` — ${plural(s.needs.length, 'person', 'people')} want a call back` : ''}. Want me to call ${s.needs.length > 1 ? 'them' : n.name === 'a new caller' ? 'them' : n.name} back?`, suggestion: 'Call them back' };
  }
  const gap = snap?.gaps?.find((g) => g.key === 'prices' || g.key === 'menu' || g.key === 'hours');
  if (gap) return { say: gap.say, suggestion: gap.key === 'prices' ? 'Open services' : 'Learn my website' };
  if (s.opening && s.opening.end - s.opening.start >= 120) {
    const o = s.opening;
    return { say: `${o.stylist ? `${first(o.stylist)} is` : "You're"} open ${clock(o.start)}–${clock(o.end)} ${s.focusDay}. Want me to offer it to the waitlist and clients who are due?`, suggestion: `Fill ${s.focusDay} ${clock(o.start)}` };
  }
  if (s.unconfirmed >= 2) return { say: `${plural(s.unconfirmed, 'client')} booked tomorrow ${s.unconfirmed === 1 ? "hasn't" : "haven't"} confirmed. Want me to text them?`, suggestion: "Confirm tomorrow's appointments" };
  return null;
}

function situationPrompt(s) {
  const L = ['RIGHT NOW (live — use these exact numbers; never guess a number that is not here):'];
  const t = s.today, m = s.tomorrow;
  L.push(`Today: ${plural(t.count, 'client')}, ${money(t.total)} locked in${t.next ? `; next: ${t.next.client} at ${t.next.time}${t.next.service ? ` (${t.next.service})` : ''}${t.next.stylist ? ` with ${t.next.stylist}` : ''}` : t.count ? '; the rest of today is done' : ''}.`);
  L.push(`Tomorrow: ${plural(m.count, 'client')}, ${money(m.total)} locked in${m.first ? `; first: ${m.first.client} at ${m.first.time}` : ''}${s.unconfirmed ? `; ${s.unconfirmed} not confirmed yet` : ''}.`);
  if (s.week) L.push(`Next 7 days: ${plural(s.week.count, 'booking')}, ${money(s.week.total)} locked in.`);
  if (s.needs.length) L.push(`Needs a call back: ${s.needs.map((n) => `${n.name}${n.vip ? ' (VIP)' : ''}`).join(', ')}.`);
  if (s.opening) L.push(`Biggest opening ${s.focusDay}: ${s.opening.stylist ? `${s.opening.stylist} ` : ''}${clock(s.opening.start)}–${clock(s.opening.end)}.`);
  if (s.oneMove) L.push(`The one move to offer if it fits: ${s.oneMove.say}`);
  return L.join('\n');
}

/** Who Lola is with the owner. */
export function chiefOfStaffStyle(tenant) {
  const name = first(tenant?.owner_name);
  const owner = name && !/^owner$/i.test(name) ? name : '';
  return [
    `You are Lola — ${owner ? `${owner}'s` : "the owner's"} chief of staff for ${tenant?.name || 'the salon'}. Think JARVIS, but warmer and more human: calm, quick, always a step ahead, quietly witty.`,
    'How you talk to the owner:',
    '- Answer first, then stop. Lead with the number or the fact ("$2,340 locked in for next week — 14 clients."). One or two sentences unless they ask for detail.',
    '- You already know the business (THE BUSINESS) and the day (RIGHT NOW) below. Use them. Never say you don\'t have access, never ask for something listed there.',
    '- Anticipate: when it helps, end with ONE short offer that makes money or saves time ("Want me to text the waitlist?"). Never more than one.',
    `- ${owner ? `Use ${owner}'s name now and then — not every turn.` : 'Be personal without being familiar.'} A touch of dry wit is welcome when the news is good, never when it isn't.`,
    '- No filler: never "Great question", "Certainly!", "I\'d be happy to", "As an AI". No lists unless asked. Salon words only — never IDs, tool names or tech terms.',
    '- If something truly isn\'t known, say what you need in one phrase and offer to get it.',
  ].join('\n');
}

/**
 * The briefing Lola gives when the owner arrives or says "catch me up": the day that matters
 * (tomorrow once the salon has closed), the money, who needs them, and the one move.
 * → { say, suggestions }
 */
export async function chiefBrief(tenant, { now = new Date() } = {}) {
  const snap = await businessSnapshot(tenant).catch(() => null);
  const s = await situation(tenant, { snap, now }).catch(() => null);
  if (!s) return null;
  const parts = [];
  const learnedAt = snap?.learned?.at ? Date.parse(snap.learned.at) : 0;
  if (learnedAt && now.getTime() - learnedAt < 3 * 86400e3 && snap.services.length) {
    const bits = [plural(snap.services.length, 'service'), snap.staff.length && plural(snap.staff.length, 'stylist'), snap.hours && 'your hours', snap.google?.rating && `${snap.google.rating} stars on Google`].filter(Boolean);
    parts.push(`I've synced your setup: ${bits.join(', ')}.`);
  }
  const d = s.closedNow ? s.tomorrow : s.today;
  const label = s.closedNow ? 'Tomorrow' : 'Today';
  if (d.count) {
    const lead = s.closedNow ? s.tomorrow.first : s.today.next;
    parts.push(`${label}: ${plural(d.count, 'client')}, ${money(d.total)} locked in${lead ? ` — ${s.closedNow ? 'first is' : 'next is'} ${first(lead.client)} at ${lead.time}${lead.service ? ` for ${lead.service}` : ''}` : ''}.`);
  } else parts.push(`${label} is open — nothing booked yet.`);
  if (!s.closedNow && s.tomorrow.count) parts.push(`Tomorrow: ${s.tomorrow.count}, ${money(s.tomorrow.total)}.`);
  if (s.week && s.week.total > d.total) parts.push(`${money(s.week.total)} on the books this week.`);
  if (s.oneMove) parts.push(s.oneMove.say);
  return { say: parts.join(' ').replace(/\s+/g, ' ').trim(), suggestions: [s.oneMove?.suggestion, 'What did I miss?'].filter(Boolean), situation: s };
}
