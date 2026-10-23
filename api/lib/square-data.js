/**
 * api/lib/square-data.js — the salon's Square sales, inside LolaBrain.
 * ═══════════════════════════════════════════════════════════════════
 * Read-only (PAYMENTS_READ, ORDERS_READ, CUSTOMERS_READ). Lola never moves money.
 *
 *   importSquareSales(c, integration)  → 13 months of payments + orders into a compact ledger
 *        (platform_settings key "square_sales:<tenant>"), resumable month by month, then the
 *        last 3 days re-read each run (late refunds, tips). Square customers → LolaDesk clients
 *        (name, phone, email, lifetime spend, last visit, usual service) so every existing
 *        audience — lapsed, VIP, due, came-once — works on the salon's real Square history.
 *   runSquareImports(c)                → every connected Square salon, a slice each run (cron).
 *   squareInsights(c, tenant, opts)    → revenue, trends, services, clients, staff, busiest times,
 *        and the marketing moves worth making — each with its audience and value.
 */
import { e164 } from './db.js';

const DAY = 864e5;
const KEEP_DAYS = 400, BACKFILL_DAYS = 395, WINDOW_DAYS = 31, REREAD_DAYS = 3;
const keyOf = (tid) => 'square_sales:' + tid;
const cents = (m) => Math.round(Number(m?.amount) || 0);
const dollars = (c) => Math.round((Number(c) || 0) / 100);
export const money = (c) => '$' + dollars(c).toLocaleString('en-US');
const pct = (a, b) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);
const sq = () => import('./connectors/square.js');

function parts(iso, tz) {
  const d = new Date(iso);
  try {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' });
    const o = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
    return { day: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour) % 24, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday) };
  } catch (_) { return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours(), dow: d.getUTCDay() }; }
}

// ── Storage: the salon_sales / salon_sale_items tables (one row per payment / order line). When the
// database can't create them yet, the same data lives in one platform_settings row — nothing is lost.
let tablesOk = null;
export function resetSalesTables(){ tablesOk = null; }
export async function salesTables(){
  if (tablesOk != null) return tablesOk;
  try { const { ensureSalesSchema } = await import('./migrate.js'); const st = await ensureSalesSchema(); tablesOk = st === 'up-to-date' || st === 'applied'; }
  catch (_) { tablesOk = false; }
  return tablesOk;
}
async function pageAll(make, size = 1000, maxPages = 80) {
  const out = [], seen = new Set();
  for (let i = 0; i < maxPages; i++) {
    const { data, error } = await make().range(i * size, i * size + size - 1);
    if (error) throw new Error(error.message || 'read failed');
    const fresh = (data || []).filter((r) => !seen.has(r.id) && seen.add(r.id));
    out.push(...fresh);
    if (!data || data.length < size || !fresh.length) break;
  }
  return out;
}
const META_KEYS = ['v', 'tz', 'done_until', 'backfilled', 'updated_at', 'clients_at', 'client_sync'];

export async function loadLedger(c, tenantId) {
  let meta = {};
  try {
    const { data } = await c.from('platform_settings').select('value').eq('key', keyOf(tenantId)).maybeSingle();
    if (data?.value && typeof data.value === 'object') meta = data.value;
  } catch (_) {}
  if (!(await salesTables())) return { v: 1, payments: {}, orders: {}, ...meta, store: 'blob' };
  const led = { v: 2, ...Object.fromEntries(META_KEYS.filter((k) => meta[k] != null).map((k) => [k, meta[k]])), payments: {}, orders: {}, store: 'tables' };
  const cut = new Date(Date.now() - KEEP_DAYS * DAY).toISOString().slice(0, 10);
  try {
    const sales = await pageAll(() => c.from('salon_sales').select('id,external_id,occurred_at,day,hour,dow,net_cents,tip_cents,customer_ref,order_ref,team_ref').eq('tenant_id', tenantId).eq('provider', 'square').gte('day', cut).order('day', { ascending: true }));
    for (const r of sales) led.payments[r.external_id] = [String(r.day).slice(0, 10), r.hour, r.dow, Number(r.net_cents) || 0, Number(r.tip_cents) || 0, r.customer_ref || null, r.order_ref || null, r.team_ref || null, r.occurred_at || null];
    const items = await pageAll(() => c.from('salon_sale_items').select('id,order_ref,line_no,day,customer_ref,name,quantity,total_cents').eq('tenant_id', tenantId).eq('provider', 'square').gte('day', cut).order('day', { ascending: true }));
    const byOrder = new Map();
    for (const r of items) { if (!byOrder.has(r.order_ref)) byOrder.set(r.order_ref, { day: String(r.day).slice(0, 10), cust: r.customer_ref || null, lines: [] }); byOrder.get(r.order_ref).lines.push(r); }
    for (const [id, o] of byOrder) led.orders[id] = [o.day, o.cust, o.lines.sort((a, b) => a.line_no - b.line_no).map((l) => [l.name, Number(l.quantity) || 1, Number(l.total_cents) || 0])];
  } catch (_) {
    // Tables unreadable right now: fall back to whatever the blob still holds.
    return { v: 1, payments: {}, orders: {}, ...meta, store: 'blob' };
  }
  // A salon imported before the tables existed: its history moves into them on the next save.
  if (!Object.keys(led.payments).length && meta.payments && Object.keys(meta.payments).length) {
    led.payments = meta.payments; led.orders = meta.orders || {};
    led._migrate = true;
  }
  return led;
}

