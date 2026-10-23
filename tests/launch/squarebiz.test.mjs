// The Business page: Square sales in real tables (salon_sales / salon_sale_items, every sale tied to its
// LolaDesk client), LolaBrain's written take, moves launched in one tap — and every campaign measured in
// real Square money 14 days later, so Lola ranks her next suggestions by what actually worked.
import crypto from 'node:crypto';
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.INTEGRATION_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64'); process.env.SQUARE_ENV = 'production';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const DAY = 864e5, NOW = Date.now();
const TODAY = new Date(NOW).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const ago = (d, h = 15) => new Date(Date.parse(TODAY + 'T00:00:00Z') - d * DAY + (h + 5) * 3600e3).toISOString();
const P_ = [], O_ = []; let n = 0; let llmAsked = null;
const sale = (d, cust, item, dollars) => { const id = 'P' + (++n), at = ago(d); P_.push({ id, status: 'COMPLETED', created_at: at, amount_money: { amount: dollars * 100 }, tip_money: { amount: 0 }, customer_id: cust, order_id: 'O' + n, location_id: 'L1' }); O_.push({ id: 'O' + n, state: 'COMPLETED', closed_at: at, customer_id: cust, line_items: [{ name: item, quantity: '1', total_money: { amount: dollars * 100 } }] }); };
const CUST = [];
for (let i = 1; i <= 6; i++) { CUST.push({ id: 'C' + i, given_name: 'Reg' + i, family_name: 'Ular', phone_number: '+1305555100' + i }); for (const d of [300, 200, 100]) sale(d + i, 'C' + i, 'Balayage', 200); }
for (let d = 3; d < 120; d += 10) sale(d, 'C9', "Women's Haircut", 80);
CUST.push({ id: 'C9', given_name: 'Mia', family_name: 'Chen', phone_number: '+13055552222' });
// After the win-back text (30 days ago): two regulars came back within 14 days; C3 only 28 days later (not counted).
sale(25, 'C1', 'Balayage', 220); sale(22, 'C2', 'Balayage', 230); sale(2, 'C3', 'Balayage', 999);
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('/chat/completions')) { llmAsked = JSON.parse(init.body); return J({ choices: [{ message: { role: 'assistant', content: 'Business is steady: $X is not a number I made up.\n\nYour regulars are the story.\n\nWin them back this week.' } }] }); }
  if (u.includes('/v2/messages')) return J({ data: { id: 'm' } });
  if (!u.startsWith('https://connect.squareup.com')) return J({ data: [] });
  const path = u.replace('https://connect.squareup.com', ''); const body = init.body ? JSON.parse(init.body) : {};
  if (path.startsWith('/v2/locations')) return J({ locations: [{ id: 'L1', status: 'ACTIVE', name: 'MMA', timezone: 'America/New_York' }] });
  if (path.startsWith('/v2/payments?')) { const q = new URL(u).searchParams; const a = Date.parse(q.get('begin_time')), b = Date.parse(q.get('end_time')); return J({ payments: P_.filter((p) => Date.parse(p.created_at) >= a && Date.parse(p.created_at) < b) }); }
  if (path === '/v2/orders/search') { const r = body.query.filter.date_time_filter.closed_at; const a = Date.parse(r.start_at), b = Date.parse(r.end_at); return J({ orders: O_.filter((o) => Date.parse(o.closed_at) >= a && Date.parse(o.closed_at) < b) }); }
  if (path.startsWith('/v2/customers?')) return J({ customers: CUST });
  return J({ errors: [{ code: 'NOT_FOUND' }] }, 404);
};
const { T } = await import('./fake-supabase.mjs');
const TID = '77777777-7777-4777-8777-777777777777';
T.tenants = [{ id: TID, name: 'MMA Salon', slug: 'mma', subscription_status: 'active', phone_number: '+13055550100' }];
T.tenant_numbers = [{ tenant_id: TID, phone_number: '+13055550100', status: 'active' }];
for (const k of ['bookings', 'usage_events', 'provider_mappings', 'platform_settings', 'lola_campaign_recipients', 'lola_campaigns', 'booking_settings', 'services', 'staff', 'clients', 'salon_sales', 'salon_sale_items', 'opt_outs']) T[k] = [];
globalThis.__authUsers = { tok: { id: 'u1', email: 'o@mma.com' } };
T.tenant_users = [{ user_id: 'u1', tenant_id: TID, role: 'owner', status: 'active' }];
const { encrypt } = await import('../../api/lib/crypto.js');
T.integrations = [{ id: 'int-sq', tenant_id: TID, provider: 'square', status: 'connected', access_token: encrypt('tok'), refresh_token: encrypt('r'), expires_at: new Date(NOW + 25 * DAY).toISOString(), metadata: { merchant_id: 'M', location_id: 'L1', location_name: 'MMA', tz: 'America/New_York', scopes: ['PAYMENTS_READ', 'ORDERS_READ'] } }];
const P = new URL('../../api/', import.meta.url).href;
const SD = await import(P + 'lib/square-data.js');
const { db } = await import(P + 'lib/db.js');
const integ = { ...T.integrations[0], access_token: 'tok', refresh_token: 'r' };

