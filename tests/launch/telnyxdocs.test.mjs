// LolaDesk speaks Telnyx exactly as Telnyx documents it (github.com/team-telnyx/ai skills), and
// nobody but LolaDesk's own assistant can touch a salon's clients through Lola's tools.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'tk';
process.env.TELNYX_MESSAGING_PROFILE_ID = 'mp-1'; process.env.TELNYX_ORDER_SETTLE_MS = '0';
delete process.env.TELNYX_PUBLIC_KEY;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const hits = []; let smsStatus = 200;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  hits.push({ u, method: init.method || 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body || '{}') : null });
  if (/\/v2\/messages(\/whatsapp)?$/.test(u)) return smsStatus === 200 ? J({ data: { id: 'msg-1' } }) : J({ errors: [{ code: '40010', detail: 'Not 10DLC registered' }] }, smsStatus);
  if (/\/actions\/(answer|ai_assistant_start)$/.test(u)) return J({ data: { result: 'ok' } });
  if (u.includes('/number_orders')) return J({ data: { id: 'ord-1', status: 'pending' } });
  if (u.includes('/phone_numbers?filter')) return J({ data: [{ id: 'pn-9', phone_number: '+13055559999' }] });
  if (/\/phone_numbers\/pn-9$/.test(u)) return J({ data: { id: 'pn-9', connection_id: 'texml-lola' } });
  if (u.includes('/ai/assistants')) return J({ data: [] });
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
const TID = '00000000-0000-4000-8000-0000000000d1', DAY = 864e5, now = Date.now();
T.tenants = [{ id: TID, name: 'MMA Salon', slug: 'mma', subscription_status: 'active', phone_number: '+13055550100', services: [{ name: 'Blowout', price: 65, duration: 45 }] }];
T.tenant_numbers = [{ tenant_id: TID, phone_number: '+13055550100', kind: 'primary', status: 'active' }];
T.clients = [{ id: 'sarah', tenant_id: TID, first_name: 'Sarah', last_name: 'Kim', phone: '+13055554444', notes: 'allergic to PPD' }];
T.bookings = [{ id: 'nxt', tenant_id: TID, client_id: 'sarah', status: 'confirmed', service: { name: 'Blowout' }, start_time: new Date(now + 2 * DAY).toISOString(), end_time: new Date(now + 2 * DAY + 27e5).toISOString() },
  { id: 'old', tenant_id: TID, client_id: 'sarah', status: 'completed', service: { name: 'Ash blonde' }, start_time: new Date(now - 30 * DAY).toISOString(), end_time: new Date(now - 30 * DAY + 9e6).toISOString() }];
T.client_memories = []; T.calls = []; T.call_sessions = []; T.staff = []; T.opt_outs = []; T.messages = []; T.conversations = []; T.usage_events = []; T.telnyx_events = [];
const run = async (mod, req) => { const h = (await import(P + mod)).default; return new Promise((resolve) => { const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, send(t) { resolve({ status: this.statusCode, text: t }); }, end(t) { resolve({ status: this.statusCode, text: t }); } }; h({ method: 'POST', url: '/api/' + mod, headers: {}, query: {}, ...req }, res); }); };
const { toolKey } = await import(P + 'lib/tool-key.js');
const K = toolKey(), KV = toolKey('variables');

// ── 1. Lola's tools: signed, and private skills only for the caller's own verified line ──
let r = await run('lola-tools.js', { query: { tool: 'cancel_appointment', to: '+13055550100', from: '+13055554444', k: 'forged-key-forged-key-xx' }, body: {} });
ok(r.verified === false && T.bookings.find((b) => b.id === 'nxt').status === 'confirmed', 'a forged tool key gets no private skill (and wakes the re-sign)');
r = await run('lola-tools.js', { query: { tool: 'cancel_appointment', salon: '+13055550100' }, body: { client_phone: '+13055554444' } });
ok(r.verified === false && T.bookings.find((b) => b.id === 'nxt').status === 'confirmed', 'anyone naming a client’s number can’t cancel her booking (unsigned)');
r = await run('lola-tools.js', { query: { tool: 'cancel_appointment', to: '+13055550100', from: '{{telnyx_end_user_target}}', ch: 'web_call', k: K }, body: { client_phone: '+13055554444' } });
ok(r.verified === false && T.bookings.find((b) => b.id === 'nxt').status === 'confirmed', 'a website visitor can’t cancel by typing a number — she offers a texted link instead');
r = await run('lola-tools.js', { query: { tool: 'confirm_booking', to: '+13055550100', from: '+17865550000', ch: 'phone_call', k: K }, body: { client_phone: '+13055554444' } });
ok(r.verified === false, 'a caller can’t look up someone else’s booking from another phone');
r = await run('lola-tools.js', { query: { tool: 'recall_client', salon: '+13055550100', ch: 'web_call', k: K }, body: { client_phone: '(305) 555-4444' } });
ok(/^Hey Sarah, welcome back/.test(r.speak) && !/PPD|Ash|blonde|last/i.test(JSON.stringify(r)), 'a website visitor gets a warm first-name welcome, never the client’s history: ' + r.speak);
r = await run('lola-tools.js', { query: { tool: 'list_services', to: '+13055550100' }, body: {} });
ok(/Blowout/.test(JSON.stringify(r)), 'public skills keep working while the assistant waits to be re-signed');

