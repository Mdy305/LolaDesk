// LolaBrain reads the salon's Square sales (read-only): 13 months of payments + orders, Square clients merged
// into LolaDesk's (spend, last visit, usual service), and a real analysis — revenue trends, services, clients
// who stopped coming, team, busiest days — with the marketing moves worth making, ready to launch.
import crypto from 'node:crypto';
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.INTEGRATION_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64'); process.env.SQUARE_ENV = 'production';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const DAY = 864e5, NOW = Date.now();
const TODAY = new Date(NOW).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const ago = (d, h = 15) => new Date(Date.parse(TODAY + 'T00:00:00Z') - d * DAY + (h + 5) * 3600e3).toISOString();   // d salon-days ago, h ≈ salon-local hour
const P_ = [], O_ = [];
let n = 0;
const sale = (d, cust, item, dollars, { tip = 0, refund = 0, team = 'TM-ANA', h = 15 } = {}) => {
  const id = 'P' + (++n), at = ago(d, h);
  P_.push({ _d: d, id, status: 'COMPLETED', created_at: at, amount_money: { amount: dollars * 100 }, tip_money: { amount: tip * 100 }, refunded_money: refund ? { amount: refund * 100 } : undefined, customer_id: cust, order_id: 'O' + n, team_member_id: team, location_id: 'L1' });
  O_.push({ id: 'O' + n, state: 'COMPLETED', closed_at: at, customer_id: cust, line_items: [{ name: item, quantity: '1', total_money: { amount: dollars * 100 } }] });
};
// Ana: a regular who stopped coming (last 90 days ago). Zoe and Kim too. Mia: every 2 weeks, still coming. Leo: came once.
for (const d of [360, 300, 240, 180, 90]) sale(d, 'C1', 'Balayage', 250, { tip: 40 });
for (const d of [200, 150, 100]) sale(d, 'C4', 'Balayage', 260);
for (const d of [130, 70]) sale(d, 'C5', "Women's Haircut", 85, { team: 'TM-BO' });
for (let d = 2; d <= 170; d += 14) sale(d, 'C2', "Women's Haircut", 90, { tip: 15, team: 'TM-BO', h: 11 });
sale(40, 'C3', 'Gloss', 60);
sale(5, null, 'Blowout', 50, { h: 18 }); sale(3, null, 'Blowout', 50, { h: 18 });
sale(1, 'C2', 'Gloss', 60, { refund: 60 });   // refunded in full
const CUST = [
  { id: 'C1', given_name: 'Ana', family_name: 'Lopez', phone_number: '+13055551111' },
  { id: 'C2', given_name: 'Mia', family_name: 'Chen', phone_number: '(305) 555-2222', email_address: 'MIA@x.com' },
  { id: 'C3', given_name: 'Leo', family_name: 'Ray', phone_number: '+13055553333' },
  { id: 'C4', given_name: 'Zoe', family_name: 'Kim', phone_number: '+13055554444' },
  { id: 'C5', given_name: 'Kim', family_name: 'Ng', email_address: 'kim@x.com' },
  { id: 'C6', given_name: 'Nobody' },
];
let calls = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (!u.startsWith('https://connect.squareup.com')) return J({ data: [] });
  calls++;
  const path = u.replace('https://connect.squareup.com', ''); const body = init.body ? JSON.parse(init.body) : {};
  if (path.startsWith('/v2/locations')) return J({ locations: [{ id: 'L1', status: 'ACTIVE', name: 'MMA', timezone: 'America/New_York' }] });
  if (path.startsWith('/v2/payments?')) {
    const q = new URL(u).searchParams; const a = Date.parse(q.get('begin_time')), b = Date.parse(q.get('end_time'));
    const list = P_.filter((p) => Date.parse(p.created_at) >= a && Date.parse(p.created_at) < b);
    const start = Number(q.get('cursor') || 0); const page = list.slice(start, start + 3);
    return J({ payments: page, ...(start + 3 < list.length ? { cursor: String(start + 3) } : {}) });
  }
  if (path === '/v2/orders/search') {
    const r = body.query.filter.date_time_filter.closed_at; const a = Date.parse(r.start_at), b = Date.parse(r.end_at);
    return J({ orders: O_.filter((o) => Date.parse(o.closed_at) >= a && Date.parse(o.closed_at) < b) });
  }
  if (path.startsWith('/v2/customers?')) return J({ customers: CUST });
  return J({ errors: [{ code: 'NOT_FOUND', detail: path }] }, 404);
};
const { T } = await import('./fake-supabase.mjs');
const TID = '66666666-6666-4666-8666-666666666666';
T.tenants = [{ id: TID, name: 'MMA Salon', slug: 'mma', subscription_status: 'active', phone_number: '+13055550100' }];
for (const k of ['bookings', 'usage_events', 'provider_mappings', 'platform_settings', 'lola_campaign_recipients', 'lola_campaigns', 'booking_settings', 'services']) T[k] = [];
T.staff = [{ id: 'st-ana', tenant_id: TID, name: 'Ana Ruiz', is_active: true }];
T.provider_mappings = [{ tenant_id: TID, provider: 'square', entity_type: 'staff', local_id: 'st-ana', external_id: 'TM-ANA' }];
// Mia already a LolaDesk client (texted the salon once): matched by phone, her name kept, never duplicated.
T.clients = [{ id: 'cl-mia', tenant_id: TID, first_name: 'Mia', last_name: 'C.', phone: '+13055552222', lifetime_value: 0, status: 'active', preferences: {} }];
const { encrypt } = await import('../../api/lib/crypto.js');
const SC = ['PAYMENTS_READ', 'ORDERS_READ', 'CUSTOMERS_READ'];
T.integrations = [{ id: 'int-sq', tenant_id: TID, provider: 'square', status: 'connected', access_token: encrypt('tok'), refresh_token: encrypt('r'), expires_at: new Date(NOW + 25 * DAY).toISOString(), metadata: { merchant_id: 'M', location_id: 'L1', tz: 'America/New_York', scopes: SC } }];
const P = new URL('../../api/', import.meta.url).href;
const SD = await import(P + 'lib/square-data.js');
const { db } = await import(P + 'lib/db.js');
const integ = { ...T.integrations[0], access_token: 'tok', refresh_token: 'r' };

