// The website widget always reaches the RIGHT salon's dashboard — even when the salon's phone line is
// shared by duplicate rows (which made LolaDesk refuse to guess, and sent website leads to the Console).
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'tk';
process.env.TELNYX_LOLA_BRAIN_ID = 'assistant-57f2d23e-48b1-4107-9811-c40b296f15b6'; process.env.WIDGET_EMBED_SECRET = 'w-secret';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
globalThis.fetch = async (url) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('/ai/assistants/assistant-57f2d23e')) return J({ data: { id: 'assistant-57f2d23e-48b1-4107-9811-c40b296f15b6', name: 'LolaBrain' } });
  if (u.includes('/ai/assistants')) return J({ data: [{ id: 'assistant-57f2d23e-48b1-4107-9811-c40b296f15b6', name: 'LolaBrain' }] });
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
const MMA = '77777777-7777-4777-8777-777777777777', DUP = '88888888-8888-4888-8888-888888888888', OTHER = '99999999-9999-4999-8999-999999999999';
const LINE = '+13055550100';
T.tenants = [
  { id: MMA, slug: 'mma', name: 'MMA Salon', subscription_status: 'active', phone_number: LINE, owner_email: 'owner@mmasalon.com', services: [{ name: 'Balayage', price: 250, duration: 180 }] },
  { id: DUP, slug: 'mma-2', name: 'MMA Salon', subscription_status: 'active', phone_number: LINE },
  { id: OTHER, slug: 'other', name: 'Other Salon', subscription_status: 'active', phone_number: '+13055550199' },
];
T.tenant_numbers = [{ tenant_id: MMA, phone_number: LINE, status: 'active' }, { tenant_id: DUP, phone_number: LINE, status: 'active' }];
for (const k of ['clients', 'conversations', 'messages', 'usage_events', 'calls', 'call_sessions', 'booking_settings', 'integrations', 'client_memories', 'client_memory', 'services', 'staff', 'bookings']) T[k] = [];
const P = new URL('../../api/', import.meta.url).href;
const tr = await import(P + 'lib/tenant-resolver.js');

const ref = tr.salonRef(MMA);
ok(/^s_77777777-7777-4777-8777-777777777777\.[A-Za-z0-9_-]{16}$/.test(ref), 'each salon has a signed id for its widget');
ok((await tr.resolveInboundTenant({ to: LINE })).status === 'ambiguous', 'the shared phone line is ambiguous (LolaDesk never guesses)…');
const r1 = await tr.resolveSalonRef(ref);
ok(r1.status === 'resolved' && r1.tenant.id === MMA && r1.number === LINE, '…but the signed id is not: MMA Salon');
const forged = ref.replace(MMA, OTHER);
ok((await tr.resolveSalonRef(forged)).status !== 'resolved', 'MMA’s signature can’t open another salon');
ok((await tr.resolveSalonRef('s_' + MMA + '.AAAAAAAAAAAAAAAA')).status !== 'resolved', 'a made-up signature opens nothing');
ok((await tr.resolveSalonRef('+13055550199')).tenant?.id === OTHER, 'older snippets that send a phone line keep working');

// The widget config hands out the signed id.
const wc = await import(P + 'widget-chat.js');
const cfg = await new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve(o); }, end() { resolve({}); } };
  wc.default({ method: 'GET', headers: {}, url: `/api/widget-chat?slug=mma&key=${wc.widgetKeyFor('mma')}` }, res); });
ok(cfg.ok && cfg.voice?.line === ref, 'the website widget is told the signed id (sent to Telnyx as X-LolaDesk-Salon)');

// Before she speaks: Telnyx asks for the salon's facts with the widget's header.
const av = (await import(P + 'agent-variables.js')).default;
const vars = await new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve(o); }, end() { resolve({}); } };
  av({ method: 'POST', url: '/api/agent-variables', headers: {}, query: {}, body: { data: { payload: { telnyx_conversation_channel: 'web_call', call_control_id: 'web-cc-1', custom_headers: [{ name: 'X-LolaDesk-Salon', value: ref }] } } } }, res); });
ok(vars?.dynamic_variables?.tenant_id === MMA, 'on the website Lola knows she is MMA Salon’s Lola (real services, hours, booking)');
await new Promise((r) => setTimeout(r, 50));
ok(T.call_sessions.some((s) => s.call_control_id === 'web-cc-1' && s.tenant_id === MMA), 'and the website call is tied to MMA (so its transcript lands on MMA’s dashboard)');

// After: the collector files the conversation on MMA's dashboard.
const cr = await import(P + 'lib/conversation-report.js');
const { db } = await import(P + 'lib/db.js');
ok((await cr.tenantForConversation(db(), { 'X-LolaDesk-Salon': ref }))?.id === MMA, 'a website conversation carrying the id → MMA’s Calls screen + Needs you');
ok((await cr.tenantForConversation(db(), { call_control_id: 'web-cc-1' }))?.id === MMA, 'one without headers → MMA, through the call it belongs to');
ok((await cr.tenantForConversation(db(), { telnyx_agent_target: LINE })) === null, 'a bare shared line still never guesses');

// Her tools on the website (services, booking) act for MMA too.
const { toolKey } = await import(P + 'lib/tool-key.js');
const tools = (await import(P + 'lola-tools.js')).default;
const said = await new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve(o); }, end() { resolve({}); } };
  tools({ method: 'POST', headers: {}, url: '/api/lola-tools', query: { tool: 'get_pricing', salon: ref, ch: 'web_call', to: '{{telnyx_agent_target}}', k: toolKey() }, body: { service: 'balayage' } }, res); });
ok(/Balayage/.test(JSON.stringify(said)), 'her tools on the website use MMA’s real menu: ' + JSON.stringify(said).slice(0, 90));

// The settings page's copy-paste code uses the signed id too.
const fs = await import('node:fs');
const html = fs.readFileSync(new URL('../../settings.html', import.meta.url), 'utf8');
ok(/renderLolaWidget\(d\.lola_agent_id, d\.lola_salon_ref\)/.test(html) && /salonRef\|\|/.test(html), 'Settings → website code carries the signed id');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
