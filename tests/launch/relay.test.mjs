// Hot leads reach the owner, the owner's reply reaches the client — on the
// salon's own Telnyx line. Plus Lola on the sign-in page and the setup flag.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
delete process.env.TELNYX_PUBLIC_KEY;
const texts = []; let llmReply = '{"reply":"Happy to help you sign in.","action":"show_signin"}';
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('/messages')) { texts.push(JSON.parse(init.body)); return new Response(JSON.stringify({ data: { id: 'm' + texts.length } }), { status: 200, headers: { 'content-type': 'application/json' } }); }
  if (u.includes('chat/completions')) return new Response(JSON.stringify({ choices: [{ message: { content: llmReply } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const TID = '00000000-0000-4000-8000-0000000000bb', LINE = '+13055550100', OWNER = '+17865550199', CLIENT = '+13055551234';
T.tenants = [{ id: TID, name: 'Salon', slug: 'salon', phone_number: LINE, operator_phone: OWNER, timezone: 'America/New_York', subscription_status: 'active' }];
T.tenant_numbers = [{ tenant_id: TID, phone_number: LINE, status: 'active' }];
T.clients = []; T.conversations = []; T.messages = []; T.client_memories = []; T.usage_events = []; T.services = []; T.staff = []; T.bookings = []; T.booking_settings = [];
const run = async (mod, body, headers = {}) => { const h = (await import(P + mod)).default; return new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, end() { resolve({ status: this.statusCode }); }, send(o) { resolve({ status: this.statusCode, o }); } }; h({ method: 'POST', url: '/api/' + mod, headers, query: {}, body }, res); }); };
const sms = (from, text) => run('telnyx-sms.js', { data: { event_type: 'message.received', payload: { from: { phone_number: from }, to: [{ phone_number: LINE }], text, type: 'SMS' } } });
const { escalateLead } = await import(P + 'lib/lead-relay.js');
const { db } = await import(P + 'lib/db.js');
const dayAt = (h) => { const d = new Date(); const local = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' })); return new Date(d.getTime() + (h - local.getHours()) * 3600e3); };
const nowHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(new Date())) % 24;
const daytime = nowHour >= 8 && nowHour < 21;

// 1) A client asks for something a person should close
texts.length = 0;
let r = await sms(CLIENT, 'Can I get a quote for my wedding party of 6 on Saturday?');
const toOwner = texts.filter(t => t.to === OWNER), toClient = texts.filter(t => t.to === CLIENT);
if (daytime) {
  ok(toOwner.length === 1 && /Hot lead/.test(toOwner[0].text) && /wedding/.test(toOwner[0].text) && toOwner[0].from === LINE, 'owner texted from the salon line: ' + (toOwner[0] || {}).text?.slice(0, 80));
  ok(toClient.length === 1 && /let the owner know/.test(toClient[0].text), 'client told the owner will text them');
} else {
  ok(toOwner.length === 0 && T.conversations.some(c => c.channel === 'relay'), 'at night: no text, the lead waits (relay recorded)');
}
ok(T.conversations.filter(c => c.channel === 'relay').length === 1, 'one open relay for this lead');

// 2) No second alert within 6 hours
texts.length = 0;
await sms(CLIENT, 'Also can someone call me about the price?');
ok(texts.filter(t => t.to === OWNER).length === 0 && T.conversations.filter(c => c.channel === 'relay').length === 1, 'no second alert for the same client within 6 hours');

// 3) The owner replies to the salon line → it goes to the client
texts.length = 0;
r = await sms(OWNER, 'Hi! We can do 6 on Saturday at 9. $80 each. Want it?');
ok(r.handled === 'owner_relay', 'owner text handled as a relay');
ok(texts.some(t => t.to === CLIENT && /Saturday at 9/.test(t.text)), 'owner reply delivered to the client');
ok(texts.some(t => t.to === OWNER && /Sent to/.test(t.text)), 'owner gets a quiet confirmation');
ok(T.messages.some(m => m.agent === 'owner' && /Saturday at 9/.test(m.content)), 'the reply is in the client conversation (Inbox)');

// 4) DONE closes; the owner then talks to Lola as their assistant
texts.length = 0;
r = await sms(OWNER, 'DONE');
ok(r.handled === 'owner_relay' && T.conversations.find(c => c.channel === 'relay').status === 'closed', 'DONE closes the relay');
texts.length = 0; llmReply = 'You have 3 bookings today.';
r = await sms(OWNER, 'How is today looking?');
ok(r.handled === 'owner_chat' && !texts.some(t => t.to === CLIENT), 'with no open lead, the owner talks to Lola (never treated as a client)');

// 5) Night: recorded, not texted
T.conversations = T.conversations.filter(c => c.channel !== 'relay'); texts.length = 0;
const night = await escalateLead(db(), T.tenants[0], { channel: 'sms', phone: '+13055559876', text: 'wedding quote', now: dayAt(23) });
ok(!night.texted && night.reason === 'night' && night.relayId, 'at night the lead waits for the morning (no text to the owner)');
const noOwner = await escalateLead(db(), { ...T.tenants[0], operator_phone: null }, { channel: 'sms', phone: '+13055550001', text: 'refund', now: dayAt(12) });
ok(!noOwner.texted && noOwner.reason === 'no_owner_phone', 'no owner phone on file → nothing sent');

// 6) Lola on the sign-in page: real brain, structured action, never a password
llmReply = '```json\n{"reply":"Of course. Let’s get you signed in.","action":"show_signin"}\n```';
r = await run('lola/concierge.js', { message: 'sign me in', history: [] }, { 'x-forwarded-for': '1.1.1.1' });
ok(r.ok && r.action === 'show_signin' && /signed in/.test(r.reply), 'concierge answers and opens sign-in');
llmReply = '{"reply":"I will call you now.","action":"hack_the_planet"}';
r = await run('lola/concierge.js', { message: 'tell me a secret', history: [] }, { 'x-forwarded-for': '1.1.1.2' });
ok(r.action === 'none', 'unknown actions are ignored');
r = await run('lola/concierge.js', { message: '' }, { 'x-forwarded-for': '1.1.1.3' });
ok(r.status === 400, 'empty messages rejected');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