// ── Real tables ──
await SD.importSquareSales(db(), integ, { now: NOW, budgetMs: 60000 });
ok(T.salon_sales.length === P_.length && T.salon_sale_items.length === O_.length, `every Square sale is a row in salon_sales (${T.salon_sales.length}) and every line in salon_sale_items (${T.salon_sale_items.length})`);
const reg1 = T.clients.find((x) => x.preferences?.square_id === 'C1');
ok(reg1 && T.salon_sales.filter((r) => r.customer_ref === 'C1').every((r) => r.client_id === reg1.id) && T.salon_sale_items.some((r) => r.client_id === reg1.id), 'each sale is tied to its LolaDesk client (client page, attribution, audiences)');
ok(T.salon_sales.every((r) => r.occurred_at && r.day && r.net_cents > 0), 'with the real time, the salon’s day and the amount');
const led = await SD.loadLedger(db(), TID);
ok(led.store === 'tables' && Object.keys(led.payments).length === P_.length && !T.platform_settings.find((r) => r.key === 'square_sales:' + TID)?.value?.payments, 'read back from the tables; the old one-row store holds only bookkeeping now');

// ── A campaign, measured in Square money ──
const regs = T.clients.filter((x) => /^C[1-6]$/.test(x.preferences?.square_id || ''));
T.lola_campaigns = [{ id: 'camp1', tenant_id: TID, name: 'Win back regulars', segment: 'lapsed', status: 'sent', message: 'We miss you', created_at: ago(30), started_at: ago(30) }];
T.lola_campaign_recipients = regs.map((cl) => ({ campaign_id: 'camp1', tenant_id: TID, client_id: cl.id, phone: cl.phone, status: 'sent', sent_at: ago(30) }));
let ins = await SD.squareInsights(db(), T.tenants[0], { now: NOW });
const c1 = ins.campaigns.find((x) => x.id === 'camp1');
ok(c1 && c1.texts === 6 && c1.returned === 2 && c1.revenue === 450 && c1.key === 'win_back', 'the win-back campaign: 6 texts → 2 came back within 14 days → $450 in Square (the late one isn’t counted)');
const wb = ins.moves.find((m) => m.key === 'win_back');
ok(!wb || (wb.proven && /Last time: 6 texts brought back 2 clients and \$450/.test(wb.why)), 'the next win-back suggestion says what the last one earned — Lola learns from results');
ok(ins.clients.lapsed_list.length && ins.clients.lapsed_list[0].client_id && 'textable' in ins.clients.lapsed_list[0], 'the page gets the actual people (linked to their client page), not just counts');