async function saveLedger(c, tenantId, led) {
  const meta = Object.fromEntries(META_KEYS.filter((k) => led[k] != null).map((k) => [k, led[k]]));
  try {
    if (led.store === 'tables') {
      const { data: cl } = await c.from('clients').select('id,preferences').eq('tenant_id', tenantId).limit(10000).then((x) => x, () => ({ data: [] }));
      const clientOf = new Map((cl || []).filter((x) => x.preferences?.square_id).map((x) => [x.preferences.square_id, x.id]));
      const pIds = led._migrate ? Object.keys(led.payments) : [...(led._dirtyP || [])];
      const oIds = led._migrate ? Object.keys(led.orders) : [...(led._dirtyO || [])];
      const stamp = new Date().toISOString();
      const sales = pIds.filter((id) => led.payments[id]).map((id) => { const [day, hour, dow, net, tip, cust, order, team, at] = led.payments[id]; return {
        tenant_id: tenantId, provider: 'square', external_id: id, occurred_at: at || new Date(day + 'T17:00:00Z').toISOString(),
        day, hour, dow, net_cents: net, tip_cents: tip, customer_ref: cust, client_id: (cust && clientOf.get(cust)) || null, order_ref: order, team_ref: team, synced_at: stamp }; });
      for (let i = 0; i < sales.length; i += 500) { const r = await c.from('salon_sales').upsert(sales.slice(i, i + 500), { onConflict: 'tenant_id,provider,external_id' }); if (r?.error) throw new Error(r.error.message); }
      const drop = [...(led._dropP || [])];
      for (let i = 0; i < drop.length; i += 200) await c.from('salon_sales').delete().eq('tenant_id', tenantId).eq('provider', 'square').in('external_id', drop.slice(i, i + 200));
      const lines = [];
      for (const id of oIds) { const o = led.orders[id]; if (!o) continue; (o[2] || []).forEach(([name, qty, ct], i) => lines.push({ tenant_id: tenantId, provider: 'square', order_ref: id, line_no: i, day: o[0], customer_ref: o[1], client_id: (o[1] && clientOf.get(o[1])) || null, name, quantity: qty, total_cents: ct, synced_at: stamp })); }
      for (let i = 0; i < lines.length; i += 500) { const r = await c.from('salon_sale_items').upsert(lines.slice(i, i + 500), { onConflict: 'tenant_id,provider,order_ref,line_no' }); if (r?.error) throw new Error(r.error.message); }
      // Keep 13 months in the tables too.
      const cut = new Date(Date.now() - KEEP_DAYS * DAY).toISOString().slice(0, 10);
      await c.from('salon_sales').delete().eq('tenant_id', tenantId).eq('provider', 'square').lt('day', cut).then((x) => x, () => null);
      await c.from('salon_sale_items').delete().eq('tenant_id', tenantId).eq('provider', 'square').lt('day', cut).then((x) => x, () => null);
      await c.from('platform_settings').upsert({ key: keyOf(tenantId), value: { ...meta, v: 2, rows: Object.keys(led.payments).length }, updated_at: stamp }, { onConflict: 'key' });
      led._dirtyP = new Set(); led._dirtyO = new Set(); led._dropP = new Set(); led._migrate = false;
      return true;
    }
    await c.from('platform_settings').upsert({ key: keyOf(tenantId), value: { ...meta, v: 1, payments: led.payments, orders: led.orders }, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    return true;
  } catch (e) { console.warn('[square-data] save:', String(e?.message || e).slice(0, 160)); return false; }
}

async function locationIds(S, integ) {
  if (integ.metadata?.location_id) return [integ.metadata.location_id];
  try { const a = await S.describeAccount(integ); return a.location_id ? [a.location_id] : []; } catch (_) { return []; }
}

/** One window of Square payments + orders into the ledger. */
async function importWindow(S, integ, led, from, to, tz, locs) {
  let cursor = null, pages = 0;
  do {
    const q = new URLSearchParams({ begin_time: from.toISOString(), end_time: to.toISOString(), sort_order: 'ASC', limit: '100' });
    if (locs[0]) q.set('location_id', locs[0]);
    if (cursor) q.set('cursor', cursor);
    const d = await S.squareCall(integ, `/v2/payments?${q}`);
    for (const p of d.payments || []) {
      if (String(p.status || '').toUpperCase() !== 'COMPLETED') { if (led.payments[p.id]) (led._dropP ||= new Set()).add(p.id); delete led.payments[p.id]; continue; }
      const t = parts(p.created_at, tz);
      const net = cents(p.amount_money) - cents(p.refunded_money);
      led.payments[p.id] = [t.day, t.hour, t.dow, net, cents(p.tip_money), p.customer_id || null, p.order_id || null, p.team_member_id || p.employee_id || null, p.created_at || null];
      (led._dirtyP ||= new Set()).add(p.id);
    }
    cursor = d.cursor || null;
  } while (cursor && ++pages < 60);
  cursor = null; pages = 0;
  do {
    const d = await S.squareCall(integ, '/v2/orders/search', { method: 'POST', body: {
      ...(locs.length ? { location_ids: locs } : {}), limit: 500, ...(cursor ? { cursor } : {}),
      query: { filter: { state_filter: { states: ['COMPLETED'] }, date_time_filter: { closed_at: { start_at: from.toISOString(), end_at: to.toISOString() } } }, sort: { sort_field: 'CLOSED_AT', sort_order: 'ASC' } } } });
    for (const o of d.orders || []) {
      const t = parts(o.closed_at || o.created_at, tz);
      const items = (o.line_items || []).map((li) => [String(li.name || li.variation_name || 'Item').slice(0, 60), Number(li.quantity) || 1, cents(li.total_money)]);
      led.orders[o.id] = [t.day, o.customer_id || null, items];
      (led._dirtyO ||= new Set()).add(o.id);
    }
    cursor = d.cursor || null;
  } while (cursor && ++pages < 30);
}

/** Square customers → LolaDesk clients (+ their Square spend, last visit, usual service). */
async function syncClients(c, S, integ, led, { now = Date.now(), max = 5000 } = {}) {
  const tid = integ.tenant_id;
  const sqCust = [];
  let cursor = null, pages = 0;
  do {
    const q = new URLSearchParams({ limit: '100' }); if (cursor) q.set('cursor', cursor);
    const d = await S.squareCall(integ, `/v2/customers?${q}`);
    sqCust.push(...(d.customers || []));
    cursor = d.cursor || null;
  } while (cursor && ++pages < Math.ceil(max / 100));
  const stats = customerStats(led, { now });
  const { data: existing } = await c.from('clients').select('*').eq('tenant_id', tid).limit(10000).then((x) => x, () => ({ data: [] }));
  const byPhone = new Map(), byEmail = new Map(), bySq = new Map();
  for (const cl of existing || []) {
    if (cl.phone) byPhone.set(e164(cl.phone) || cl.phone, cl);
    if (cl.email) byEmail.set(String(cl.email).toLowerCase(), cl);
    const sid = cl.preferences?.square_id; if (sid) bySq.set(sid, cl);
  }
  let created = 0, updated = 0;
  for (const sc of sqCust) {
    const phone = e164(sc.phone_number || '') || null;
    const email = sc.email_address ? String(sc.email_address).toLowerCase() : null;
    if (!phone && !email) continue;
    const st = stats.get(sc.id) || null;
    const cl = bySq.get(sc.id) || (phone && byPhone.get(phone)) || (email && byEmail.get(email)) || null;
    const lastIso = st?.last ? new Date(st.last + 'T17:00:00Z').toISOString() : null;
    if (!cl) {
      const row = { tenant_id: tid, first_name: sc.given_name || 'Client', last_name: sc.family_name || null, phone, email,
        lifetime_value: st ? dollars(st.spend) : 0, last_visit: lastIso, preferred_service: st?.top || null,
        preferences: { square_id: sc.id, square_visits: st?.visits || 0, square_since: sc.created_at || null }, updated_at: new Date().toISOString() };
      const { error } = await c.from('clients').insert(row).then((x) => x, (e) => ({ error: e }));
      if (!error) created++;
      continue;
    }
    const patch = {};
    const prefs = { ...(cl.preferences || {}) };
    if (prefs.square_id !== sc.id || prefs.square_visits !== (st?.visits || 0)) { prefs.square_id = sc.id; prefs.square_visits = st?.visits || 0; patch.preferences = prefs; }
    if (st && dollars(st.spend) > Number(cl.lifetime_value || 0)) patch.lifetime_value = dollars(st.spend);
    if (lastIso && (!cl.last_visit || Date.parse(lastIso) > Date.parse(cl.last_visit))) patch.last_visit = lastIso;
    if (st?.top && !cl.preferred_service) patch.preferred_service = st.top;
    if ((!cl.first_name || cl.first_name === 'Client') && sc.given_name) { patch.first_name = sc.given_name; if (sc.family_name) patch.last_name = sc.family_name; }
    if (!cl.email && email) patch.email = email;
    if (Object.keys(patch).length) {
      patch.updated_at = new Date().toISOString();
      const { error } = await c.from('clients').update(patch).eq('id', cl.id).eq('tenant_id', tid).then((x) => x, (e) => ({ error: e }));
      if (!error) updated++;
    }
  }
  return { square_customers: sqCust.length, created, updated };
}

/** Per Square customer: spend (cents, 12 months), visits (distinct days), first/last day, top item. */
export function customerStats(led, { now = Date.now() } = {}) {
  const cut = new Date(now - 365 * DAY).toISOString().slice(0, 10);
  const m = new Map();
  const get = (id) => { if (!m.has(id)) m.set(id, { spend: 0, days: new Set(), first: null, last: null, items: new Map() }); return m.get(id); };
  for (const [day, , , net, , cust] of Object.values(led.payments || {})) {
    if (!cust) continue;
    const s = get(cust);
    if (day >= cut) s.spend += net;
    s.days.add(day);
    if (!s.first || day < s.first) s.first = day;
    if (!s.last || day > s.last) s.last = day;
  }
  for (const [, cust, items] of Object.values(led.orders || {})) {
    if (!cust) continue;
    const s = get(cust);
    for (const [name, , ct] of items || []) s.items.set(name, (s.items.get(name) || 0) + (ct || 1));
  }
  for (const s of m.values()) { s.visits = s.days.size; s.top = [...s.items.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null; delete s.days; }
  return m;
}

/** Import (or catch up) one salon's Square sales within a time budget. Resumable. */
export async function importSquareSales(c, integ, { now = Date.now(), budgetMs = 25000, clients = true } = {}) {
  const started = Date.now();
  const S = await sq();
  const led = await loadLedger(c, integ.tenant_id);
  const tz = integ.metadata?.tz || led.tz || 'America/New_York';
  led.tz = tz;
  const locs = await locationIds(S, integ);
  const floor = now - BACKFILL_DAYS * DAY;
  let from = led.done_until ? Math.min(Date.parse(led.done_until), now - REREAD_DAYS * DAY) : floor;
  from = Math.max(from, floor);
  let windows = 0, error = null;
  try {
    while (from < now && (windows === 0 || Date.now() - started < budgetMs)) {   // at least one window per run
      const to = Math.min(now, from + WINDOW_DAYS * DAY);
      await importWindow(S, integ, led, new Date(from), new Date(to), tz, locs);
      led.done_until = new Date(to).toISOString();
      from = to; windows++;
    }
  } catch (e) { error = String(e?.message || e).slice(0, 200); if (e?.code === 'square_auth') { await saveLedger(c, integ.tenant_id, led); return { ok: false, error }; } }
  // Keep 13 months.
  const cut = new Date(now - KEEP_DAYS * DAY).toISOString().slice(0, 10);
  for (const [id, p] of Object.entries(led.payments)) if (p[0] < cut) delete led.payments[id];
  for (const [id, o] of Object.entries(led.orders)) if (o[0] < cut) delete led.orders[id];
  led.backfilled = !!led.done_until && Date.parse(led.done_until) >= now - REREAD_DAYS * DAY - 60e3;
  led.updated_at = new Date(now).toISOString();
  let cl = null;
  const clientsDue = !led.clients_at || now - Date.parse(led.clients_at) > 20 * 3600e3;
  if (clients && led.backfilled && clientsDue && Date.now() - started < budgetMs + 15000) {
    try { cl = await syncClients(c, S, integ, led, { now }); led.clients_at = new Date(now).toISOString(); led.client_sync = cl; if (led.store === 'tables') led._migrate = true; /* every sale gets its LolaDesk client */ } catch (e) { if (!error) error = String(e?.message || e).slice(0, 200); }
  }
  await saveLedger(c, integ.tenant_id, led);
  return { ok: !error, error, windows, backfilled: led.backfilled, payments: Object.keys(led.payments).length, orders: Object.keys(led.orders).length, clients: cl };
}

/** Every connected Square salon: catch up those not imported in the last 6 hours (cron, every 15 min). */
export async function runSquareImports(c, { now = Date.now(), budgetMs = 30000 } = {}) {
  const started = Date.now();
  const { squareRows } = await import('./square-care.js');
  const out = [];
  for (const integ of await squareRows(c, { status: 'connected' })) {
    if (Date.now() - started > budgetMs) break;
    const scopes = integ.metadata?.scopes;
    if (Array.isArray(scopes) && !scopes.includes('PAYMENTS_READ')) { out.push({ tenant: integ.tenant_id, skipped: 'needs_reconnect' }); continue; }
    const led = await loadLedger(c, integ.tenant_id);
    if (led.backfilled && led.updated_at && now - Date.parse(led.updated_at) < 6 * 3600e3) { out.push({ tenant: integ.tenant_id, skipped: 'fresh' }); continue; }
    try { out.push({ tenant: integ.tenant_id, ...(await importSquareSales(c, integ, { now, budgetMs: Math.max(5000, budgetMs - (Date.now() - started)) })) }); }
    catch (e) { out.push({ tenant: integ.tenant_id, ok: false, error: String(e?.message || e).slice(0, 200) }); }
  }
  return out;
}

// ══ Campaigns → real Square money (attribution) ══
export const MOVE_NAMES = { win_back: 'Win back regulars', second_visit: 'Bring first-timers back', slow_day: 'Slow-day offer', ticket: 'Add-on for tomorrow', vip: 'VIP thank-you' };
export function moveKeyOf(name = '') {
  const n = String(name || '').toLowerCase();
  for (const [k, label] of Object.entries(MOVE_NAMES)) if (n.startsWith(label.toLowerCase())) return k;
  if (/win.?back|miss you|lapsed/.test(n)) return 'win_back';
  if (/second|first.?time|came once/.test(n)) return 'second_visit';
  if (/slow|weekday|tuesday|monday|wednesday/.test(n)) return 'slow_day';
  if (/vip|thank/.test(n)) return 'vip';
  if (/add.?on|upsell|upgrade/.test(n)) return 'ticket';
  return null;
}
const ATTRIBUTION_DAYS = 14;
/** Each campaign: texts sent, clients who came back and paid in Square within 14 days, and that revenue. */
export async function campaignResults(c, tenantId, led, clients = [], { now = Date.now(), days = 240 } = {}) {
  try {
    const { data: camps } = await c.from('lola_campaigns').select('id,name,segment,status,created_at,started_at').eq('tenant_id', tenantId).gte('created_at', new Date(now - days * DAY).toISOString()).order('created_at', { ascending: false }).limit(100);
    if (!camps?.length) return [];
    const { data: recs } = await c.from('lola_campaign_recipients').select('campaign_id,client_id,status,sent_at').in('campaign_id', camps.map((x) => x.id)).eq('status', 'sent').limit(50000);
    const sqOf = new Map(clients.filter((x) => x.preferences?.square_id).map((x) => [x.id, x.preferences.square_id]));
    const paid = new Map();
    for (const [day, , , net, , cust, , , at] of Object.values(led.payments || {})) { if (!cust) continue; if (!paid.has(cust)) paid.set(cust, []); paid.get(cust).push([Date.parse(at || day + 'T17:00:00Z'), net]); }
    return camps.map((camp) => {
      const mine = (recs || []).filter((r) => r.campaign_id === camp.id);
      let returned = 0, revenue = 0;
      for (const r of mine) {
        const cust = sqOf.get(r.client_id); if (!cust) continue;
        const t0 = Date.parse(r.sent_at || camp.started_at || camp.created_at);
        const hits = (paid.get(cust) || []).filter(([t]) => t > t0 && t <= t0 + ATTRIBUTION_DAYS * DAY);
        if (hits.length) { returned++; revenue += hits.reduce((x, [, n]) => x + n, 0); }
      }
      const texts = mine.length;
      return { id: camp.id, name: camp.name, key: moveKeyOf(camp.name), segment: camp.segment, status: camp.status, sent_at: camp.started_at || camp.created_at,
        texts, returned, revenue: dollars(revenue), per_text: texts ? Math.round(dollars(revenue) / texts * 10) / 10 : 0, return_rate: texts ? Math.round((returned / texts) * 100) : 0 };
    });
  } catch (_) { return []; }
}
export function learnFrom(list = []) {
  const byKey = {};
  for (const x of list) {
    if (!x.key || !x.texts) continue;
    const k = byKey[x.key] || (byKey[x.key] = { campaigns: 0, texts: 0, returned: 0, revenue: 0 });
    k.campaigns++; k.texts += x.texts; k.returned += x.returned; k.revenue += x.revenue;
  }
  for (const k of Object.values(byKey)) { k.per_text = k.texts ? Math.round((k.revenue / k.texts) * 10) / 10 : 0; k.return_rate = k.texts ? Math.round((k.returned / k.texts) * 100) : 0; }
  return { list, byKey };
}

// ══ Insights ══
const sum = (a) => a.reduce((t, x) => t + x, 0);
function monthKey(day) { return day.slice(0, 7); }
function addMonths(key, n) { const [y, m] = key.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); }
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Everything worth knowing, from the ledger (+ LolaDesk clients for phones/opt-outs). Pure. */
export function insightsFrom(led, { now = Date.now(), clients = [], staffNames = new Map(), campaigns = [] } = {}) {
  const tz = led.tz || 'America/New_York';
  const today = parts(new Date(now).toISOString(), tz).day;
  const pays = Object.values(led.payments || {});
  const orders = Object.values(led.orders || {});
  if (!pays.length) return { ok: false, empty: true, backfilled: !!led.backfilled };
  const thisM = monthKey(today), lastM = addMonths(thisM, -1), lyM = addMonths(thisM, -12);
  const dayOfMonth = Number(today.slice(8, 10));
  const inMonth = (k) => pays.filter((p) => monthKey(p[0]) === k);
  const toDate = (k) => pays.filter((p) => monthKey(p[0]) === k && Number(p[0].slice(8, 10)) <= dayOfMonth);
  const rev = (list) => sum(list.map((p) => p[3]));
  const daysAgo = (n) => new Date(Date.parse(today + 'T12:00:00Z') - n * DAY).toISOString().slice(0, 10);
  const range = (a, b) => pays.filter((p) => p[0] > daysAgo(a) && p[0] <= daysAgo(b));
  const last30 = range(30, 0), prev30 = range(60, 30);
  const months = []; for (let i = 11; i >= 0; i--) { const k = addMonths(thisM, -i); const l = inMonth(k); months.push({ month: k, revenue: dollars(rev(l)), visits: l.length }); }
  const revenue = {
    this_month: dollars(rev(inMonth(thisM))), last_month: dollars(rev(inMonth(lastM))),
    month_to_date_vs_last_month: pct(rev(inMonth(thisM)), rev(toDate(lastM))),
    vs_same_month_last_year: inMonth(lyM).length ? pct(rev(toDate(thisM)), rev(toDate(lyM))) : null,
    last_30_days: dollars(rev(last30)), prev_30_days: dollars(rev(prev30)), trend_30d: pct(rev(last30), rev(prev30)),
    tips_30d: dollars(sum(last30.map((p) => p[4]))), transactions_30d: last30.length,
    avg_ticket_30d: last30.length ? dollars(rev(last30) / last30.length) : 0,
    avg_ticket_prev_30d: prev30.length ? dollars(rev(prev30) / prev30.length) : 0,
    months,
  };
  // Services / products (orders), last 90 days vs the 90 before.
  const o90 = orders.filter((o) => o[0] > daysAgo(90)), oPrev = orders.filter((o) => o[0] > daysAgo(180) && o[0] <= daysAgo(90));
  const byItem = (list) => { const m = new Map(); for (const o of list) for (const [n, q, ct] of o[2] || []) { const x = m.get(n) || { revenue: 0, count: 0 }; x.revenue += ct; x.count += q; m.set(n, x); } return m; };
  const nowItems = byItem(o90), prevItems = byItem(oPrev);
  const services = [...nowItems.entries()].map(([name, x]) => ({ name, revenue_90d: dollars(x.revenue), sold_90d: x.count, trend: pct(x.revenue, prevItems.get(name)?.revenue || 0) }))
    .sort((a, b) => b.revenue_90d - a.revenue_90d).slice(0, 10);
  const falling = [...prevItems.entries()].filter(([n, x]) => x.revenue > 0 && (nowItems.get(n)?.revenue || 0) < x.revenue * 0.6)
    .map(([name, x]) => ({ name, was_90d: dollars(x.revenue), now_90d: dollars(nowItems.get(name)?.revenue || 0) })).sort((a, b) => b.was_90d - a.was_90d).slice(0, 3);
  // Clients.
  const stats = customerStats(led, { now });
  const clientsBySq = new Map(clients.filter((cl) => cl.preferences?.square_id).map((cl) => [cl.preferences.square_id, cl]));
  const nameOf = (id) => { const cl = clientsBySq.get(id); return cl ? (cl.name || [cl.first_name, cl.last_name].filter(Boolean).join(' ')) : null; };
  const all = [...stats.entries()];
  const active12 = all.filter(([, s]) => s.last >= daysAgo(365));
  const newClients90 = all.filter(([, s]) => s.first > daysAgo(90)).length;
  const returning = all.filter(([, s]) => s.first <= daysAgo(90) && s.first > daysAgo(365));
  const cameBack = returning.filter(([, s]) => s.visits >= 2).length;
  const lapsed = all.filter(([, s]) => s.visits >= 2 && s.last < daysAgo(60) && s.last >= daysAgo(365));
  const lapsedValue = sum(lapsed.map(([, s]) => s.spend));
  const once = all.filter(([, s]) => s.visits === 1 && s.first <= daysAgo(21) && s.first > daysAgo(150));
  const person = ([id, s]) => { const cl = clientsBySq.get(id); return { client_id: cl?.id || null, name: nameOf(id) || 'Square client', spend_12m: dollars(s.spend), visits: s.visits, last_visit: s.last, usual: s.top, textable: !!(cl && e164(cl.phone) && cl.status !== 'opted_out' && !cl.opted_out) }; };
  const lapsedList = [...lapsed].sort((a, b) => b[1].spend - a[1].spend).slice(0, 25).map(person);
  const onceList = [...once].sort((a, b) => (b[1].first > a[1].first ? 1 : -1)).slice(0, 25).map(person);
  const top = all.sort((a, b) => b[1].spend - a[1].spend).slice(0, 10).map(person);
  const textable = (ids) => ids.filter((id) => { const cl = clientsBySq.get(id); return cl && e164(cl.phone) && cl.status !== 'opted_out' && !cl.opted_out; }).length;
  const clientsOut = {
    paying_clients_12m: active12.length, new_clients_90d: newClients90,
    retention_pct: returning.length ? Math.round((cameBack / returning.length) * 100) : null,
    lapsed_regulars: lapsed.length, lapsed_value_12m: dollars(lapsedValue), lapsed_textable: textable(lapsed.map(([id]) => id)),
    came_once: once.length, came_once_textable: textable(once.map(([id]) => id)),
    top_spenders: top, lapsed_list: lapsedList, came_once_list: onceList, walk_in_share_pct: Math.round((pays.filter((p) => !p[5]).length / pays.length) * 100),
  };
  // Staff (when Square records who took the payment), busiest days/hours (last 90 days).
  const p90 = pays.filter((p) => p[0] > daysAgo(90));
  const st = new Map(); for (const p of p90) if (p[7]) st.set(p[7], (st.get(p[7]) || 0) + p[3]);
  const staff = [...st.entries()].map(([id, c]) => ({ name: staffNames.get(id) || 'Team member', revenue_90d: dollars(c) })).sort((a, b) => b.revenue_90d - a.revenue_90d);
  const byDow = Array(7).fill(0); for (const p of p90) byDow[p[2]] += p[3];
  const open = byDow.map((v, i) => ({ day: DOW[i], revenue: dollars(v) })).filter((x) => x.revenue > 0);
  const busiest = [...open].sort((a, b) => b.revenue - a.revenue)[0] || null;
  const slowest = [...open].sort((a, b) => a.revenue - b.revenue)[0] || null;
  const byHour = new Map(); for (const p of p90) byHour.set(p[1], (byHour.get(p[1]) || 0) + 1);
  const peakHour = [...byHour.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const times = { busiest_day: busiest?.day || null, slowest_day: slowest?.day || null, by_weekday: open, peak_hour: peakHour != null ? peakHour : null };
  // The moves worth making, biggest first — each one a ready campaign audience.
  const moves = [];
  const avgSpend = lapsed.length ? lapsedValue / lapsed.length : 0;
  if (lapsed.length >= 3) moves.push({ key: 'win_back', segment: 'lapsed', days: 60, audience: clientsOut.lapsed_textable,
    value: dollars(lapsedValue * 0.2), why: `${lapsed.length} regulars haven't been back in 60+ days — they spent ${money(lapsedValue)} last year. Winning back 1 in 5 ≈ ${money(lapsedValue * 0.2)}.`,
    message: 'Hi {first_name}, we miss you at the salon! Your next visit comes with a complimentary deep-conditioning treatment — reply or tap to book.' });
  if (once.length >= 3) moves.push({ key: 'second_visit', segment: 'second_visit', audience: clientsOut.came_once_textable, value: dollars((avgSpend || rev(last30) / Math.max(1, last30.length)) * once.length * 0.25),
    why: `${once.length} new clients came once and never returned. A personal invite back is the cheapest growth there is.`,
    message: 'Hi {first_name}, it was a pleasure having you in! Ready for your next appointment? Reply and I’ll find you a time.' });
  if (slowest && busiest && slowest.revenue < busiest.revenue * 0.5) moves.push({ key: 'slow_day', segment: 'recent', audience: null, value: dollars((busiest.revenue - slowest.revenue) / 13 * 0.25),
    why: `${slowest.day}s bring in ${money(slowest.revenue * 100)} vs ${money(busiest.revenue * 100)} on ${busiest.day}s (last 90 days). A ${slowest.day}-only offer fills empty chairs.`,
    message: `Hi {first_name}! This ${slowest.day} only: book any service and get a free blowout add-on. Reply to grab a spot.` });
  if (revenue.avg_ticket_prev_30d && revenue.avg_ticket_30d < revenue.avg_ticket_prev_30d * 0.92) moves.push({ key: 'ticket', segment: 'tomorrow', audience: null, value: null,
    why: `Average ticket dropped to $${revenue.avg_ticket_30d} from $${revenue.avg_ticket_prev_30d}. Offer an add-on (gloss, treatment) to tomorrow's clients.`,
    message: 'Hi {first_name}, looking forward to seeing you tomorrow! Want to add a gloss or treatment to your visit? Reply YES and I’ll add it.' });
  if (top.length >= 3) moves.push({ key: 'vip', segment: 'vip', audience: null, value: null,
    why: `Your top 10 clients spent ${money(sum(all.slice(0, 10).map(([, s]) => s.spend)))} this year. A thank-you keeps them yours.`,
    message: 'Hi {first_name}, you’re one of our favorite clients — thank you! Your next visit includes a little gift from us. Reply to book.' });
  for (const f of falling.slice(0, 1)) moves.push({ key: 'falling_service', segment: 'recent', audience: null, value: dollars((f.was_90d - f.now_90d) * 100 * 0.5),
    why: `${f.name} sales fell from ${money(f.was_90d * 100)} to ${money(f.now_90d * 100)} (last 90 days vs the 90 before).`, message: null });
  // What worked before, in real Square money: past campaigns of each kind → revenue per text.
  const learned = learnFrom(campaigns);
  for (const mv of moves) {
    mv.name = MOVE_NAMES[mv.key] || mv.key;
    const L = learned.byKey[mv.key];
    if (L && L.texts >= 5) {
      mv.proven = L;
      if (mv.audience) mv.value = Math.max(mv.value || 0, Math.round(L.per_text * mv.audience));
      mv.why += ` Last time: ${L.texts} texts brought back ${L.returned} client${L.returned === 1 ? '' : 's'} and $${L.revenue.toLocaleString()} ($${L.per_text} per text).`;
    }
  }
  moves.sort((a, b) => (b.value || 0) - (a.value || 0));
  return { ok: true, as_of: led.updated_at || null, backfilled: !!led.backfilled, revenue, services, falling_services: falling, clients: clientsOut, staff, times, moves, campaigns: learned.list, learned: learned.byKey };
}

export async function squareInsights(c, tenant, { now = Date.now() } = {}) {
  const led = await loadLedger(c, tenant.id);
  const { data: clients } = await c.from('clients').select('id,first_name,last_name,name,phone,status,opted_out,preferences').eq('tenant_id', tenant.id).limit(10000).then((x) => x, () => ({ data: [] }));
  let staffNames = new Map();
  try { const { data: maps } = await c.from('provider_mappings').select('local_id,external_id').eq('tenant_id', tenant.id).eq('provider', 'square').eq('entity_type', 'staff'); const { data: st } = await c.from('staff').select('id,name').eq('tenant_id', tenant.id); const nm = new Map((st || []).map((s) => [s.id, s.name])); staffNames = new Map((maps || []).map((m) => [m.external_id, nm.get(m.local_id)]).filter(([, n]) => n)); } catch (_) {}
  const campaigns = await campaignResults(c, tenant.id, led, clients || [], { now });
  const r = insightsFrom(led, { now, clients: clients || [], staffNames, campaigns });
  if (r) r.store = led.store || 'blob';
  return r;
}

/** One spoken/texted answer for the owner, by focus. */
export function sayInsights(r, focus = 'overview') {
  if (!r?.ok) return r?.empty ? (r.backfilled ? "Square hasn't recorded any completed sales yet." : "I'm still reading your Square history — give me a few minutes and ask again.") : "I can't read your Square sales right now.";
  const R = r.revenue, C = r.clients;
  const trend = (p, what) => (p == null ? '' : ` (${p >= 0 ? '+' : ''}${p}% ${what})`);
  const lines = {
    revenue: `This month so far: $${R.this_month.toLocaleString()}${trend(R.month_to_date_vs_last_month, 'vs the same point last month')}. Last 30 days: $${R.last_30_days.toLocaleString()}${trend(R.trend_30d, 'vs the 30 before')}, ${R.transactions_30d} sales, average ticket $${R.avg_ticket_30d}, tips $${R.tips_30d.toLocaleString()}.${R.vs_same_month_last_year != null ? ` Versus this time last year: ${R.vs_same_month_last_year >= 0 ? '+' : ''}${R.vs_same_month_last_year}%.` : ''}`,
    services: r.services.length ? `Top sellers (90 days): ${r.services.slice(0, 3).map((s) => `${s.name} $${s.revenue_90d.toLocaleString()}`).join(', ')}.${r.falling_services[0] ? ` Falling: ${r.falling_services[0].name} ($${r.falling_services[0].was_90d} → $${r.falling_services[0].now_90d}).` : ''}` : 'No itemized Square orders yet.',
    clients: `${C.paying_clients_12m} paying clients this year, ${C.new_clients_90d} new in 90 days${C.retention_pct != null ? `, ${C.retention_pct}% came back` : ''}. ${C.lapsed_regulars} regulars haven't been back in 60+ days (worth $${C.lapsed_value_12m.toLocaleString()} a year).${C.top_spenders[0] ? ` Top client: ${C.top_spenders[0].name}, $${C.top_spenders[0].spend_12m.toLocaleString()}.` : ''}`,
    staff: r.staff.length ? `Last 90 days by team member: ${r.staff.slice(0, 4).map((s) => `${s.name} $${s.revenue_90d.toLocaleString()}`).join(', ')}.` : "Square doesn't record who took each payment, so I can't split revenue by stylist yet.",
    times: r.times.busiest_day ? `Busiest day: ${r.times.busiest_day}; slowest: ${r.times.slowest_day}.${r.times.peak_hour != null ? ` Most checkouts around ${((r.times.peak_hour + 11) % 12) + 1}${r.times.peak_hour < 12 ? 'am' : 'pm'}.` : ''}` : '',
    marketing: r.moves.length ? `Best moves right now: ${r.moves.slice(0, 3).map((m, i) => `${i + 1}) ${m.why}`).join(' ')} Want me to start the first one?` : 'Nothing urgent — your clients are coming back on rhythm.',
  };
  if (focus === 'overview') return [lines.revenue, lines.clients, r.moves[0] ? `Biggest opportunity: ${r.moves[0].why}` : ''].filter(Boolean).join(' ');
  return lines[focus] || lines.revenue;
}

export function briefLine(r) {
  if (!r?.ok) return null;
  const R = r.revenue;
  const p = R.month_to_date_vs_last_month;
  return `Square: $${R.this_month.toLocaleString()} this month${p == null ? '' : ` (${p >= 0 ? '+' : ''}${p}% vs last month)`}${r.moves[0] ? ` — ${r.moves[0].why}` : ''}`;
}
