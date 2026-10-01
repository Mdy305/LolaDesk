// Lola's Telnyx assistant is wired by LolaDesk, not by hand: tools that point at
// the insights webhook (or anywhere wrong) are re-pointed to /api/lola-tools
// with the salon line on the URL; unknown tools are reported, never touched.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.TELNYX_LOLA_BRAIN_ID = 'assistant-57f2'; process.env.APP_URL = 'https://www.loladesk.com';
let assistant = {
  id: 'assistant-57f2', name: 'LolaBrain', dynamic_variables_webhook_url: 'https://old.example.com/vars',
  tools: [
    { type: 'webhook', webhook: { name: 'detect_upsell_opportunity', description: 'pair add-ons', url: 'https://www.loladesk.com/api/webhooks/telnyx-insights', method: 'POST', body_parameters: { type: 'object', properties: { serviceId: { type: 'string' } } } } },
    { type: 'webhook', webhook: { name: 'book_appointment', url: 'https://www.loladesk.com/api/lola-tools?tool=book_appointment&to={{telnyx_agent_target}}&from={{telnyx_end_user_target}}', method: 'POST' } },
    { type: 'webhook', webhook: { name: 'check_availability', url: 'https://www.loladesk.com/api/lola/check-availability', method: 'POST' } },
    { type: 'webhook', webhook: { name: 'LolaDesk_Voice_API', url: 'https://somewhere.example.com/hook', method: 'POST' } },
    { type: 'hangup', hangup: { description: 'end' } },
  ],
};
const patches = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('/ai/assistants/assistant-57f2')) {
    if (init.method === 'PATCH') { const b = JSON.parse(init.body); patches.push(b); assistant = { ...assistant, ...b }; return J({ data: assistant }); }
    return J({ data: assistant });
  }
  return J({ data: [] });
};
await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const { wireAssistant } = await import(P + 'lib/assistant-wiring.js');

let r = await wireAssistant({ heal: false });
ok(!r.ok && r.miswired.find(x => x.name === 'detect_upsell_opportunity')?.problem === 'insights_url', 'finds the tool pointed at the insights webhook');
ok(r.miswired.find(x => x.name === 'book_appointment')?.problem === 'web_salon_unknown', 'finds a tool that can’t tell which salon a website call is for');
ok(r.unknown_tools.length === 1 && r.unknown_tools[0].name === 'LolaDesk_Voice_API', 'reports the tool LolaDesk doesn’t run');
ok(!r.dynamic_variables.ok, 'finds the salon-details webhook pointing elsewhere');
ok(patches.length === 0, 'looking changes nothing');

r = await wireAssistant({ heal: true });
const t = (n) => assistant.tools.find(x => x.webhook && x.webhook.name === n);
ok(r.healed && /\/api\/lola-tools\?tool=detect_upsell_opportunity&to=\{\{telnyx_agent_target\}\}/.test(t('detect_upsell_opportunity').webhook.url), 'upsell tool re-pointed to LolaDesk with the salon line on the URL');
ok(t('detect_upsell_opportunity').webhook.description === 'pair add-ons' && t('detect_upsell_opportunity').webhook.body_parameters.properties.serviceId, 'everything else about the tool is kept');
ok(/salon=\{\{loladesk_salon\}\}&call=\{\{call_control_id\}\}/.test(t('book_appointment').webhook.url) && t('LolaDesk_Voice_API').webhook.url === 'https://somewhere.example.com/hook' && t('check_availability').webhook.url.endsWith('/api/lola/check-availability') && assistant.tools.some(x => x.type === 'hangup'), 'good and unknown tools untouched');
ok(assistant.dynamic_variables_webhook_url === 'https://www.loladesk.com/api/agent-variables', 'salon details webhook reconnected');
r = await wireAssistant({ heal: true });
ok(r.ok && !r.miswired.length && patches.length === 1, 'second run: all good, nothing to change');

// The tool endpoint learns the salon from the URL.
const { T } = await import('./fake-supabase.mjs');
T.tenants = [{ id: 't1', name: 'Salon', phone_number: '+13055550100', services: [{ name: 'Balayage', price: 250, duration: '3h' }] }];
T.tenant_numbers = [{ tenant_id: 't1', phone_number: '+13055550100', status: 'active', kind: 'primary' }];
const h = (await import(P + 'lola-tools.js')).default;
const out = await new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve(o); }, end() { resolve({}); } };
  h({ method: 'POST', query: { tool: 'list_services', to: '+13055550100', from: '{{telnyx_end_user_target}}' }, headers: {}, body: {} }, res); });
ok(/Balayage/i.test(JSON.stringify(out)), 'a tool call with ?to= answers for that salon: ' + JSON.stringify(out).slice(0, 90));
const web = await new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve(o); }, end() { resolve({}); } };
  h({ method: 'POST', query: { tool: 'list_services', to: '{{telnyx_agent_target}}', salon: '+13055550100', call: 'v3:web-1', ch: 'web_call' }, headers: {}, body: {} }, res); });
ok(/Balayage/i.test(JSON.stringify(web)), 'a website call (no dialed number) answers for the salon its widget names');
ok(T.call_sessions?.some(x => x.call_control_id === 'v3:web-1' && x.tenant_id === 't1' && x.from_number === 'Website visitor'), 'the website conversation is linked to its salon');
const { persistCallInsights } = await import(P + 'lib/call-insights.js');
const { db } = await import(P + 'lib/db.js');
T.calls = T.calls || [];
const pr = await persistCallInsights(db(), { callControlId: 'v3:web-1', eventId: 'ev1', occurredAt: new Date().toISOString() }, { summary: 'Asked about balayage, booked Friday.', outcome: 'booked', transcript: 'Hi…' });
ok(pr.mode !== 'ignored' && T.calls.some(x => x.tenant_id === 't1' && x.summary === 'Asked about balayage, booked Friday.' && x.from_number === 'Website visitor'), 'its summary and transcript land on that salon’s Calls page');
const settingsHtml = (await import('node:fs')).readFileSync(new URL('../../settings.html', import.meta.url), 'utf8');
ok(/X-LolaDesk-Salon/.test(settingsHtml) && /call-custom-headers/.test(settingsHtml) && /lolaWidgetCard/.test(settingsHtml), 'Settings gives each salon its own Lola widget code');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
