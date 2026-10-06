// Lola on a salon's website from ONE line: the config tells the widget to use LolaBrain's voice with the
// salon's line (nothing to copy), and the chat fallback is the real Lola (real availability and booking).
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'tk';
process.env.TELNYX_LOLA_BRAIN_ID = 'assistant-57f2d23e-48b1-4107-9811-c40b296f15b6'; process.env.WIDGET_EMBED_SECRET = 'w-secret';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const llm = []; let script = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('/ai/assistants/assistant-57f2d23e')) return J({ data: { id: 'assistant-57f2d23e-48b1-4107-9811-c40b296f15b6', name: 'LolaBrain' } });
  if (u.includes('/ai/assistants')) return J({ data: [{ id: 'assistant-57f2d23e-48b1-4107-9811-c40b296f15b6', name: 'LolaBrain' }] });
  if (u.includes('/chat/completions')) { const b = JSON.parse(init.body); llm.push(b); return J({ choices: [{ message: { role: 'assistant', ...(script.shift() || { content: 'Happy to help!' }) } }] }); }
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
const TID = '77777777-7777-4777-8777-777777777777';
T.tenants = [{ id: TID, slug: 'mma', name: 'MMA Salon', subscription_status: 'active', phone_number: '+13055550100', services: [{ name: 'Cut', price: 80, duration: 60 }] }];
for (const k of ['clients', 'conversations', 'messages', 'usage_events', 'client_memories', 'client_memory', 'bookings', 'services', 'staff', 'booking_settings', 'integrations', 'leads']) T[k] = [];
const P = new URL('../../api/', import.meta.url).href;
const mod = await import(P + 'widget-chat.js');
const key = mod.widgetKeyFor('mma');
const run = (req) => new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, end() { resolve({}); } }; mod.default({ headers: {}, url: '/api/widget-chat', ...req }, res); });

let r = await run({ method: 'GET', url: `/api/widget-chat?slug=mma&key=${key}` });
ok(r.ok && r.voice && r.voice.agent_id === 'assistant-57f2d23e-48b1-4107-9811-c40b296f15b6' && r.voice.line === '+13055550100' && r.voice.widget === '0.36.0', 'the one-line widget learns LolaBrain + the salon’s line from LolaDesk (nothing to copy)');
r = await run({ method: 'GET', url: `/api/widget-chat?slug=mma&key=wrong` });
ok(r.status === 401, 'another salon’s key never opens this Lola');

{ const saved = process.env.WIDGET_EMBED_SECRET; delete process.env.WIDGET_EMBED_SECRET; delete process.env.OPERATOR_TOOLS_SECRET;
  const legacy = (await import('node:crypto')).createHmac('sha256', 'dev-only-secret-change-me').update('widget|mma').digest('hex').slice(0, 32);
  const rr = await run({ method: 'GET', url: `/api/widget-chat?slug=mma&key=${legacy}` });
  ok(rr.ok && rr.voice, 'a widget already pasted on a salon site (older key) keeps working');
  process.env.WIDGET_EMBED_SECRET = saved; }
script = [{ content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'list_services', arguments: '{}' } }] }, { content: 'We have a Cut for $80 — want me to find you a time?' }];
r = await run({ method: 'POST', body: { slug: 'mma', key, visitor_id: 'v1', message: 'what do you offer?' } });
ok(r.ok && /Cut for \$80/.test(r.reply), 'chat answers with the real menu: ' + r.reply);
ok(Array.isArray(llm[0].tools) && llm[0].tools.some((t) => t.function?.name === 'book_appointment') && llm[1].messages.some((m) => m.role === 'tool' && m.name === 'list_services'), 'and it is the real Lola: her booking tools, really used');
ok(!/What service, day, and preferred time/.test(r.reply), 'no canned script');

// The script itself: one line, voice first, chat if voice can't load.
const fs = await import('node:fs');
const src = fs.readFileSync(new URL('../../widget.js', import.meta.url), 'utf8');
ok(/telnyx-ai-agent/.test(src) && /X-LolaDesk-Salon/.test(src) && /ai-agent-widget@/.test(src) && /onerror[\s\S]{0,80}showChat/.test(src), 'widget.js starts LolaBrain’s voice with the salon header, and falls back to chat');
ok(/existing\[i\]\.setAttribute\('call-custom-headers'/.test(src), 'an old raw Telnyx snippet on the page is fixed in place (salon header added)');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
