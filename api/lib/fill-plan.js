/**
 * api/lib/fill-plan.js — Lola, Marketing VP: keep every chair full a month ahead.
 * ════════════════════════════════════════════════════════════════════
 * 1. FORECAST  the next 30 days, chair by chair: working hours (staff
 *              schedules − time off − blocked time) vs what's booked.
 *              → open hours per day, the slow weekdays, revenue at stake.
 * 2. AUDIENCE  from real visit history (lib/client-history.js): who is due
 *              back, who came once, who lapsed, the VIPs — never anyone
 *              who already has something booked or opted out.
 * 3. STRATEGY  a 4-week campaign calendar aimed at the open days, written in
 *              the salon's voice by Lola's brain (Telnyx inference), with safe
 *              templates when the brain is unavailable. No invented discounts.
 * 4. RUN       each campaign goes out on its day (10am+ salon time) through the
 *              normal campaign engine (paced, 9–8, STOP line, 7-day cap). If the
 *              days it targets filled up meanwhile, it's skipped.
 * 5. ROLL      every week the plan is rebuilt with fresh numbers, so the next
 *              30 days are always covered.
 *
 * The first plan is built the moment onboarding learns the salon. It waits for
 * the owner's one-tap approval — unless Autopilot is on.
 * Table: lola_fill_plans (sql/revenue-engine.sql).
 */
import { chat } from './llm.js';
import { getBookingSettings, listStaff, getStaffSchedules } from './booking-repository.js';
import { localDateKey, dayBoundsUtc, zonedLocalToUtc, localWeekday } from './timezone.js';
import { clientHistory, planSegments } from './client-history.js';
import { createCampaign, startCampaign, inSendingHours, localHour } from './marketing.js';
import { parseKnowledge } from './business-learn.js';

const DAY = 864e5;
const HORIZON = 30;
const TARGET_UTIL = 0.85;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const CANCELLED = /^(cancel|no[-_ ]?show|declined|void)/i;
// Conservative reply→booking rates for salon SMS by audience (planning only).
const CONVERT = { due: 0.22, second_visit: 0.12, lapsed: 0.06, vip: 0.18, recent: 0.10 };

async function rows(p) { try { const r = await p; return (r && !r.error && Array.isArray(r.data)) ? r.data : []; } catch { return []; } }
const mins = (t) => { if (!t) return null; const [h, m] = String(t).split(':').map(Number); return Number.isFinite(h) ? h * 60 + (m || 0) : null; };
const addDays = (key, n) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const overlapMs = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));

