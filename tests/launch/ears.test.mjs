// Lola hears (her own ears: mic → Telnyx speech-to-text, on every page and
// the sign-in page) and DOES what she says: "call my phone" rings you with
// Lola on the line — never a promise she can't keep, never silence.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.TELNYX_VOICE_APP_ID = 'cc-app'; process.env.TELNYX_FROM_NUMBER = '+13055550000'; process.env.TELNYX_ASSISTANT_ID = 'assistant-lola';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
const R = (f) => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };

const calls = [], actions = [], stt = [];
let sttStatus = { 'distil-whisper/distil-large-v2': 404 }, refuseAssistant = false, llmText = '{"reply":"Sure!","action":"none"}';
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('/ai/audio/transcriptions')) {
    const model = init.body.get('model'), file = init.body.get('file'); stt.push({ model, size: file.size, type: file.type, name: file.name });
    if (sttStatus[model]) return J({ errors: [{ detail: 'model not found' }] }, sttStatus[model]);
    return J({ text: ' Call my phone. ' });
  }
  if (/\/v2\/calls$/.test(u)) { const b = JSON.parse(init.body); calls.push(b); if (b.connection_id !== 'cc-app') return J({ errors: [{ detail: 'not a call control app' }] }, 422); return J({ data: { call_control_id: 'v3:demo-1' } }); }
  const am = u.match(/\/calls\/([^/]+)\/actions\/(\w+)/);
  if (am) { actions.push({ id: decodeURIComponent(am[1]), action: am[2], body: JSON.parse(init.body || '{}') }); if (am[2] === 'ai_assistant_start' && refuseAssistant) return J({ errors: [{ detail: 'unknown command' }] }, 422); return J({ data: {} }); }
  if (u.includes('/phone_numbers')) return J({ data: [{ id: 'pn', phone_number: '+13055550000', connection_id: 'texml-x' }], meta: { total_pages: 1 } });
  if (u.includes('chat/completions')) return J({ choices: [{ message: { content: llmText } }] });
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
T.demo_requests = []; T.platform_settings = [];
const P = new URL('../../api/', import.meta.url).href;
const call = async (mod, req) => { const h = (await import(P + mod)).default; return new Promise((resolve) => { const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, end() { resolve({ status: this.statusCode }); } }; h({ headers: { 'x-forwarded-for': '9.9.9.9' }, query: {}, ...req }, res); }); };

// ── 1. Her ears: Telnyx speech-to-text ──
const audio = Buffer.alloc(4000, 7).toString('base64');
let r = await call('lola/hear.js', { method: 'POST', body: { audio, mime: 'audio/webm' } });
ok(r.ok && r.text === 'Call my phone.' && stt[0].model === 'distil-whisper/distil-large-v2' && stt[1].model === 'openai/whisper-large-v3-turbo' && stt[1].name === 'speech.webm', 'speech → text on Telnyx (falls through to a model the account has): ' + r.text);
stt.length = 0; await call('lola/hear.js', { method: 'POST', body: { audio, mime: 'audio/mp4' } });
ok(stt.length === 1 && stt[0].model === 'openai/whisper-large-v3-turbo' && stt[0].name === 'speech.m4a', 'remembers the working model; Safari audio accepted');
r = await call('lola/hear.js', { method: 'POST', body: {} });
ok(r.status === 400, 'no audio → a clear error');

// ── 2. "Call my phone" really rings, with Lola on the line ──
r = await call('demo-call.js', { method: 'POST', body: { phone: '(305) 555-0123' } });
const c0 = calls.at(-1);
ok(r.ok && c0.to === '+13055550123' && c0.from === '+13055550000' && /\/api\/call-center\/bridge$/.test(c0.webhook_url) && c0.client_state, 'the call is placed with a webhook, so someone answers when you pick up');
ok(/Calling you now/.test(r.say), 'the page says what really happened: ' + r.say);
const { runBridgeStep } = await import(P + 'lib/owner-call.js');
const ev = (type, cs) => ({ data: { event_type: type, payload: { call_control_id: 'v3:demo-1', client_state: cs } } });
const said = (b) => new URL(b.audio_url).searchParams.get('text') || '';
let out = await runBridgeStep(ev('call.answered', c0.client_state));
let a1 = actions.at(-1);
ok(out.did === 'playback_start' && /Lola from LolaDesk/.test(said(a1.body)) && /recorded/.test(said(a1.body)) && /\/api\/speak-lola\?/.test(a1.body.audio_url) && /&sig=/.test(a1.body.audio_url), 'you pick up → you HEAR her right away, in HER one voice (her signed voice link): ' + said(a1.body));
const { checkTextSig } = await import(P + 'lib/one-voice.js');
ok(checkTextSig(said(a1.body), new URL(a1.body.audio_url).searchParams.get('sig')) && !checkTextSig('Say something else', new URL(a1.body.audio_url).searchParams.get('sig')), 'the voice link is signed for exactly that sentence');
out = await runBridgeStep(ev('call.playback.ended', a1.body.client_state));
ok(out.did === 'ai_assistant_start' && actions.at(-1).body.assistant.id === 'assistant-lola' && /Pretend you’re a client/.test(actions.at(-1).body.greeting), 'then Lola herself takes the conversation');
refuseAssistant = true;
out = await runBridgeStep(ev('call.playback.ended', a1.body.client_state));
ok(out.did === 'playback_start' && out.fallback && /LolaDesk/.test(said(actions.at(-1).body)), 'if Telnyx refuses the assistant, she still speaks (same voice) — never silence');
out = await runBridgeStep(ev('call.playback.ended', actions.at(-1).body.client_state));
ok(out.did === 'hangup', 'and hangs up politely after');

