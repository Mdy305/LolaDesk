/**
 * api/lib/console-analytics.js — every platform-wide number in one place (LolaDesk Console → Analytics).
 * ════════════════════════════════════════════════════════════════════
 *   platformAnalytics(c, { days })  → { range, growth, lola, costs, engagement, salons, sources }
 *   salonsCsv(analytics)             → the per-salon table as CSV
 *
 * Rules: only rows that exist. Every metric is { cur, prev } — the range and the period right
 * before it. A source table that isn't there (or errors) makes its metrics null ("—" in the UI);
 * nothing is estimated except where labelled (MRR at the start of the range is rebuilt from the
 * Stripe event log and says so). Every query is bounded (time window + row cap + only the columns
 * it needs); `capped` names any source that hit its cap so the page can say "at least".
 *
 * Sources: tenants · billing_events · usage_events (calls/texts/DMs/widget/upsells + cost_* rows)
 * · calls · conversations · bookings (source → Lola + channel) · booking_fees · payments
 * (no-show fees) · deposits · rebooking_offers · booking_reminders · support_tickets.
 */
import { mrrCents, normalizePlan } from './plans.js';
import { costCents } from './costs.js';
import { PAYING } from './platform-admin.js';

const DAY = 864e5;
const CAP = 50000;
const ms = (v) => { const n = Date.parse(v || ''); return Number.isFinite(n) ? n : NaN; };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// Same split LolaDesk bills on (lib/booking-fees.js): who brought the booking in.
const MANUAL = /^(dashboard|owner|manual|admin|lola_owner|operator|staff|import|sync|seed|demo|test|block|operations_os)/i;
const LOLA = /^(lola|voice|telnyx|phone|call|sms|text|public|widget|website|web|google|gmb|reserve|waitlist|gap|lola_gap|rebook|campaign|missed_call|marketer|strategy|skill|autopilot|reflex|lapsed|silent_caller|instagram|messenger|whatsapp|dm)/i;
export const isLolaBooking = (b) => { const s = String(b?.source || '').trim(); return !!s && !MANUAL.test(s) && LOLA.test(s); };
export function channelOf(src) {
  const s = String(src || '').toLowerCase();
  if (/instagram|messenger|facebook|(^|_)dm/.test(s)) return 'dm';
  if (/sms|text|whatsapp|missed_call/.test(s)) return 'sms';
  if (/widget|web|public|google|gmb|reserve|chat/.test(s)) return 'web';
  if (/voice|phone|call|telnyx|texml/.test(s)) return 'phone';
  return null;
}
const CANCELLED = /^(cancel|declined|void)/i;
const NOSHOW = /^no[-_ ]?show/i;

// usage_events kinds the page reads (cost_* rows are fetched separately).
const KINDS = ['voice_call', 'sms_received', 'sms_sent', 'whatsapp_received', 'whatsapp_sent', 'instagram_received', 'messenger_received',
  'widget_message', 'widget_load', 'textback_sent', 'upsell_offered', 'upsell_detected', 'waitlist', 'callback_recovered', 'booking_link_sent', 'lead'];

/** select → rows | null (missing table/column → retry with the fallback columns, else null). */
async function rows(c, table, cols, fallback, build) {
  const go = async (sel) => {
    let q = c.from(table).select(sel);
    q = build(q);
    const r = await Promise.resolve(q.limit(CAP)).catch((e) => ({ error: e }));
    return r;
  };
  let r = await go(cols);
  if (r?.error && fallback) r = await go(fallback);
  if (r?.error) return null;
  return r.data || [];
}