// ── 1. FORECAST ────────────────────────────────────────────────────
export async function forecast(c, tenant, { now = new Date(), days = HORIZON } = {}) {
  const settings = (await getBookingSettings(tenant.id)) || {};
  const tz = settings.timezone || 'America/New_York';
  const staff = await listStaff(tenant.id).catch(() => []);
  const schedules = await getStaffSchedules(tenant.id).catch(() => []);
  const start = addDays(localDateKey(now, tz), 1);                 // from tomorrow
  const end = addDays(start, days);
  const from = dayBoundsUtc(start, tz).start, to = dayBoundsUtc(end, tz).start;
  const [bookings, timeOff, blocks, services] = await Promise.all([
    rows(c.from('bookings').select('staff_id,start_time,end_time,status,total_amount,service_id').eq('tenant_id', tenant.id).lt('start_time', to).gt('end_time', from).limit(20000)),
    rows(c.from('staff_time_off').select('*').eq('tenant_id', tenant.id).limit(2000)),
    rows(c.from('blocked_slots').select('*').eq('tenant_id', tenant.id).gte('blocked_date', start).lt('blocked_date', end).limit(5000)),
    rows(c.from('services').select('price,duration_minutes,is_active').eq('tenant_id', tenant.id).limit(1000)),
  ]);
  const live = bookings.filter(b => !CANCELLED.test(b.status || ''));
  const staffIds = new Set(staff.map(s => s.id));
  const out = [];
  for (let i = 0; i < days; i++) {
    const key = addDays(start, i);
    const dow = localWeekday(new Date(dayBoundsUtc(key, tz).start), tz);
    let cap = 0, booked = 0;
    for (const s of staff) {
      const sch = schedules.find(x => x.staff_id === s.id && Number(x.day_of_week) === dow);
      const a = mins(sch?.start_time), b = mins(sch?.end_time);
      if (a == null || b == null || b <= a) continue;
      const ws = Date.parse(zonedLocalToUtc(key, sch.start_time, tz)), we = Date.parse(zonedLocalToUtc(key, sch.end_time, tz));
      let avail = we - ws;
      for (const t of timeOff) {
        if (t.staff_id !== s.id || t.approved === false) continue;
        avail -= overlapMs(ws, we, Date.parse(t.starts_at || t.start_time), Date.parse(t.ends_at || t.end_time));
      }
      for (const bl of blocks) {
        if (bl.blocked_date !== key || (bl.staff_id && bl.staff_id !== s.id)) continue;
        const bs = bl.start_time ? Date.parse(zonedLocalToUtc(key, bl.start_time, tz)) : ws;
        const be = bl.end_time ? Date.parse(zonedLocalToUtc(key, bl.end_time, tz)) : we;
        avail -= overlapMs(ws, we, bs, be);
      }
      avail = Math.max(0, avail);
      let used = 0;
      for (const bk of live) if (bk.staff_id === s.id) used += overlapMs(ws, we, Date.parse(bk.start_time), Date.parse(bk.end_time));
      cap += avail; booked += Math.min(avail, used);
    }
    // Bookings with no stylist still take a chair.
    const unassigned = live.filter(bk => !bk.staff_id || !staffIds.has(bk.staff_id));
    const dayStart = Date.parse(dayBoundsUtc(key, tz).start), dayEnd = Date.parse(dayBoundsUtc(addDays(key, 1), tz).start);
    for (const bk of unassigned) booked += overlapMs(dayStart, dayEnd, Date.parse(bk.start_time), Date.parse(bk.end_time));
    booked = Math.min(booked, cap);
    const capH = cap / 3600e3, bookedH = booked / 3600e3;
    out.push({ date: key, weekday: WEEKDAYS[dow], dow, capacity_h: +capH.toFixed(1), booked_h: +bookedH.toFixed(1), open_h: +(capH - bookedH).toFixed(1), util: capH ? +(bookedH / capH).toFixed(2) : null });
  }
  // Money per chair-hour, from the menu (or recent tickets).
  const act = services.filter(s => s.is_active !== false && Number(s.price) > 0 && Number(s.duration_minutes) > 0);
  let perHour = act.length ? act.reduce((s, x) => s + Number(x.price) / (Number(x.duration_minutes) / 60), 0) / act.length : 0;
  const tickets = live.map(b => Number(b.total_amount) || 0).filter(v => v > 0);
  const avgTicket = tickets.length ? tickets.reduce((a, b) => a + b, 0) / tickets.length : (act.length ? act.reduce((s, x) => s + Number(x.price), 0) / act.length : 0);
  if (!perHour && avgTicket) perHour = avgTicket;                     // ~1h per visit
  perHour = Math.min(perHour, 600);
  const working = out.filter(d => d.capacity_h > 0);
  const capacity = working.reduce((s, d) => s + d.capacity_h, 0), booked = working.reduce((s, d) => s + d.booked_h, 0);
  const byDow = {};
  for (const d of working) { (byDow[d.dow] = byDow[d.dow] || []).push(d.util || 0); }
  const weekdays = Object.entries(byDow).map(([dow, u]) => ({ dow: Number(dow), weekday: WEEKDAYS[dow], util: +(u.reduce((a, b) => a + b, 0) / u.length).toFixed(2) })).sort((a, b) => a.util - b.util);
  const gapDays = working.filter(d => (d.util ?? 1) < 0.6 && d.open_h >= 2).map(d => d.date);
  const toTarget = working.reduce((s, d) => s + Math.max(0, d.capacity_h * TARGET_UTIL - d.booked_h), 0);
  return {
    timezone: tz, start, end: addDays(start, days - 1), days: out,
    capacity_h: +capacity.toFixed(1), booked_h: +booked.toFixed(1), open_h: +(capacity - booked).toFixed(1),
    util: capacity ? +(booked / capacity).toFixed(2) : null, target_util: TARGET_UTIL,
    hours_to_target: +toTarget.toFixed(1), per_hour: Math.round(perHour), avg_ticket: Math.round(avgTicket),
    revenue_at_stake: Math.round(toTarget * perHour),
    slow_weekdays: weekdays.filter(w => w.util < 0.6).slice(0, 3), weekdays, gap_days: gapDays,
    has_schedule: capacity > 0,
  };
}

