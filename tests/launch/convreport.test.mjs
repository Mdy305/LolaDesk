// Every conversation Lola has — the website widget, phone calls — lands on the salon's Calls screen with
// its transcript and a summary, and is emailed to the salon. Exactly once.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'tk';
process.env.SENDGRID_API_KEY = 'sg-test'; process.env.TELNYX_LOLA_BRAIN_ID = 'assistant-lola'; process.env.CRON_SECRET = 'cron';
process.env.ELEVENLABS_API_KEY = 'el'; process.env.ELEVENLABS_VOICE_ID = 'v'; delete process.env.TELNYX_PUBLIC_KEY;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const mails = [];
const old = new Date(Date.now() - 10 * 60e3).toISOString(), fresh = new Date().toISOString();
const convs = [
  { id: 'c-web', created_at: old, last_message_at: old, metadata: { assistant_id: 'assistant-lola', telnyx_conversation_channel: 'web_call', 'x-loladesk-salon': '+13055550100', call_control_id: 'v3:web-1' } },
  { id: 'c-live', created_at: fresh, last_message_at: fresh, metadata: { assistant_id: 'assistant-lola', telnyx_conversation_channel: 'phone_call', telnyx_agent_target: '+13055550100', telnyx_end_user_target: '+13055550177' } },
  { id: 'c-sms', created_at: old, last_message_at: old, metadata: { assistant_id: 'assistant-lola', telnyx_conversation_channel: 'sms', telnyx_agent_target: '+13055550100' } },
  { id: 'c-other', created_at: old, last_message_at: old, metadata: { assistant_id: 'assistant-lola', telnyx_conversation_channel: 'web_call' } },
];
const messages = {
  'c-web': [
    { role: 'assistant', text: 'Thanks for calling MMA Salon! This is Lola.', created_at: '2026-10-04T05:00:00Z' },
    { role: 'user', text: 'I want a haircut tomorrow at 2', created_at: '2026-10-04T05:00:05Z' },
    { role: 'assistant', text: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'book_appointment', arguments: JSON.stringify({ service: 'Cut', client_name: 'Jerome Martin', client_phone: '3055550199' }) } }], created_at: '2026-10-04T05:00:20Z' },
    { role: 'tool', text: JSON.stringify({ booked: true, speak: "You're all set" }), created_at: '2026-10-04T05:00:21Z' },
    { role: 'assistant', text: "You're all set, Jerome — Cut tomorrow at 2 PM.", created_at: '2026-10-04T05:00:22Z' },
  ],
};
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('api.sendgrid.com')) { mails.push(JSON.parse(init.body)); return new Response('', { status: 202 }); }
  const mm = u.match(/\/ai\/conversations\/([^/?]+)\/messages/);
  if (mm) return J({ data: messages[decodeURIComponent(mm[1])] || [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }], meta: { total_pages: 1 } });
  if (u.includes('/ai/conversations')) return J({ data: convs });
  if (/\/ai\/assistants\/assistant-lola/.test(u)) return J({ data: { id: 'assistant-lola', name: 'Lola', tools: [] } });
  if (u.includes('/ai/assistants')) return J({ data: [{ id: 'assistant-lola', name: 'Lola' }] });
  if (u.includes('/chat/completions')) return J({ choices: [{ message: { role: 'assistant', content: 'Jerome Martin booked a Cut tomorrow at 2 PM.' } }] });
  if (u.includes('/text-to-speech/')) return new Response(new Uint8Array(500), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  if (u.includes('fake.supabase.co/storage') && init.method === 'HEAD') return new Response(null, { status: 404 });
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
const TID = '55555555-5555-4555-8555-555555555555';
T.tenants = [{ id: TID, name: 'MMA Salon', slug: 'mma', owner_email: 'owner@mmasalon.com', phone_number: '+13055550100', knowledge: 'Free-text notes about the salon.' }];
T.booking_settings = [{ tenant_id: TID, metadata: { transcript_email: 'desk@mmasalon.com' } }];
T.tenant_numbers = [{ tenant_id: TID, phone_number: '+13055550100', status: 'active' }];
T.calls = []; T.call_sessions = []; T.clients = []; T.conversations = []; T.messages = []; T.usage_events = []; T.client_memories = []; T.client_memory = [];
const P = new URL('../../api/', import.meta.url).href;
const cron = (await import(P + 'cron/conversation-reports.js')).default;
const run = () => new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve(o); } }; cron({ method: 'GET', headers: { authorization: 'Bearer cron' }, query: {} }, res); });

let r = await run();
const row = T.calls.find((x) => x.insight_id === 'conv:c-web');
ok(r.ok && r.saved === 1 && row && row.tenant_id === TID, 'the website conversation lands on MMA’s Calls screen');
ok(row && /^Lola: Thanks for calling/.test(row.recording_url) && /Caller: I want a haircut tomorrow at 2/.test(row.recording_url) && /Lola: You're all set, Jerome/.test(row.recording_url), 'with the full transcript, Caller/Lola, in order');
ok(row && row.status === 'booked' && /Jerome Martin booked a Cut/.test(row.summary), 'marked booked, with a summary: ' + row?.summary);
ok(mails.length === 2 && mails.map((m) => m.personalizations[0].to[0].email).sort().join() === 'desk@mmasalon.com,owner@mmasalon.com', 'emailed to the owner and the extra address from Settings');
ok(/Lola · New booking — Jerome Martin/.test(mails[0].personalizations[0].subject) && /I want a haircut tomorrow at 2/.test(JSON.stringify(mails[0].content)), 'the email carries the transcript: ' + mails[0].personalizations[0].subject);
ok(r.unknown_salon === 1 && !T.calls.some((x) => x.insight_id === 'conv:c-other'), 'a conversation with no salon is never guessed onto someone’s screen');
ok(!T.calls.some((x) => x.insight_id === 'conv:c-live') && !T.calls.some((x) => x.insight_id === 'conv:c-sms'), 'a call still in progress waits; texts stay in the Inbox');

r = await run();
ok(r.saved === 0 && mails.length === 2 && T.calls.filter((x) => x.insight_id === 'conv:c-web').length === 1, 'run again → nothing twice (no duplicate row, no second email)');

T.booking_settings[0].metadata = { transcript_emails: false };
convs[1].last_message_at = old;
r = await run();
ok(r.saved === 1 && mails.length === 2, 'emails switched off in Settings → still on the screen, no email');
T.booking_settings[0].metadata = {};

// LolaDesk's own phone line: when the call ends, the same report.
const voice = (await import(P + 'telnyx-voice.js')).default;
T.calls.push({ id: 'call-9', tenant_id: TID, telnyx_call_control_id: 'CA-9', from_number: '+13055550123', to_number: '+13055550100', status: 'answered', recording_url: 'Caller: Do you do balayage?\nLola: We do — balayage starts at two twenty.\n' });
await new Promise((resolve) => { const res = { setHeader() {}, status() { return this; }, send: resolve, json: resolve, end: resolve }; voice({ method: 'POST', url: '/api/telnyx-voice', headers: {}, body: { CallSid: 'CA-9', From: '+13055550123', To: '+13055550100', CallStatus: 'completed', CallDuration: '42' } }, res); });
const c9 = T.calls.find((x) => x.id === 'call-9');
ok(c9.status === 'completed' && c9.summary && c9.insight_id === 'texml:CA-9' && c9.duration_seconds === 42, 'a finished phone call gets its summary and closes on the Calls screen');
ok(mails.length === 3 && /New phone call — \+13055550123/.test(mails[2].personalizations[0].subject), 'and the salon gets it by email: ' + mails[2]?.personalizations[0].subject);
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