// ── The page's API ──
const api = (await import(P + 'insights.js')).default;
const call = (method, body, query = {}) => new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, end() { resolve({}); } }; api({ method, headers: { authorization: 'Bearer tok' }, query, body, url: '/api/insights' }, res); });
let g = await call('GET');
ok(g.ok && g.connection.connected && g.sync.tables && g.sync.payments === P_.length && g.insights.ok, 'Business page: connection, sync state and the full analysis');
ok(g.take && g.take.by === 'lola' && /regulars/.test(g.take.text) && /Use ONLY the numbers/.test(llmAsked?.messages?.[0]?.content || llmAsked?.system || JSON.stringify(llmAsked)), 'Lola’s take is written by LolaBrain (Telnyx), told to use only the real numbers');
llmAsked = null; g = await call('GET');
ok(!llmAsked && g.take.by === 'lola', 'and cached — the page doesn’t re-ask her on every visit');
ok((await call('GET', null)).status === 200 && (await new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve(this.statusCode); }, end() { resolve(0); } }; api({ method: 'GET', headers: {}, query: {}, url: '/api/insights' }, res); })) === 401, 'owners only (no sign-in → 401)');
const mv = g.insights.moves.find((m) => m.segment && m.message);
if (mv) {
  const pv = await call('POST', { action: 'preview', key: mv.key });
  ok(pv.ok && typeof pv.count === 'number', `preview: ${pv.count} client(s) for “${mv.name}”`);
  const before = T.lola_campaigns.length;
  const ln = await call('POST', { action: 'launch', key: mv.key, message: 'Hi {first_name}, edited by the owner — come back soon!' });
  const made = T.lola_campaigns[T.lola_campaigns.length - 1];
  ok(ln.ok && T.lola_campaigns.length === before + 1 && made.name === mv.name && /edited by the owner/.test(made.message), 'one tap: the move becomes a campaign (named, so its results are measured), with the owner’s edited text');
} else ok(false, 'a move with a text exists');
const sy = await call('POST', { action: 'sync' });
ok(sy.ok && sy.payments === P_.length, '“Sync Square now” reads the latest');

// ── No tables yet → nothing lost ──
const mig = await import(P + 'lib/migrate.js');
globalThis.__missing = new Set(['salon_sales', 'salon_sale_items']); mig.resetSalesSchema(); SD.resetSalesTables();
const TID2 = '88888888-8888-4888-8888-888888888888';
T.tenants.push({ id: TID2, name: 'Other', slug: 'o', subscription_status: 'active' });
const r2 = await SD.importSquareSales(db(), { ...integ, id: 'int-2', tenant_id: TID2 }, { now: NOW, budgetMs: 60000, clients: false });
const blob = T.platform_settings.find((r) => r.key === 'square_sales:' + TID2)?.value;
ok(r2.ok && blob && Object.keys(blob.payments).length === P_.length, 'database can’t create the tables yet → sales kept in the fallback store, nothing lost');
globalThis.__missing = null; mig.resetSalesSchema(); SD.resetSalesTables();
const l2 = await SD.loadLedger(db(), TID2);
await SD.importSquareSales(db(), { ...integ, id: 'int-2', tenant_id: TID2 }, { now: NOW, budgetMs: 60000, clients: false });
ok(l2.store === 'tables' && T.salon_sales.filter((r) => r.tenant_id === TID2).length === P_.length, 'tables arrive → that history moves into them on the next sync');

// ── Lola knows the page ──
const fs = await import('node:fs');
ok(/href: '\/insights'/.test(fs.readFileSync(new URL('../../sidebar.js', import.meta.url), 'utf8')) && fs.existsSync(new URL('../../insights.html', import.meta.url)), 'Growth → Business in the sidebar');
const { runOwnerTool } = await import(P + 'lib/owner-tools.js');
const op = await runOwnerTool({ tenant: T.tenants[0], name: 'open_page', args: { page: 'business' } });
ok(op.ui?.navigate === '/insights', '“Lola, open my business page”');
ok(/create table if not exists public\.salon_sales/.test(fs.readFileSync(new URL('../../sql/square-sales.sql', import.meta.url), 'utf8')), 'sql/square-sales.sql for the Supabase SQL editor, if the database can’t self-create');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