// ── 3. STRATEGY ───────────────────────────────────────────────────
const fmtDays = (keys, tz) => {
  const names = [...new Set(keys.map(k => new Date(k + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })))];
  return names.length <= 1 ? (names[0] || '') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
};

function openDaysIn(fc, fromKey, toKey) {
  return fc.days.filter(d => d.date >= fromKey && d.date <= toKey && d.capacity_h > 0 && (d.util ?? 1) < 0.8 && d.open_h >= 1.5).map(d => d.date);
}

// The calendar: which audience, when, aimed at which open days.
const PLAYBOOK = [
  { key: 'due',          offset: 0,  window: [1, 14],  name: 'Due for their next visit', why: 'Clients whose usual rhythm says they’re due — the easiest bookings there are.' },
  { key: 'second_visit', offset: 3,  window: [4, 18],  name: 'Second visit',             why: 'First-time guests who haven’t come back. The second visit is what makes a regular.' },
  { key: 'lapsed',       offset: 7,  window: [8, 21],  name: 'We miss you',              why: 'Clients not seen in 3+ months, pointed at your quietest days.', days: 90 },
  { key: 'vip',          offset: 10, window: [11, 30], name: 'VIP first pick',           why: 'Your best clients get first pick of next month’s prime times.' },
  { key: 'recent',       offset: 14, window: [15, 30], name: 'Book your next one',       why: 'Guests from the last 30 days — lock in their next visit before they drift.' },
  { key: 'lapsed',       offset: 21, window: [22, 30], name: 'Last call this month',     why: 'A second, wider win-back to fill the final week.', days: 60 },
];

function template(item, tenant, link, dayText, service) {
  const salon = tenant.name || 'the salon';
  const days = dayText ? ` We have openings ${dayText}.` : '';
  const book = link ? ` Book: ${link}` : ' Reply to book.';
  switch (item.segment) {
    case 'due': return `Hi {first_name}, it's about time for your next ${service || 'visit'} at ${salon}.${days}${book}`;
    case 'second_visit': return `Hi {first_name}, thank you again for visiting ${salon}! Ready for round two?${days}${book}`;
    case 'vip': return `Hi {first_name}, you're one of our favorites at ${salon} — you get first pick of next month's best times before we open them up.${book}`;
    case 'recent': return `Hi {first_name}, loved having you at ${salon}! Want to lock in your next appointment now?${days}${book}`;
    default: return `Hi {first_name}, we miss you at ${salon}!${days}${book}`;
  }
}

