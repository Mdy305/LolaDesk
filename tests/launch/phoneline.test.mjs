// LolaDesk's own call line — the path that answered every call before the assistant move, now with
// Lola's real brain and tools: salon numbers ring /api/telnyx-voice, she thinks with Telnyx AI,
// books with her skills and speaks in her ElevenLabs voice (cached in Supabase Storage).
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'tk';
process.env.TELNYX_LOLA_BRAIN_ID = 'assistant-lola'; process.env.TELNYX_VOICE_APP_ID = 'cc-app'; process.env.ELEVENLABS_API_KEY = 'el'; process.env.ELEVENLABS_VOICE_ID = 'lolaVoice';
process.env.APP_URL = 'https://www.loladesk.com'; process.env.LOLA_PHONE_MODE = 'loladesk'; /* LolaDesk's own line is optional (LolaBrain is the default) */ delete process.env.VOICE_PROVIDER; delete process.env.TELNYX_PUBLIC_KEY;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };

const texml = [{ id: 'old-line', friendly_name: 'LolaDesk', voice_url: 'https://lola-desk-one.vercel.app/api/telnyx-voice' }];
const phone = [{ id: 'n1', phone_number: '+13055550100', connection_id: 'assistant-app' }];
const texmlPatches = [], numberPatches = [], llm = [];
let llmScript = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (/\/texml_applications\/cc-app/.test(u)) return J({ errors: [{ detail: 'Resource not found' }] }, 404);   // the Vercel id is a Call Control app
  const tm = u.match(/\/texml_applications\/([^/?]+)/);
  if (tm) { const a = texml.find((x) => x.id === tm[1]); if (init.method === 'PATCH') { const b = JSON.parse(init.body); texmlPatches.push(b); Object.assign(a, b); } return J({ data: a }); }
  if (u.includes('/texml_applications')) { if (init.method === 'POST') { const b = JSON.parse(init.body); const a = { id: 'new-line', ...b }; texml.push(a); return J({ data: a }); } return J({ data: texml }); }
  if (/\/phone_numbers\/n\d$/.test(u) && init.method === 'PATCH') { const b = JSON.parse(init.body); numberPatches.push(b.connection_id); phone[0].connection_id = b.connection_id; return J({ data: phone[0] }); }
  if (u.includes('/phone_numbers')) return J({ data: phone });
  if (/\/ai\/assistants\/assistant-lola/.test(u)) return J({ data: { id: 'assistant-lola', name: 'Lola', greeting: '{{lola_greeting}}', tools: [], telephony_settings: { default_texml_app_id: 'assistant-app', supports_unauthenticated_web_calls: true } } });
  if (u.includes('/ai/assistants')) return J({ data: [{ id: 'assistant-lola', name: 'Lola' }] });
  if (u.includes('/text-to-speech/')) return new Response(new Uint8Array(2000), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  if (u.includes('fake.supabase.co/storage') && init.method === 'HEAD') return new Response(null, { status: 404 });
  if (u.includes('/chat/completions')) { const b = JSON.parse(init.body); llm.push(b); const next = llmScript.shift() || { content: 'ready' }; return J({ choices: [{ message: { role: 'assistant', ...next } }] }); }
  if (u.endsWith('/balance')) return J({ data: { balance: '9', available_credit: '9' } });
  if (/\/ai\/(openai\/)?models/.test(u)) return J({ data: [{ id: 'meta-llama/Llama-3.3-70B-Instruct' }] });
  if (u.includes('/ai/audio/transcriptions')) return J({ text: '' });
  if (u.includes('/messages')) return J({ data: { id: 'm1' } });
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
T.tenants = [{ id: 't1', slug: 'mma', name: 'MMA Salon', phone_number: '+13055550100', timezone: 'America/New_York', status: 'active', plan: 'pro', services: [{ name: 'Haircut', price: 60, duration: 45 }] }];
T.tenant_numbers = [{ tenant_id: 't1', phone_number: '+13055550100', status: 'active' }];
T.calls = []; T.clients = []; T.conversations = []; T.messages = []; T.usage_events = []; T.client_memory = []; T.platform_settings = [];
const P = new URL('../../api/', import.meta.url).href;
const pv = await import(P + 'lib/telnyx-provision.js');

ok(await pv.phoneMode() === 'loladesk', 'when chosen, salon calls are answered on LolaDesk’s own line');
const line = await pv.getCanonicalVoiceConnectionId();
ok(line === 'old-line', 'the existing “LolaDesk” call line is reused (the Call Control app in Vercel is never mistaken for it)');
ok(texmlPatches.some((b) => b.voice_url === 'https://www.loladesk.com/api/telnyx-voice'), 'and pointed back at this deployment when it drifted to an old domain');

// Numbers follow the line: status moves a number left on the assistant's app, and makes the voice storage.
const { buildStatus } = await import(P + 'status.js');
const s = await buildStatus();
ok(s.live.phone_line === 'loladesk' && s.live.phone_line_ready === true, 'status says which line answers calls');
ok(numberPatches.includes('old-line') && s.live.salon_numbers_ringing_lola === 1, 'the salon number now rings LolaDesk’s line: ' + s.healed.join(' | '));
ok(T.__buckets?.['voice-audio']?.public === true && s.live.phone_voice_cache === true, 'Lola’s phone-voice storage exists and is playable');
ok(!s.fixes.some((f) => /don’t ring Lola/.test(f)), 'nothing left to fix about the numbers');

// A call, turn by turn.
const voice = (await import(P + 'telnyx-voice.js')).default;
const call = (body, query = '') => new Promise((resolve) => {
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, send(x) { resolve({ code: this.statusCode, xml: String(x) }); }, json(o) { resolve({ code: this.statusCode, json: o }); }, end() { resolve({ code: this.statusCode }); } };
  voice({ method: 'POST', url: '/api/telnyx-voice' + query, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }, res);
});
const base = { CallSid: 'call-1', From: '+13055559999', To: '+13055550100', CallStatus: 'in-progress' };
let r = await call({ ...base });
ok(r.code === 200 && /<Play>https:\/\/fake\.supabase\.co\/storage\/v1\/object\/public\/voice-audio\/cached\/.+\.mp3<\/Play>/.test(r.xml) && /<Gather input="dtmf speech"/.test(r.xml), 'she answers in her own voice and listens');
ok(Object.keys(T.__buckets['voice-audio'].files).length >= 1, 'the greeting audio is stored once for every later caller');