function median(list) {
  const a = list.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export async function platformAnalytics(c, { days = 30, now = Date.now() } = {}) {
  days = [7, 30, 90].includes(Number(days)) ? Number(days) : 30;
  const end = now, start = now - days * DAY, prevStart = start - days * DAY;
  const since = new Date(Math.min(prevStart, now - 14 * DAY)).toISOString();
  const gte = (col) => (q) => q.gte(col, since);

  const [tenants, events, usage, costRows, calls, convs, bookings, fees, payments, deposits, rebooks, reminders, tickets] = await Promise.all([
    rows(c, 'tenants', 'id,name,slug,plan,billing_interval,subscription_status,billing_status,trial_ends_at,canceled_at,current_period_end,created_at', 'id,name,slug,plan,billing_interval,subscription_status,billing_status,created_at', (q) => q.order('created_at', { ascending: false })),
    rows(c, 'billing_events', 'tenant_id,type,amount,status,data,created_at', 'tenant_id,type,amount,created_at', gte('created_at')),
    rows(c, 'usage_events', 'tenant_id,kind,units,created_at', null, (q) => gte('created_at')(q.in('kind', KINDS))),
    (async () => { let q = c.from('usage_events').select('tenant_id,kind,units,metadata,created_at').gte('created_at', since);
      if (typeof q.like === 'function') q = q.like('kind', 'cost_%');
      const r = await Promise.resolve(q.limit(CAP)).catch((e) => ({ error: e }));
      return r?.error ? null : (r.data || []).filter((e) => /^cost_/.test(String(e.kind || ''))); })(),
    rows(c, 'calls', 'tenant_id,direction,duration_seconds,duration_sec,status,created_at', 'tenant_id,direction,created_at', gte('created_at')),
    rows(c, 'conversations', 'id,tenant_id,channel,started_at', 'id,tenant_id,channel', gte('started_at')),
    rows(c, 'bookings', 'id,tenant_id,source,status,total_amount,conversation_id,created_at', 'id,tenant_id,source,status,total_amount,created_at', gte('created_at')),
    rows(c, 'booking_fees', 'tenant_id,status,fee_cents,created_at', null, gte('created_at')),
    rows(c, 'payments', 'tenant_id,sub_kind,status,amount,created_at', null, (q) => gte('created_at')(q.eq('sub_kind', 'no_show_fee'))),
    rows(c, 'deposits', 'tenant_id,amount,status,created_at', null, gte('created_at')),
    rows(c, 'rebooking_offers', 'tenant_id,status,updated_at,created_at', null, gte('created_at')),
    rows(c, 'booking_reminders', 'tenant_id,status,sent_at,created_at', null, gte('created_at')),
    rows(c, 'support_tickets', 'id,tenant_id,status,urgency,created_at,resolved_at', 'id,status,urgency,created_at', gte('created_at')),
  ]);
  const T = tenants || [];
  const capped = Object.entries({ billing_events: events, usage_events: usage, costs: costRows, calls, conversations: convs, bookings, booking_fees: fees })
    .filter(([, v]) => Array.isArray(v) && v.length >= CAP).map(([k]) => k);

  const inP = (t, p) => Number.isFinite(t) && (p === 'cur' ? t >= start && t <= end : t >= prevStart && t < start);
  const both = (fn) => ({ cur: fn('cur'), prev: fn('prev') });
  const opt = (src, fn) => (src == null ? { cur: null, prev: null } : both(fn));
  const count = (list, at, pred = () => true) => (p) => list.filter((x) => inP(ms(at(x)), p) && pred(x)).length;
  const sum = (list, at, val, pred = () => true) => (p) => list.filter((x) => inP(ms(at(x)), p) && pred(x)).reduce((a, x) => a + val(x), 0);
  const byTenant = new Map(T.map((t) => [t.id, t]));
  const kind = (k) => (e) => e.kind === k;
  const kinds = (...k) => (e) => k.includes(e.kind);

  // ── Growth ──
  const paidEvent = (e) => (e.type === 'checkout.session.completed' && (e.data?.subscription || !e.data)) || e.type === 'customer.subscription.created';
  const conversions = (p) => events ? new Set(events.filter((e) => inP(ms(e.created_at), p) && paidEvent(e) && e.tenant_id).map((e) => e.tenant_id)).size : null;
  const trialish = (t) => ['', 'trial', 'incomplete'].includes(String(t.subscription_status || '').toLowerCase()) && !['active', 'comped', 'comp'].includes(String(t.billing_status || ''));
  const expiredUnpaid = (p) => T.filter((t) => trialish(t) && inP(ms(t.trial_ends_at), p)).length;
  const convRate = (p) => { const won = conversions(p); if (won == null) return null; const lost = expiredUnpaid(p); return won + lost ? Math.round(1000 * won / (won + lost)) / 10 : null; };
  const isPaying = (t) => PAYING.includes(String(t.subscription_status || ''));
  const mrrOf = (t) => mrrCents(normalizePlan(t.plan) || t.plan, t.billing_interval);
  const mrrNow = T.filter(isPaying).reduce((a, t) => a + mrrOf(t), 0);
  // MRR at the start of the range, rebuilt from the Stripe event log: paying now and first paid before
  // the range, or cancelled during the range (it was paying at the start). Needs billing_events.
  const firstPaid = new Map();
  for (const e of events || []) if (paidEvent(e) && e.tenant_id) { const t0 = ms(e.created_at); if (!firstPaid.has(e.tenant_id) || t0 < firstPaid.get(e.tenant_id)) firstPaid.set(e.tenant_id, t0); }
  const mrrAt = (at) => events == null ? null : T.reduce((a, t) => {
    const cancelled = /^cancel/.test(String(t.subscription_status || '')) && ms(t.canceled_at) >= at;
    const paidSince = firstPaid.has(t.id) ? firstPaid.get(t.id) : (Number.isFinite(ms(t.created_at)) && ms(t.created_at) < at ? -Infinity : Infinity);
    return a + (((isPaying(t) || cancelled) && paidSince < at) ? mrrOf(t) : 0);
  }, 0);
  const revenue = (p) => events ? events.filter((e) => inP(ms(e.created_at), p) && e.type === 'invoice.payment_succeeded').reduce((a, e) => a + num(e.amount), 0) : null;
  const signupsDaily = Array.from({ length: days }, () => 0);
  for (const t of T) { const t0 = ms(t.created_at); if (inP(t0, 'cur')) { const i = Math.min(days - 1, Math.floor((t0 - start) / DAY)); if (i >= 0) signupsDaily[i]++; } }
  const planMix = {};
  for (const t of T) if (isPaying(t)) { const p = normalizePlan(t.plan) || t.plan || 'none'; planMix[p] = (planMix[p] || 0) + 1; }
  const growth = {
    signups: both(count(T, (t) => t.created_at)),
    signups_daily: signupsDaily,
    new_paying: { cur: conversions('cur'), prev: conversions('prev') },
    trial_to_paid_pct: { cur: convRate('cur'), prev: convRate('prev') },
    mrr: { cur: mrrNow, prev: mrrAt(start), start_estimated: true },
    churned: both(count(T, (t) => (/^cancel/.test(String(t.subscription_status || '')) ? (t.canceled_at || null) : null))),
    revenue_cents: { cur: revenue('cur'), prev: revenue('prev') },
    plan_mix: planMix,
  };

  // ── Lola's work ──
  const callsIn = (x) => !/^out/i.test(String(x.direction || ''));
  const durOf = (x) => num(x.duration_seconds ?? x.duration_sec);
  const avgDur = (p) => { if (!calls) return null; const d = calls.filter((x) => inP(ms(x.created_at), p) && callsIn(x) && durOf(x) > 0).map(durOf); return d.length ? Math.round(d.reduce((a, b) => a + b, 0) / d.length) : null; };
  const convChan = new Map((convs || []).map((v) => [v.id, v.channel]));
  const lolaB = (bookings || []).filter(isLolaBooking);
  const bChan = (b) => channelOf(b.source) || channelOf(convChan.get(b.conversation_id)) || 'other';
  const valOf = (b) => num(b.total_amount);
  const live = (b) => !CANCELLED.test(String(b.status || ''));
  const byChannel = (p) => { const o = { phone: 0, sms: 0, web: 0, dm: 0, other: 0 }; for (const b of lolaB) if (inP(ms(b.created_at), p) && live(b)) o[bChan(b)]++; return o; };
  const convRateLola = (p) => { if (!convs || !bookings) return null; const n = convs.filter((v) => inP(ms(v.started_at), p)).length; const b = lolaB.filter((x) => inP(ms(x.created_at), p) && live(x)).length; return n ? Math.round(1000 * b / n) / 10 : null; };
  const lola = {
    calls: opt(calls, count(calls || [], (x) => x.created_at, callsIn)),
    avg_call_seconds: { cur: avgDur('cur'), prev: avgDur('prev') },
    texts_in: opt(usage, sum(usage || [], (e) => e.created_at, (e) => num(e.units) || 1, kinds('sms_received', 'whatsapp_received'))),
    texts_out: opt(usage, sum(usage || [], (e) => e.created_at, (e) => num(e.units) || 1, kinds('sms_sent', 'whatsapp_sent', 'textback_sent'))),
    dms: opt(usage, sum(usage || [], (e) => e.created_at, (e) => num(e.units) || 1, kinds('instagram_received', 'messenger_received'))),
    web_chats: opt(usage, sum(usage || [], (e) => e.created_at, (e) => num(e.units) || 1, kind('widget_message'))),
    conversations: opt(convs, count(convs || [], (v) => v.started_at)),
    bookings: opt(bookings, count(lolaB, (b) => b.created_at, live)),
    bookings_by_channel: bookings ? byChannel('cur') : null,
    conversion_pct: { cur: convRateLola('cur'), prev: convRateLola('prev') },
    value_created: opt(bookings, sum(lolaB, (b) => b.created_at, valOf, live)),           // dollars (bookings.total_amount)
    no_show_fees_cents: opt(payments, sum(payments || [], (x) => x.created_at, (x) => num(x.amount), (x) => x.status === 'succeeded')),
    reminders_sent: opt(reminders, count(reminders || [], (x) => x.sent_at || x.created_at, (x) => /^sent|delivered/.test(String(x.status || '')))),
    deposits_collected: opt(deposits, sum(deposits || [], (x) => x.created_at, (x) => num(x.amount), (x) => ['paid', 'kept', 'applied'].includes(String(x.status || '')))), // dollars
    waitlist_fills: opt(bookings, count(lolaB, (b) => b.created_at, (b) => /waitlist|gap/i.test(String(b.source || '')) && live(b))),
    rebooks: opt(rebooks, count(rebooks || [], (x) => x.updated_at || x.created_at, (x) => x.status === 'booked')),
    upsells_offered: opt(usage, count(usage || [], (e) => e.created_at, kind('upsell_offered'))),
    upsells_detected: opt(usage, count(usage || [], (e) => e.created_at, kind('upsell_detected'))),
  };

  // ── Costs & margin ──
  const costBy = (p) => { if (!costRows) return null; const o = {}; for (const e of costRows) if (inP(ms(e.created_at), p)) o[e.kind] = (o[e.kind] || 0) + costCents(e); return o; };
  const costTotal = (p) => { const o = costBy(p); return o ? Object.values(o).reduce((a, b) => a + b, 0) : null; };
  const feeTotal = (p) => fees ? fees.filter((f) => inP(ms(f.created_at), p) && ['pending', 'earned', 'billed'].includes(f.status)).reduce((a, f) => a + num(f.fee_cents), 0) : null;
  const margin = (p) => { const r = revenue(p), k = costTotal(p), f = feeTotal(p); return r == null && k == null ? null : (r || 0) + (f || 0) - (k || 0); };
  const costs = {
    total_cents: { cur: costTotal('cur'), prev: costTotal('prev') },
    by_type: costBy('cur'),
    fees_cents: { cur: feeTotal('cur'), prev: feeTotal('prev') },
    margin_cents: { cur: margin('cur'), prev: margin('prev') },
  };

  // ── Per salon (current range) ──
  const S = new Map();
  const row = (id) => {
    if (!S.has(id)) { const t = byTenant.get(id) || {}; S.set(id, { id, name: t.name || t.slug || null, plan: normalizePlan(t.plan) || t.plan || null, status: t.subscription_status || 'trial', billing_status: t.billing_status || null,
      bookings: 0, lola_bookings: 0, value_created: 0, calls: 0, texts: 0, chats: 0, cost_cents: 0, revenue_cents: 0, fees_cents: 0, margin_cents: 0, last_activity: null, mrr_cents: isPaying(t) ? mrrOf(t) : 0 }); }
    return S.get(id);
  };
  const touch = (r, at) => { if (!r.last_activity || ms(at) > ms(r.last_activity)) r.last_activity = at; };
  for (const t of T) row(t.id);
  for (const b of bookings || []) if (b.tenant_id && byTenant.has(b.tenant_id) && inP(ms(b.created_at), 'cur')) { const r = row(b.tenant_id); if (live(b)) r.bookings++; if (isLolaBooking(b) && live(b)) { r.lola_bookings++; r.value_created += valOf(b); } touch(r, b.created_at); }
  for (const x of calls || []) if (byTenant.has(x.tenant_id) && inP(ms(x.created_at), 'cur')) { const r = row(x.tenant_id); if (callsIn(x)) r.calls++; touch(r, x.created_at); }
  for (const e of usage || []) if (byTenant.has(e.tenant_id) && inP(ms(e.created_at), 'cur')) {
    const r = row(e.tenant_id);
    if (/^(sms|whatsapp)_(received|sent)$|^textback_sent$/.test(e.kind)) r.texts += num(e.units) || 1;
    if (/^(instagram|messenger)_received$|^widget_message$/.test(e.kind)) r.chats += num(e.units) || 1;
    if (e.kind !== 'widget_load') touch(r, e.created_at);
  }
  for (const v of convs || []) if (byTenant.has(v.tenant_id) && inP(ms(v.started_at), 'cur')) touch(row(v.tenant_id), v.started_at);
  for (const e of costRows || []) if (byTenant.has(e.tenant_id) && inP(ms(e.created_at), 'cur')) row(e.tenant_id).cost_cents += costCents(e);
  for (const e of events || []) if (byTenant.has(e.tenant_id) && inP(ms(e.created_at), 'cur') && e.type === 'invoice.payment_succeeded') row(e.tenant_id).revenue_cents += num(e.amount);
  for (const f of fees || []) if (byTenant.has(f.tenant_id) && inP(ms(f.created_at), 'cur') && ['pending', 'earned', 'billed'].includes(f.status)) row(f.tenant_id).fees_cents += num(f.fee_cents);
  const salons = [...S.values()].map((r) => ({ ...r, value_created: Math.round(r.value_created * 100) / 100, margin_cents: r.revenue_cents + r.fees_cents - r.cost_cents }));
  const withMoney = salons.filter((r) => r.revenue_cents || r.cost_cents || r.fees_cents);

  // ── Engagement & health ──
  const activeIds = new Set(salons.filter((r) => r.last_activity).map((r) => r.id));
  const recentBookings = new Set((bookings || []).filter((b) => ms(b.created_at) >= now - 14 * DAY).map((b) => b.tenant_id));
  const live14 = (t) => !/^cancel/.test(String(t.subscription_status || '')) && t.billing_status !== 'suspended';
  const atRisk = bookings == null ? null : T.filter((t) => live14(t) && ms(t.created_at) < now - 14 * DAY && !recentBookings.has(t.id))
    .map((t) => ({ id: t.id, name: t.name || t.slug, status: t.subscription_status || 'trial', mrr_cents: isPaying(t) ? mrrOf(t) : 0, last_activity: S.get(t.id)?.last_activity || null }))
    .sort((a, b) => b.mrr_cents - a.mrr_cents).slice(0, 25);
  const resolveHours = (p) => { if (!tickets) return null; const h = tickets.filter((x) => inP(ms(x.created_at), p) && Number.isFinite(ms(x.resolved_at))).map((x) => (ms(x.resolved_at) - ms(x.created_at)) / 36e5); const m = median(h); return m == null ? null : Math.round(m * 10) / 10; };
  const activeIn = (p) => {
    const ids = new Set();
    const add = (list, at) => { for (const x of list || []) if (x.tenant_id && byTenant.has(x.tenant_id) && inP(ms(at(x)), p)) ids.add(x.tenant_id); };
    add(bookings, (x) => x.created_at); add(calls, (x) => x.created_at); add(convs, (x) => x.started_at); add((usage || []).filter((e) => e.kind !== 'widget_load'), (x) => x.created_at);
    return ids.size;
  };
  const engagement = {
    active_salons: { cur: activeIn('cur'), prev: activeIn('prev') },
    salons: T.length,
    at_risk: atRisk,
    widget_loads: opt(usage, sum(usage || [], (e) => e.created_at, (e) => num(e.units) || 1, kind('widget_load'))),
    web_bookings: opt(bookings, count(lolaB, (b) => b.created_at, (b) => bChan(b) === 'web' && live(b))),
    tickets: opt(tickets, count(tickets || [], (x) => x.created_at)),
    median_resolve_hours: { cur: resolveHours('cur'), prev: resolveHours('prev') },
    leaders: salons.filter((r) => r.bookings || r.value_created).sort((a, b) => b.value_created - a.value_created || b.bookings - a.bookings).slice(0, 5)
      .map((r) => ({ id: r.id, name: r.name, bookings: r.bookings, lola_bookings: r.lola_bookings, value_created: r.value_created })),
  };
  costs.most_profitable = withMoney.slice().sort((a, b) => b.margin_cents - a.margin_cents).slice(0, 5).map((r) => ({ id: r.id, name: r.name, margin_cents: r.margin_cents, cost_cents: r.cost_cents }));
  costs.least_profitable = withMoney.slice().sort((a, b) => a.margin_cents - b.margin_cents).slice(0, 5).map((r) => ({ id: r.id, name: r.name, margin_cents: r.margin_cents, cost_cents: r.cost_cents }));
  costs.per_salon_avg_cents = costTotal('cur') == null || !T.length ? null : Math.round(costTotal('cur') / T.length);

  const sources = { tenants: tenants != null, billing_events: events != null, usage_events: usage != null, costs: costRows != null, calls: calls != null, conversations: convs != null,
    bookings: bookings != null, booking_fees: fees != null, payments: payments != null, deposits: deposits != null, rebooking_offers: rebooks != null, booking_reminders: reminders != null, support_tickets: tickets != null };
  return {
    range: { days, start: new Date(start).toISOString(), end: new Date(end).toISOString(), prev_start: new Date(prevStart).toISOString() },
    growth, lola, costs, engagement,
    salons: salons.sort((a, b) => b.value_created - a.value_created || b.bookings - a.bookings || String(a.name || '').localeCompare(String(b.name || ''))),
    sources, capped,
  };
}

const CSV_COLS = [['name', 'Salon'], ['plan', 'Plan'], ['status', 'Status'], ['bookings', 'Bookings'], ['lola_bookings', 'Lola bookings'], ['value_created', 'Value created ($)'],
  ['calls', 'Calls'], ['texts', 'Texts'], ['chats', 'DMs + web chats'], ['mrr_cents', 'MRR ($)'], ['revenue_cents', 'Revenue collected ($)'], ['fees_cents', 'Booking fees ($)'],
  ['cost_cents', 'Platform cost ($)'], ['margin_cents', 'Margin ($)'], ['last_activity', 'Last activity']];
const cell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !Number.isFinite(Number(s))) s = "'" + s;          // no spreadsheet formulas from salon names
  return /[",\n\r']/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export function salonsCsv(a) {
  const lines = [CSV_COLS.map((c) => c[1]).join(',')];
  for (const r of a.salons || []) lines.push(CSV_COLS.map(([k]) => cell(/_cents$/.test(k) ? (num(r[k]) / 100).toFixed(2) : r[k])).join(','));
  return lines.join('\n') + '\n';
}