// ── 2. Salon details webhook: caller memory only for LolaDesk's signed request, and only for a real line ──
r = await run('agent-variables.js', { body: { data: { payload: { telnyx_agent_target: '+13055550100', telnyx_end_user_target: '+13055554444' } } } });
ok(r.dynamic_variables?.company_name === 'MMA Salon' && r.dynamic_variables.caller_known === 'false' && !/PPD/.test(JSON.stringify(r)), 'unsigned: the salon’s public facts, no client memory');
r = await run('agent-variables.js', { url: '/api/agent-variables?k=' + KV, body: { data: { payload: { telnyx_agent_target: '+13055550100', telnyx_end_user_target: '+13055554444' } } } });
ok(r.dynamic_variables?.caller_known === 'true' && /Sarah/.test(r.dynamic_variables.lola_greeting), 'signed phone call: Lola greets Sarah by name');
r = await run('agent-variables.js', { url: '/api/agent-variables?k=' + KV, body: { data: { payload: { telnyx_agent_target: 'assistant-x', telnyx_end_user_target: 'anon-123', telnyx_conversation_channel: 'web_call', custom_headers: [{ name: 'X-LolaDesk-Salon', value: '+13055550100' }] } } } });
ok(r.dynamic_variables?.company_name === 'MMA Salon', 'a salon-website call loads that salon’s real facts (X-LolaDesk-Salon header)');

// ── 3. Numbers: connection_id on PATCH /phone_numbers/{id}; texting attached at order time ──
const prov = await import(P + 'lib/telnyx-provision.js');
hits.length = 0;
await prov.purchaseNumber('+13055559999', 'texml-lola');
const order = hits.find((h) => h.u.endsWith('/number_orders'));
ok(order?.body?.connection_id === 'texml-lola' && order.body.messaging_profile_id === 'mp-1', 'number order carries the voice connection AND the messaging profile');
process.env.TELNYX_LOLA_BRAIN_ID = 'assistant-lola'; process.env.TELNYX_VOICE_APP_ID = 'cc-app-1';
const { _resetAssistantCache } = await import(P + 'lib/assistant-wiring.js'); _resetAssistantCache?.();
hits.length = 0;
const linked = await prov.linkVoiceConnection('pn-9').catch(() => false);
const p = hits.find((h) => h.method === 'PATCH' && /\/phone_numbers\/pn-9/.test(h.u));
ok(linked === true && p && /\/phone_numbers\/pn-9$/.test(p.u) && p.body.connection_id && !hits.some((h) => /\/voice$/.test(h.u)), 'voice routing uses PATCH /phone_numbers/{id} {connection_id} (never /voice): ' + (p ? p.u : 'none'));

// ── 4. Texts: a refused text never looks sent; WhatsApp on its documented route ──
const { sendSms } = await import(P + 'lib/sms.js');
smsStatus = 403;
let s = await sendSms({ from: '+13055550100', to: '(305) 555-4444', text: 'hi', skipOptOut: true });
ok(s.skipped && s.failed && /10DLC/.test(s.reason), 'a Telnyx refusal comes back as failed with the reason: ' + s.reason);
smsStatus = 200; hits.length = 0;
s = await sendSms({ from: '+13055550100', to: '(305) 555-4444', text: 'hi', skipOptOut: true });
const sent = hits.find((h) => /\/v2\/messages$/.test(h.u));
ok(sent?.body?.to === '+13055554444' && s?.data?.id === 'msg-1', 'numbers go out in E.164');
hits.length = 0;
await sendSms({ from: '+13055550100', to: '+13055554444', text: 'hi', type: 'WHATSAPP', skipOptOut: true });
const wa = hits.find((h) => /\/messages\/whatsapp$/.test(h.u));
ok(wa?.body?.type === 'WHATSAPP' && wa.body.whatsapp_message?.text?.body === 'hi', 'WhatsApp uses POST /messages/whatsapp with type WHATSAPP');

// ── 5. A retried inbound text is answered once ──
const ev = { data: { id: 'evt-1', event_type: 'message.received', payload: { id: 'sms-evt-1', from: { phone_number: '+13055554444' }, to: [{ phone_number: '+13055550100' }], text: 'HELP', type: 'SMS' } } };
await run('telnyx-sms.js', { body: ev });
const again = await run('telnyx-sms.js', { body: ev });
ok(again.duplicate === true, 'Telnyx retrying the same text gets no second reply');

// ── 6. Inbound call control: answer first, then ai_assistant_start { assistant: { id } } ──
const { answerCallWithAssistant } = await import(P + 'lib/telnyx.js');
hits.length = 0;
await answerCallWithAssistant('v3:call-1', 'assistant-lola', { commandId: 'evt-9' });
const acts = hits.filter((h) => /\/actions\//.test(h.u));
ok(/\/answer$/.test(acts[0]?.u) && /ai_assistant_start$/.test(acts[1]?.u) && acts[1].body.assistant?.id === 'assistant-lola' && !('assistant_id' in acts[1].body) && acts[1].body.command_id, 'answer → ai_assistant_start {assistant:{id}} with a command_id');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