// ── Import: resumable, then complete ──
let r = await SD.importSquareSales(db(), integ, { now: NOW, budgetMs: 0 });
ok(r.windows === 1 && !r.backfilled, 'a big history is read a month at a time (resumes next run, never times out)');
r = await SD.importSquareSales(db(), integ, { now: NOW, budgetMs: 60000 });
ok(r.ok && r.backfilled && r.payments === P_.length && r.orders === O_.length, `13 months read: ${r.payments} payments, ${r.orders} orders (paged)`);
ok(r.clients && r.clients.created === 4 && r.clients.updated === 1, 'Square clients joined LolaDesk: 4 new, Mia matched to her existing record (no duplicate; no-contact “Nobody” skipped)');
const mia = T.clients.find((x) => x.id === 'cl-mia'), ana = T.clients.find((x) => x.preferences?.square_id === 'C1');
ok(mia.last_name === 'C.' && mia.preferences.square_id === 'C2' && mia.lifetime_value > 900 && mia.email === 'mia@x.com', 'Mia keeps her name; gains her Square spend, visits and email');
ok(ana && ana.phone === '+13055551111' && ana.lifetime_value === 1250 && ana.preferred_service === 'Balayage' && Math.abs(Date.parse(ana.last_visit) - (NOW - 90 * DAY)) < 2 * DAY, 'Ana: $1,250 this year, usual service Balayage, last visit 90 days ago — every Lola audience now sees her real history');
const before = calls; r = await SD.importSquareSales(db(), integ, { now: NOW, budgetMs: 60000 });
ok(r.ok && r.payments === P_.length && calls - before <= 6, 'the next run only re-reads the last 3 days (late refunds, tips) — no duplicates');