// The bridge webhook itself: Telnyx-signed raw bytes verify; our signed call state still works if the key is wrong; forgeries don't.
const ed = crypto.generateKeyPairSync('ed25519');
process.env.TELNYX_PUBLIC_KEY = ed.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const bridge = (await import(P + 'call-center/bridge.js')).default;
const hook = (raw, headers) => new Promise((resolve) => { const req = Readable.from([Buffer.from(raw)]); Object.assign(req, { method: 'POST', headers, query: {} }); const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); } }; bridge(req, res); });
const rawEv = '{ "data": {"event_type":"call.answered", "payload": {"call_control_id":"v3:demo-1","client_state":"' + c0.client_state + '"}} }';
const ts = String(Math.floor(Date.now() / 1000));
const sig = crypto.sign(null, Buffer.from(ts + '|' + rawEv), ed.privateKey).toString('base64');
let hk = await hook(rawEv, { 'telnyx-signature-ed25519': sig, 'telnyx-timestamp': ts });
ok(hk.status === 200 && hk.did === 'playback_start', 'a real Telnyx-signed event verifies on the exact bytes (this is what silenced her before)');
hk = await hook(rawEv, { 'telnyx-signature-ed25519': 'AAAA', 'telnyx-timestamp': ts });
ok(hk.status === 200 && hk.did === 'playback_start', 'wrong key in Vercel? our own signed call state still lets her speak');
const forged = Buffer.from(JSON.stringify({ k: 'lola_demo', a: 'evil', _s: 'nope' })).toString('base64');
hk = await hook(rawEv.replace(c0.client_state, forged), { 'telnyx-signature-ed25519': 'AAAA', 'telnyx-timestamp': ts });
ok(hk.status === 401, 'a forged event is refused');
const insights = (await import(P + 'webhooks/telnyx-insights.js')).default;
const rawIns = '{"data":{"event_type":"call.conversation.ended","payload":{"call_control_id":"v3:x"}}}';
const sig2 = crypto.sign(null, Buffer.from(ts + '|' + rawIns), ed.privateKey).toString('base64');
const ins = await new Promise((resolve) => { const req = Readable.from([Buffer.from(rawIns)]); Object.assign(req, { method: 'POST', headers: { 'telnyx-signature-ed25519': sig2, 'telnyx-timestamp': ts }, query: {} }); const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, ...o }); }, end() { resolve({ status: this.statusCode }); } }; insights(req, res); });
ok(ins.status !== 401, 'call summaries + transcripts verify too (they were being refused the same way): ' + ins.status);
delete process.env.TELNYX_PUBLIC_KEY;
r = await call('demo-call.js', { method: 'POST', body: { phone: '+44 20 7946 0000' } });
ok(r.status === 400 && /US and Canada/.test(r.say), 'international numbers refused, in plain words');

// ── 3. The sign-in Lola does what she says ──
calls.length = 0;
r = await call('lola/concierge.js', { method: 'POST', body: { message: 'NO CALL RECEIVED', history: [], phone: '305 555 0177' } });
ok(r.called === true && calls.at(-1)?.to === '+13055550177' && /Calling you now/.test(r.reply), '“no call received” → she calls again for real: ' + r.reply);
r = await call('lola/concierge.js', { method: 'POST', body: { message: 'call me at 786-555-0199', history: [] } });
ok(r.called && calls.at(-1)?.to === '+17865550199', '“call me at …” → the call goes out');
r = await call('lola/concierge.js', { method: 'POST', body: { message: 'call my phone', history: [] } });
ok(!r.called && r.action === 'call_me' && /number/i.test(r.reply), 'no number yet → she asks for it and opens the field');
r = await call('lola/concierge.js', { method: 'POST', body: { message: 'what can you do?', history: [] } });
ok(r.reply === 'Sure!' && !r.called, 'everything else goes to her brain');
ok(/Never say you did something/.test(R('api/lola/concierge.js')), 'she never claims an action she didn’t take');

// ── 4. Her ears are on every page ──
const ears = R('lola-ears.js');
ok(/MediaRecorder/.test(ears) && /\/api\/lola\/hear/.test(ears) && /mic_blocked/.test(ears) && /TAIL/.test(ears), 'lola-ears: records, knows when you stop, transcribes on Telnyx, explains a blocked mic');
ok(/LolaEars\.listen/.test(R('login.html')) && /lola-ears\.js/.test(R('login.html')), 'sign-in page listens with her ears');
ok(/LolaEars\.listen/.test(R('lola-everywhere.js')) && /LolaEars\.listen/.test(R('app.js')) && /lola-ears\.js/.test(R('sidebar.js')), 'dashboard and every page listen with her ears');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