r = await call({ ...base, SpeechResult: 'Can I get a haircut tomorrow afternoon?' });
ok(/<Redirect method="POST">\/api\/telnyx-voice\?continue=/.test(r.xml) && /<Play>/.test(r.xml), 'no dead air: “one sec…” plays while she works');
const cont = r.xml.match(/continue=([^<]+)</)[1];

llmScript = [
  { content: null, tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'check_availability', arguments: JSON.stringify({ service: 'Haircut', date: '2026-10-05' }) } }] },
  { content: 'Tomorrow I have two thirty or four o’clock for a haircut — which works?' },
];
r = await call({ ...base }, '?continue=' + cont);
const asked = llm.at(-1);
ok(llm.length >= 2 && Array.isArray(llm[llm.length - 2].tools) && llm[llm.length - 2].tools.some((t) => t.function?.name === 'book_appointment'), 'she thinks with her real tools on the phone (book, move, cancel, check times)');
ok(asked.messages.some((m) => m.role === 'tool' && m.name === 'check_availability'), 'and really checks the book before offering times');
ok(/<Play>/.test(r.xml) && /<Gather/.test(r.xml) && r.code === 200, 'then answers in her voice and keeps listening');
ok(/phone call/i.test(asked.messages[0].content) && /HOW YOU SPEAK/.test(asked.messages[0].content), 'she knows it is a live phone call');
ok(!/What service, day, and preferred time should I lock in/.test(JSON.stringify(T.messages)), 'no canned script answers a caller who already said what they want');
ok(T.messages.some((m) => m.role === 'user' && /haircut tomorrow/i.test(m.content)) && T.messages.some((m) => m.role === 'assistant' && /two thirty/.test(m.content)), 'the conversation lands in the salon’s inbox');

ok(/<Gather input="dtmf speech" finishOnKey="#"/.test(r.xml), 'Telnyx Gather listens for speech AND the keypad');
llmScript = [{ content: 'Perfect — what time works for you?' }];
r = await call({ ...base, Digits: '1' }, '?continue=');
const k = await import(P + 'telnyx-voice.js');
ok(k.keypadWords('1') === '(pressed 1 on the keypad) Yes.' && /My number is 3055550199/.test(k.keypadWords('3055550199#')) && /talk to someone/.test(k.keypadWords('0')), 'keys become words Lola understands (1 = yes, a typed number, 0 = the salon)');
r = await call({ ...base, Digits: '1' });
ok(/<Redirect method="POST">\/api\/telnyx-voice\?continue=/.test(r.xml) && Buffer.from(r.xml.match(/continue=([^<]+)</)[1], 'base64url').toString() === '(pressed 1 on the keypad) Yes.', 'pressing 1 mid-call is heard like saying “yes”');

r = await call({ ...base, CallStatus: 'completed' });
ok(r.code === 200 && /<Response\/>/.test(r.xml) && T.calls.length === 1, 'the call-finished callback is not mistaken for a new caller');

r = await call({ ...base, To: '+19995550000' });
ok(r.code === 200 && /<Hangup\/>/.test(r.xml), 'an unknown number is ended politely — never a crash');

// ElevenLabs down: never a robot voice, never a 502 — the call ends and Lola texts the caller.
const realFetch = globalThis.fetch; let texted = false;
globalThis.fetch = async (url, init) => { const u = String(url); if (u.includes('/text-to-speech/')) return new Response('{}', { status: 500 }); if (u.includes('/messages') && init?.method === 'POST') texted = true; return realFetch(url, init); };
llmScript = [{ content: 'Sure — what day suits you best?' }];
r = await call({ ...base }, '?continue=' + Buffer.from('I need a color appointment').toString('base64url'));
ok(r.code === 200 && /<Hangup\/>/.test(r.xml) && !/<Say/.test(r.xml), 'voice down → no substitute voice, no crash');
globalThis.fetch = realFetch;

// The admin switch: the Telnyx assistant line.
delete process.env.LOLA_PHONE_MODE; T.platform_settings.push({ key: 'lola_phone_mode', value: { mode: 'assistant' } }); pv._resetPhoneLineCache();
ok(await pv.phoneMode() === 'assistant' && await pv.getCanonicalVoiceConnectionId() === 'assistant-app', 'the admin can switch every salon to the Telnyx assistant line');
process.env.LOLA_PHONE_MODE = 'loladesk';
ok(await pv.phoneMode() === 'loladesk', 'LOLA_PHONE_MODE in Vercel wins over the admin switch');
delete process.env.LOLA_PHONE_MODE; T.platform_settings.length = 0; pv._resetPhoneLineCache();
ok(await pv.phoneMode() === 'assistant', 'by default LolaBrain answers every salon’s calls');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