// ── The analysis ──
const ins = await SD.squareInsights(db(), T.tenants[0], { now: NOW });
const sumP = (f) => P_.filter(f).reduce((t, p) => t + p.amount_money.amount - (p.refunded_money?.amount || 0), 0) / 100;
const in30 = (p) => p._d < 30;
ok(ins.ok && ins.revenue.last_30_days === Math.round(sumP(in30)), `revenue, last 30 days: $${ins.revenue.last_30_days} (refunds taken out)`);
ok(ins.revenue.months.length === 12 && ins.revenue.tips_30d === 15 * P_.filter((p) => in30(p) && p.tip_money.amount === 1500).length, '12-month revenue curve + tips');
ok(ins.services[0].name === 'Balayage' || ins.services[0].name === "Women's Haircut", 'best sellers ranked by revenue: ' + ins.services.slice(0, 3).map((s) => s.name).join(', '));
ok(ins.clients.lapsed_regulars === 3 && ins.clients.lapsed_textable === 2, 'regulars who stopped coming: Ana, Zoe, Kim (2 can be texted — Kim has no mobile)');
ok(ins.clients.top_spenders[0].name === 'Ana Lopez' && ins.clients.came_once === 1, 'top spender Ana Lopez; Leo came once');
ok(ins.staff.some((s) => s.name === 'Ana Ruiz') && ins.times.busiest_day && ins.times.slowest_day, 'revenue by team member (Ana Ruiz, from the stylist mapping) and busiest/slowest days');
const win = ins.moves.find((m) => m.key === 'win_back');
ok(win && win.segment === 'lapsed' && win.value > 0 && /\{first_name\}/.test(win.message), 'the #1 kind of move: win back the lapsed regulars — audience, value and a ready text: ' + win?.why);

// ── Lola, for the owner ──
const { runOwnerTool } = await import(P + 'lib/owner-tools.js');
const { routeOwnerIntent } = await import(P + 'lib/owner-intents.js');
const t = await runOwnerTool({ tenant: T.tenants[0], name: 'business_insights', args: { focus: 'clients' } });
ok(t.ok && /regulars haven't been back/.test(t.say) && t.insights.moves.length, 'asked about clients: ' + t.say);
const m2 = await runOwnerTool({ tenant: T.tenants[0], name: 'business_insights', args: { focus: 'marketing' } });
ok(/Best moves right now/.test(m2.say) && /Want me to start/.test(m2.say), 'asked for marketing: ' + m2.say.slice(0, 140) + '…');
ok(routeOwnerIntent('who stopped coming?')?.args?.focus === 'clients' && routeOwnerIntent('what are my best sellers')?.args?.focus === 'services' && routeOwnerIntent('analyze my business')?.tool === 'business_insights' && routeOwnerIntent('marketing ideas')?.args?.focus === 'marketing', 'plain questions reach the analysis (who stopped coming, best sellers, analyze my business, marketing ideas)');
ok(routeOwnerIntent('how much is locked in for next week')?.tool === 'revenue_report', 'money already booked still goes to the booked-revenue report');
const { audience } = await import(P + 'lib/marketing.js');
const a = await audience(db(), TID, 'lapsed', { days: 60, tz: 'America/New_York' });
ok(a.recipients.some((x) => x.phone === '+13055551111') && a.recipients.some((x) => x.phone === '+13055554444') && !a.recipients.some((x) => x.phone === '+13055552222'), 'the “lapsed” campaign audience now comes from Square history: Ana + Zoe in, Mia (still coming) out');
const lc = await runOwnerTool({ tenant: T.tenants[0], name: 'launch_campaign', args: { segment: win.segment, days: 60, message: win.message, confirmed: false } });
ok(/2 clients/.test(lc.say) && /Launch it\?/.test(lc.say), 'one tap from the move to the campaign (previewed first): ' + lc.say.slice(0, 90));

// ── Permissions ──
T.integrations[0].metadata = { ...T.integrations[0].metadata, scopes: ['APPOINTMENTS_READ'] };
const runs = await SD.runSquareImports(db(), { now: NOW + 7 * 3600e3 });
ok(runs[0]?.skipped === 'needs_reconnect', 'a salon that hasn’t granted read-only sales access is skipped (asked to reconnect), never errored');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
