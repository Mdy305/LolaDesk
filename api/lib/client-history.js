/**
 * api/lib/client-history.js — who is due back, and when.
 * One pass over a salon's clients and their last year of bookings:
 *   · visits, last visit, typical gap between visits (their own rhythm)
 *   · their usual service, and that service's natural cadence when they
 *     don't have a rhythm yet (color ~6 weeks, cut ~5, nails ~3, lashes ~3…)
 *   · whether they already have something booked (never market to them)
 * Used by Lola Marketing's audiences and the 30-day fill plan.
 */
import { e164 } from './db.js';

const DAY = 864e5;
const CANCELLED = /^(cancel|no[-_ ]?show|declined|void)/i;

// Natural rebooking rhythm by service name/category (days).
const CADENCE = [
  [/root|touch.?up|retouch/i, 35],
  [/colou?r|balayage|highlight|ombr|gloss|toner|tint|dye/i, 42],
  [/keratin|brazilian|smoothing|perm|relax/i, 90],
  [/extension|tape.?in|weft|install/i, 56],
  [/lash|lift/i, 21],
  [/brow|wax|thread/i, 28],
  [/nail|mani|pedi|gel|acrylic|dip/i, 21],
  [/facial|peel|hydra|derma|micro/i, 35],
  [/botox|dysport|neuro|filler|injectable/i, 100],
  [/massage/i, 30],
  [/blow.?out|blowdry|style|updo/i, 10],
  [/barber|fade|beard|line.?up/i, 21],
  [/cut|trim|haircut/i, 42],
];
export function cadenceFor(text) {
  const t = String(text || '');
  for (const [re, d] of CADENCE) if (re.test(t)) return d;
  return 45;
}

const optedOut = (cl) => cl.opted_out === true || String(cl.status || '').toLowerCase() === 'opted_out';
const firstOf = (cl) => String(cl?.first_name || String(cl?.name || '').split(' ')[0] || '').trim();

async function rows(p) { try { const r = await p; return (r && !r.error && Array.isArray(r.data)) ? r.data : []; } catch { return []; } }

/**
 * @returns Map<client_id, {client, phone, first, visits, lastVisit, avgGap,
 *   usualService, cadence, dueAt, upcoming, spend, textable}>
 */
export async function clientHistory(c, tenantId, { now = new Date(), clients = null } = {}) {
  const all = clients || await rows(c.from('clients').select('*').eq('tenant_id', tenantId).limit(5000));
  const since = new Date(now.getTime() - 400 * DAY).toISOString();
  const [bookings, services] = await Promise.all([
    rows(c.from('bookings').select('client_id,service_id,start_time,status,total_amount').eq('tenant_id', tenantId).gte('start_time', since).limit(20000)),
    rows(c.from('services').select('id,name,category').eq('tenant_id', tenantId).limit(1000)),
  ]);
  const svc = new Map(services.map(s => [s.id, s]));
  const byClient = new Map();
  for (const b of bookings) {
    if (!b.client_id || CANCELLED.test(b.status || '')) continue;
    if (!byClient.has(b.client_id)) byClient.set(b.client_id, []);
    byClient.get(b.client_id).push(b);
  }
  const out = new Map();
  const t0 = now.getTime();
  for (const cl of all) {
    if (!cl || !cl.id) continue;
    const list = (byClient.get(cl.id) || []).slice().sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
    const past = list.filter(b => Date.parse(b.start_time) <= t0);
    const upcoming = list.some(b => Date.parse(b.start_time) > t0);
    const times = past.map(b => Date.parse(b.start_time));
    let lastVisit = times.length ? times[times.length - 1] : (cl.last_visit ? Date.parse(cl.last_visit) : null);
    if (lastVisit && !Number.isFinite(lastVisit)) lastVisit = null;
    let avgGap = null;
    if (times.length >= 2) {
      const gaps = []; for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / DAY);
      const good = gaps.filter(g => g >= 5 && g <= 200).sort((a, b) => a - b);
      if (good.length) avgGap = good[Math.floor(good.length / 2)];   // median
    }
    const counts = new Map();
    for (const b of past) if (b.service_id) counts.set(b.service_id, (counts.get(b.service_id) || 0) + 1);
    const topId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const top = topId ? svc.get(topId) : null;
    const usualService = top ? top.name : null;
    const cadence = Math.round(avgGap || cadenceFor(`${top?.name || ''} ${top?.category || ''}`));
    const phone = e164(cl.phone);
    out.set(cl.id, {
      client: cl, phone, first: firstOf(cl), visits: Math.max(past.length, cl.last_visit && !past.length ? 1 : 0),
      lastVisit, avgGap, usualService, cadence,
      dueAt: lastVisit ? lastVisit + cadence * DAY : null,
      upcoming, spend: past.reduce((s, b) => s + (Number(b.total_amount) || 0), 0) || Number(cl.lifetime_value) || 0,
      textable: !!phone && !optedOut(cl),
    });
  }
  return out;
}

/** The plan's audiences, from one history pass. Everyone here is textable and has nothing booked. */
export function planSegments(history, { now = new Date() } = {}) {
  const t0 = now.getTime();
  const open = [...history.values()].filter(h => h.textable && !h.upcoming);
  const due = open.filter(h => h.dueAt && h.dueAt <= t0 + 30 * DAY && h.dueAt >= t0 - 45 * DAY && h.visits >= 1);
  const dueIds = new Set(due.map(h => h.client.id));
  const secondVisit = open.filter(h => h.visits === 1 && !dueIds.has(h.client.id) && h.lastVisit && t0 - h.lastVisit >= 21 * DAY && t0 - h.lastVisit <= 150 * DAY);
  const svIds = new Set(secondVisit.map(h => h.client.id));
  const lapsed = open.filter(h => h.lastVisit && t0 - h.lastVisit > 90 * DAY && !dueIds.has(h.client.id) && !svIds.has(h.client.id));
  const spends = open.map(h => h.spend).filter(v => v > 0).sort((a, b) => b - a);
  const top10 = spends.length ? spends[Math.max(0, Math.floor(spends.length * 0.1) - 1)] : Infinity;
  const vip = open.filter(h => h.client.is_vip === true || String(h.client.status || '').toLowerCase() === 'vip' || (h.spend > 0 && h.spend >= top10 && h.visits >= 3));
  const recent = open.filter(h => h.lastVisit && t0 - h.lastVisit <= 30 * DAY);
  return { due, second_visit: secondVisit, lapsed, vip, recent, textable: open.length, total: history.size };
}