function cleanMessage(text, link) {
  let t = String(text || '').trim().replace(/^["'“]|["'”]$/g, '').replace(/\s+\n/g, '\n');
  if (!/\{first_name\}/i.test(t)) return null;
  if (t.length > 320) return null;
  if (link && !t.includes(link)) t = `${t} Book: ${link}`;
  if (/\bstop\b|opt.?out/i.test(t)) t = t.replace(/\s*reply stop[^.]*\.?/i, '').trim();
  return t.slice(0, 400);
}

async function writeCopy(items, { tenant, knowledge, link, llm = chat, timeoutMs = 20000 }) {
  if (!llm || timeoutMs < 3000 || !items.length) return null;
  const brief = items.map((it, i) => `${i + 1}. audience: ${it.audience_label}; goal: ${it.why}${it.day_text ? `; open days to mention: ${it.day_text}` : ''}${it.service ? `; their usual service: ${it.service}` : ''}`).join('\n');
  const system = [
    `You are Lola, the marketing lead for ${tenant.name || 'a salon'}. Write SMS campaign texts.`,
    knowledge.tone ? `Brand voice: ${knowledge.tone}.` : '', knowledge.summary ? `About the salon: ${knowledge.summary}` : '',
    knowledge.usp ? `What makes them special: ${knowledge.usp}` : '',
    knowledge.marketing?.ideal_client ? `Ideal client: ${knowledge.marketing.ideal_client}` : '',
    'Rules: each text max 230 characters, starts with "Hi {first_name}", warm and personal, one clear reason to book now.',
    'NEVER invent discounts, prices or offers. No hashtags. No opt-out line (added automatically).',
    link ? `Every text ends with: Book: ${link}` : 'Every text asks them to reply to book.',
    'Answer with JSON only: {"messages":["text 1","text 2",...]} in the same order as the list.',
  ].filter(Boolean).join('\n');
  try {
    const r = await Promise.race([llm({ system, messages: [{ role: 'user', content: brief }], maxTokens: 1200, temperature: 0.7 }), new Promise(z => setTimeout(() => z({ ok: false }), timeoutMs))]);
    if (!r?.ok) return null;
    const m = String(r.text || '').match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : null;
    return Array.isArray(j?.messages) ? j.messages : null;
  } catch { return null; }
}

export function bookingLinkFor(tenant) {
  if (tenant.booking_url) return tenant.booking_url;
  const base = (process.env.APP_URL || 'https://www.loladesk.com').replace(/\/$/, '');
  return tenant.slug ? `${base}/book?t=${encodeURIComponent(tenant.slug)}` : null;
}

export async function buildFillPlan(c, tenant, { now = new Date(), llm = chat, autopilot = null, reason = 'onboarding', copyTimeoutMs = 20000 } = {}) {
  const fc = await forecast(c, tenant, { now });
  const hist = await clientHistory(c, tenant.id, { now });
  const seg = planSegments(hist, { now });
  const knowledge = parseKnowledge(tenant.knowledge);
  const link = bookingLinkFor(tenant);
  const tz = fc.timezone;
  const today = localDateKey(now, tz);

  // Most common "usual service" among the due clients, for the copy.
  const svcCount = new Map(); for (const h of seg.due) if (h.usualService) svcCount.set(h.usualService, (svcCount.get(h.usualService) || 0) + 1);
  const topDueService = [...svcCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  // Never re-run the same audience within 3 weeks across weekly rebuilds.
  const prev = await latestPlan(c, tenant.id);
  const sentLog = { ...(prev?.strategy?.sent_log || {}) };
  for (const it of prev?.items || []) if (it.status === 'sent' && it.sent_at && (!sentLog[it.segment] || it.sent_at > sentLog[it.segment])) sentLog[it.segment] = it.sent_at;
  const COOLDOWN = 21;
  const used = new Set();
  const items = PLAYBOOK.map((p, i) => {
    let offset = p.offset;
    const last = sentLog[p.key] ? Date.parse(sentLog[p.key]) : null;
    if (last) offset = Math.max(offset, Math.ceil((last + COOLDOWN * DAY - now.getTime()) / DAY));
    if (used.has(p.key) && offset < 14) offset = Math.max(offset, 14);   // second touch of an audience waits
    used.add(p.key);
    if (offset > HORIZON - 3) return null;
    const window = [Math.max(p.window[0], offset + 1), Math.max(p.window[1], offset + 7)];
    const size = (seg[p.key] || []).length;
    const target = openDaysIn(fc, addDays(today, window[0]), addDays(today, Math.min(HORIZON, window[1])));
    const est = Math.round(size * (CONVERT[p.key] || 0.08));
    return {
      key: `${p.key}_${p.offset}`, segment: p.key, days: p.days || null, name: p.name, why: p.why,
      send_on: addDays(today, offset), audience_label: ({ due: 'Due for their next visit', second_visit: 'Came once', lapsed: `Not seen in ${p.days || 90}+ days`, vip: 'VIP clients', recent: 'Visited in the last 30 days' })[p.key],
      audience: size, target_days: target.slice(0, 8), day_text: fmtDays(target.slice(0, 4), tz),
      service: p.key === 'due' ? topDueService : null,
      est_bookings: est, est_revenue: Math.round(est * (fc.avg_ticket || 0)),
      status: 'planned', message: null, i,
    };
  }).filter(Boolean);
  // Skip repeats that would re-text the same people inside two weeks when the audience is tiny.
  const live = items.filter(it => it.audience > 0 || it.segment === 'due' || it.segment === 'lapsed');
  const copy = await writeCopy(live, { tenant, knowledge, link, llm, timeoutMs: copyTimeoutMs });
  for (const [j, it] of live.entries()) {
    it.message = cleanMessage(copy?.[j], link) || template(it, tenant, link, it.day_text, it.service);
    it.written_by = copy?.[j] && cleanMessage(copy[j], link) ? 'lola' : 'template';
  }
  const plannedItems = live.map(({ i, ...rest }) => rest);

  const projected = plannedItems.reduce((s, it) => s + it.est_revenue, 0);
  const slow = fc.slow_weekdays.map(w => w.weekday);
  const acquisition = [];
  if (seg.total < 50) acquisition.push({ key: 'import', text: 'Import your client list so Lola can bring them back (Settings → Clients → Import).' });
  if (link) acquisition.push({ key: 'google', text: `Add your booking link to your Google Business Profile: ${link}` });
  if (link) acquisition.push({ key: 'instagram', text: 'Put the same link in your Instagram bio — new clients book themselves 24/7.' });
  acquisition.push({ key: 'website', text: 'Add the Book button to your website (Booking settings → Website widget).' });
  if (!fc.has_schedule) acquisition.unshift({ key: 'hours', text: 'Set your team’s working hours so Lola can see your open chairs.' });

  const headline = !fc.has_schedule
    ? 'Set your working hours and Lola will map every open chair for the next 30 days.'
    : fc.hours_to_target <= 1
      ? `You’re ${Math.round((fc.util || 0) * 100)}% booked for the next 30 days — Lola will keep it that way and protect your best clients’ spots.`
      : `${Math.round(fc.hours_to_target)} chair-hours to fill in the next 30 days (${Math.round((fc.util || 0) * 100)}% booked today)${fc.revenue_at_stake ? ` — about $${fc.revenue_at_stake.toLocaleString()} on the table` : ''}.`;
  const strategy = {
    headline,
    goal: `Get the next 30 days to ${Math.round(TARGET_UTIL * 100)}% booked`,
    levers: [
      seg.due.length ? `${seg.due.length} client${seg.due.length === 1 ? ' is' : 's are'} due back in the next 30 days with nothing booked${topDueService ? ` (mostly ${topDueService})` : ''}.` : null,
      seg.second_visit.length ? `${seg.second_visit.length} first-time guest${seg.second_visit.length === 1 ? '' : 's'} never came back — the second visit makes a regular.` : null,
      seg.lapsed.length ? `${seg.lapsed.length} client${seg.lapsed.length === 1 ? ' hasn’t' : 's haven’t'} been in for 3+ months.` : null,
      slow.length ? `${slow.length > 1 ? slow.slice(0, -1).join(', ') + ' and ' + slow[slow.length - 1] : slow[0]} ${slow.length === 1 ? 'is' : 'are'} your quietest day${slow.length === 1 ? '' : 's'} — the campaigns point there first.` : null,
    ].filter(Boolean),
    projected_bookings: plannedItems.reduce((s, it) => s + it.est_bookings, 0), projected_revenue: projected,
    acquisition, audience_total: seg.textable, sent_log: sentLog,
  };

  // Keep Autopilot and approval state across weekly rebuilds.
  const auto = autopilot != null ? !!autopilot : !!prev?.autopilot;
  const status = auto || prev?.status === 'active' ? 'active' : 'proposed';
  const ins = await c.from('lola_fill_plans').insert({
    tenant_id: tenant.id, status, autopilot: auto, reason, created_at: now.toISOString(),
    horizon_start: fc.start, horizon_end: fc.end, forecast: fc, strategy, items: plannedItems,
    approved_at: status === 'active' ? (prev?.approved_at || new Date().toISOString()) : null,
  }).select().maybeSingle();
  if (ins.error) return { ok: false, error: /lola_fill_plans/.test(ins.error.message || '') ? 'Run sql/revenue-engine.sql in Supabase first.' : ins.error.message };
  if (prev?.id) await c.from('lola_fill_plans').update({ status: 'replaced' }).eq('id', prev.id);
  return { ok: true, plan: ins.data };
}

export async function latestPlan(c, tenantId) {
  const { data } = await c.from('lola_fill_plans').select('*').eq('tenant_id', tenantId).in('status', ['proposed', 'active', 'paused']).order('created_at', { ascending: false }).limit(1);
  return (data || [])[0] || null;
}

export function planSummary(plan) {
  if (!plan) return null;
  const s = plan.strategy || {}, f = plan.forecast || {};
  return { id: plan.id, status: plan.status, autopilot: !!plan.autopilot, headline: s.headline, open_hours: f.hours_to_target, util: f.util,
    campaigns: (plan.items || []).length, projected_bookings: s.projected_bookings, projected_revenue: s.projected_revenue };
}

export async function setPlanStatus(c, tenant, id, action) {
  const { data: plan } = await c.from('lola_fill_plans').select('*').eq('id', id).eq('tenant_id', tenant.id).maybeSingle();
  if (!plan) return { ok: false, error: 'Plan not found.' };
  const patch = action === 'approve' ? { status: 'active', approved_at: new Date().toISOString() }
    : action === 'pause' ? { status: 'paused' }
    : action === 'autopilot_on' ? { autopilot: true, status: 'active', approved_at: plan.approved_at || new Date().toISOString() }
    : action === 'autopilot_off' ? { autopilot: false }
    : null;
  if (!patch) return { ok: false, error: 'unknown action' };
  const r = await c.from('lola_fill_plans').update(patch).eq('id', id).select().maybeSingle();
  return r.error ? { ok: false, error: r.error.message } : { ok: true, plan: r.data };
}

export async function skipItem(c, tenant, id, key) {
  const { data: plan } = await c.from('lola_fill_plans').select('*').eq('id', id).eq('tenant_id', tenant.id).maybeSingle();
  if (!plan) return { ok: false, error: 'Plan not found.' };
  const items = (plan.items || []).map(it => it.key === key && it.status === 'planned' ? { ...it, status: 'skipped', reason: 'owner' } : it);
  await c.from('lola_fill_plans').update({ items }).eq('id', id);
  return { ok: true };
}

export async function editItem(c, tenant, id, key, message) {
  const { data: plan } = await c.from('lola_fill_plans').select('*').eq('id', id).eq('tenant_id', tenant.id).maybeSingle();
  if (!plan) return { ok: false, error: 'Plan not found.' };
  const msg = String(message || '').trim();
  if (!msg || msg.length > 480) return { ok: false, error: 'Message must be 1–480 characters.' };
  const items = (plan.items || []).map(it => it.key === key && it.status === 'planned' ? { ...it, message: msg, written_by: 'owner' } : it);
  await c.from('lola_fill_plans').update({ items }).eq('id', id);
  return { ok: true };
}

// ── 4 + 5. RUN & ROLL ─────────────────────────────────────────────
export async function runFillPlans(c, { now = new Date(), budgetMs = 45000, llm = chat } = {}) {
  const deadline = Date.now() + budgetMs;
  const out = { sent: 0, skipped: 0, rebuilt: 0, plans: 0 };
  const plans = await rows(c.from('lola_fill_plans').select('*').in('status', ['active', 'proposed']).limit(500));
  for (const plan of plans) {
    if (Date.now() > deadline - 5000) break;
    const { data: tenant } = await c.from('tenants').select('*').eq('id', plan.tenant_id).maybeSingle();
    if (!tenant) continue;
    out.plans++;
    // Weekly roll: fresh numbers, the next 30 days always covered.
    if (now.getTime() - Date.parse(plan.created_at) > 7 * DAY) {
      if (Date.now() < deadline - 25000) { const r = await buildFillPlan(c, tenant, { now, llm, reason: 'weekly' }); if (r.ok) out.rebuilt++; }
      continue;
    }
    if (plan.status !== 'active') continue;
    const tz = plan.forecast?.timezone || 'America/New_York';
    if (!inSendingHours(now, tz) || localHour(now, tz) < 10) continue;
    const today = localDateKey(now, tz);
    const items = (plan.items || []).map(x => ({ ...x }));
    const due = items.filter(it => it.status === 'planned' && it.send_on <= today);
    if (!due.length) continue;
    let fc = null;
    for (const it of due.slice(0, 2)) {                            // at most two sends per plan per run
      if (it.target_days?.length) {
        fc = fc || await forecast(c, tenant, { now });
        const stillOpen = fc.days.filter(d => it.target_days.includes(d.date) && (d.util ?? 1) < 0.9);
        if (!stillOpen.length) { it.status = 'skipped'; it.reason = 'already_full'; out.skipped++; continue; }
      }
      const made = await createCampaign(c, tenant, { name: `30-day plan · ${it.name}`, segment: it.segment, days: it.days || undefined, message: it.message, createdBy: 'lola_plan', excludeBooked: true, capDays: 14 });
      if (!made.ok) { it.status = 'skipped'; it.reason = made.error && /Nobody/.test(made.error) ? 'no_audience' : String(made.error || 'failed').slice(0, 120); out.skipped++; continue; }
      const st = await startCampaign(c, tenant, made.campaign.id, { max: 20, deadline: Math.min(deadline, Date.now() + 10000), tz, now });
      it.status = 'sent'; it.campaign_id = made.campaign.id; it.sent_at = now.toISOString(); it.recipients = made.total;
      out.sent++;
      void st;
    }
    await c.from('lola_fill_plans').update({ items }).eq('id', plan.id);
  }
  return out;
}
