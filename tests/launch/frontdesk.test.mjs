// The front desk basics: text anyone from LolaDesk, call a client from
// LolaDesk (your phone rings, then the client is joined), and Lola gets
// appointments confirmed (asks, hears YES, reports who's still pending).
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.TELNYX_VOICE_APP_ID = 'cc-app'; process.env.APP_URL = 'https://www.loladesk.com'; delete process.env.TELNYX_PUBLIC_KEY;
const sms = [], calls = [], actions = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url); const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('/v2/messages')) { sms.push(JSON.parse(init.body)); return J({ data: { id: 'm' + sms.length } }); }
  if (/\/v2\/calls\/[^/]+\/actions\//.test(u)) { actions.push({ url: u, body: JSON.parse(init.body) }); return J({ data: {} }); }
  if (u.endsWith('/v2/calls')) { calls.push(JSON.parse(init.body)); return J({ data: { call_control_id: 'v3:owner-leg' } }); }
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const TID = '00000000-0000-4000-8000-0000000000ee', DAY = 864e5;
globalThis.__authUsers = { tok: { id: 'u1', email: 'owner@salon.com' } };
T.tenants = [{ id: TID, name: 'MMA Salon', slug: 'mma', owner_email: 'owner@salon.com', subscription_status: 'active', phone_number: '+13055550100', operator_phone: '+17865550199' }];
T.tenant_users = [{ user_id: 'u1', tenant_id: TID, role: 'owner', status: 'active' }];
T.tenant_numbers = [{ tenant_id: TID, phone_number: '+13055550100', kind: 'primary', status: 'active', connection_id: 'cc-app' }];
T.booking_settings = [{ tenant_id: TID, timezone: 'America/New_York' }];
T.clients = [{ id: 'c1', tenant_id: TID, first_name: 'Maria', last_name: 'Lopez', phone: '+13055551111' }, { id: 'c2', tenant_id: TID, first_name: 'Ana', last_name: 'Ruiz', phone: '+13055552222' }];
T.services = [{ id: 's1', tenant_id: TID, name: 'Balayage', price: 250, duration_minutes: 180 }];
T.conversations = [{ id: 'conv-sms', tenant_id: TID, client_id: 'c2', channel: 'sms', status: 'open' }];   // a real SMS thread: no from_number column set
T.messages = []; T.client_memories = []; T.booking_reminders = []; T.usage_events = []; T.opt_outs = []; T.calls = []; T.staff = [];
// "Tomorrow" in the SALON's time zone (the old UTC version failed every evening after 8pm in Miami).
const tomorrow = new Date(new Date(Date.now() + DAY).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) + 'T19:00:00Z');
T.bookings = [{ id: 'b1', tenant_id: TID, client_id: 'c1', service_id: 's1', status: 'confirmed', start_time: tomorrow.toISOString(), end_time: new Date(tomorrow.getTime() + 3 * 3600e3).toISOString() },
  { id: 'b2', tenant_id: TID, client_id: 'c2', service_id: 's1', status: 'confirmed', start_time: new Date(tomorrow.getTime() + 3600e3).toISOString(), end_time: new Date(tomorrow.getTime() + 4 * 3600e3).toISOString() }];
const run = async (mod, body, method = 'POST') => { const h = (await import(P + mod)).default; return new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, end() { resolve({ status: this.statusCode }); } }; h({ method, url: '/api/' + mod, headers: { authorization: 'Bearer tok' }, query: {}, body }, res); }); };

// 1) Texting from the Inbox
let r = await run('inbox-reply.js', { conversation_id: 'new-123', to: '(305) 322-7442', text: 'Hi! Your table is ready.' });
ok(r.ok && r.conversation_id && sms.at(-1)?.to === '+13053227442' && sms.at(-1)?.from === '+13055550100', 'a new message to a new number goes out from the salon line (no more “Conversation not found”)');
r = await run('inbox-reply.js', { conversation_id: 'conv-sms', text: 'See you at 4!' });
ok(r.ok && sms.at(-1)?.to === '+13055552222', 'replying in a real text thread reaches the client (number taken from their profile)');

// 2) Calling a client from LolaDesk
r = await run('call-center/call-client.js', { to: '+13055551111', name: 'Maria' });
ok(r.ok && calls.at(-1)?.to === '+17865550199' && calls.at(-1)?.from === '+13055550100' && /\/api\/call-center\/bridge$/.test(calls.at(-1)?.webhook_url), 'your phone rings first, from the salon line');
const { bridgeStep, decodeState } = await import(P + 'lib/owner-call.js');
const ev = (type, cs) => ({ data: { event_type: type, payload: { call_control_id: 'v3:owner-leg', client_state: cs } } });
const s1 = bridgeStep(ev('call.answered', calls.at(-1).client_state));
ok(s1?.action === 'speak' && /Connecting you to Maria/.test(s1.body.payload), 'you pick up → “Connecting you to Maria”');
const s2 = bridgeStep(ev('call.speak.ended', s1.body.client_state));
ok(s2?.action === 'transfer' && s2.body.to === '+13055551111' && s2.body.from === '+13055550100', 'then Maria is dialed and joined; she sees the salon’s number');
ok(bridgeStep(ev('call.speak.ended', s2.body.client_state)) === null && bridgeStep(ev('call.answered', 'junk')) === null, 'it never double-dials, and ignores other calls');
T.tenants[0].operator_phone = null;
r = await run('call-center/call-client.js', { to: '+13055551111', name: 'Maria' });
ok(!r.ok && /Settings/.test(r.say), 'no mobile on file → it says where to add it');
T.tenants[0].operator_phone = '+17865550199';

// 3) Lola confirms appointments
const { routeOwnerIntent } = await import(P + 'lib/owner-intents.js');
ok(routeOwnerIntent("confirm tomorrow's appointments")?.tool === 'confirm_appointments' && routeOwnerIntent('who confirmed tomorrow?')?.tool === 'confirmation_status', 'reflexes: “confirm tomorrow’s appointments”, “who confirmed tomorrow?”');
const say = async (text) => run('lola.js', { messages: [{ role: 'user', content: text }], channel: 'dashboard' });
const before = sms.length;
r = await say("Lola, confirm tomorrow's appointments");
ok(r.needs_confirmation && /2 clients/.test(r.content[0].text) && sms.length === before, 'she previews who she’ll text: ' + r.content[0].text);
r = await say('yes');
const asks = sms.slice(before);
ok(asks.length === 2 && asks.every(m => /Reply YES to confirm or R to reschedule/.test(m.text)) && /Hi Maria! It's Lola from MMA Salon\. Confirming your Balayage/.test(asks[0].text), 'each client gets their own confirmation text');
const smsIn = (from, text) => run('telnyx-sms.js', { data: { event_type: 'message.received', payload: { from: { phone_number: from }, to: [{ phone_number: '+13055550100' }], text, type: 'SMS' } } });
r = await smsIn('+13055551111', 'Yes!');
ok(r.handled === 'confirmed' && /You're confirmed for your Balayage/.test(sms.at(-1).text) && sms.at(-1).to === '+13055551111', 'Maria replies YES → confirmed, and Lola thanks her');
r = await say('who confirmed tomorrow?');
ok(/1 of 2 confirmed/.test(r.content[0].text) && /Ana/.test(r.content[0].text), 'status: ' + r.content[0].text);
const { reminderText } = await import(P + 'lib/lola-persona.js');
ok(/Reply YES to confirm/.test(reminderText({ salon: 'MMA', what: 'Balayage', when: 'Fri 3 PM' })), 'the day-before reminder asks for a YES too');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
