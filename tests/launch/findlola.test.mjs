// "Telnyx can't find the assistant in TELNYX_LOLA_BRAIN_ID": LolaDesk finds Lola on the account itself,
process.env.LOLA_PHONE_MODE = 'assistant'; // these checks cover the Telnyx-assistant line (LolaDesk’s own line: phoneline.test)
// rewires her, points the salon numbers at her, answers every inbound call — and says what to set.
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'tk';
process.env.TELNYX_LOLA_BRAIN_ID = ' assistant-OLD-deleted\n'; process.env.CRON_SECRET = 'x'; process.env.ADMIN_EMAILS = 'a@b.c'; process.env.INTEGRATION_ENCRYPTION_KEY = 'k';
delete process.env.ELEVENLABS_API_KEY; delete process.env.TELNYX_VOICE_APP_ID; process.env.VOICE_PROVIDER = 'telnyx';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const assistants = [
  { id: 'assistant-care', name: 'LolaDesk Support', telephony_settings: { default_texml_app_id: 'app-care' }, updated_at: '2026-10-02' },
  { id: 'assistant-lola2', name: 'Lola', greeting: '', instructions: 'x', tools: [], telephony_settings: { default_texml_app_id: 'app-lola' }, updated_at: '2026-09-01' },
  { id: 'assistant-test', name: 'test bot', telephony_settings: {}, updated_at: '2026-10-01' },
];
const phone = [{ id: 'n1', phone_number: '+13055550100', connection_id: 'old-dead-app' }];
const updates = [], patches = [], starts = [], answers = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  const am = u.match(/\/ai\/assistants\/([^/?]+)/);
  if (am) { const a = assistants.find((x) => x.id === decodeURIComponent(am[1])); if (!a) return J({ errors: [{ detail: 'Resource not found' }] }, 404); if (init.method === 'POST' || init.method === 'PATCH') { const b = JSON.parse(init.body); updates.push({ id: a.id, ...b }); Object.assign(a, b); } return J({ data: a }); }
  if (u.includes('/ai/assistants')) return J({ data: assistants });
  if (/\/phone_numbers\/n\d$/.test(u) && init.method === 'PATCH') { const b = JSON.parse(init.body); patches.push(b.connection_id); phone[0].connection_id = b.connection_id; return J({ data: phone[0] }); }
  if (u.includes('/phone_numbers')) return J({ data: phone });
  if (/\/calls\/[^/]+\/actions\/ai_assistant_start/.test(u)) { starts.push(JSON.parse(init.body).assistant?.id); return J({ data: {} }); }
  if (/\/calls\/[^/]+\/actions\/answer/.test(u)) { answers.push(u); return J({ data: {} }); }
  if (u.includes('/text-to-speech/speech')) return new Response(new Uint8Array(3000), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  if (u.endsWith('/balance')) return J({ data: { balance: '9', available_credit: '9' } });
  if (u.includes('/chat/completions')) return J({ choices: [{ message: { role: 'assistant', content: 'ready' } }] });
  if (u.includes('/ai/audio/transcriptions')) return J({ text: '' });
  if (/\/ai\/(openai\/)?models/.test(u)) return J({ data: [{ id: 'meta-llama/Llama-3.3-70B-Instruct' }] });
  if (u.includes('/10dlc/phone_number_campaigns')) return J({ records: phone.map((p) => ({ phoneNumber: p.phone_number })) });
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
T.tenants = [{ id: 't1', slug: 'mma', name: 'MMA Salon', phone_number: '+13055550100', telnyx_assistant_id: null }];
T.tenant_numbers = [{ tenant_id: 't1', phone_number: '+13055550100', status: 'active' }]; T.calls = [];
const P = new URL('../../api/', import.meta.url).href;
const W = await import(P + 'lib/assistant-wiring.js');

let r = await W.resolveAssistant();
ok(r.ok && r.id === 'assistant-lola2' && r.source === 'discovered', 'the Vercel id is dead → Lola is found by name (never the support line, never a test bot)');
ok(W.assistantId() === 'assistant-lola2', 'and every path that asks “which assistant?” now gets her');
W._resetAssistantCache(); process.env.TELNYX_LOLA_BRAIN_ID = 'lola2';
r = await W.resolveAssistant();
ok(r.id === 'assistant-lola2' && r.source === 'env_fixed', 'an id pasted without “assistant-” is corrected');
W._resetAssistantCache(); process.env.TELNYX_LOLA_BRAIN_ID = ' assistant-OLD-deleted\n';

const { buildStatus } = await import(P + 'status.js');
const s = await buildStatus();
ok(s.live.assistant === true && !s.fixes.some((f) => /can’t find the assistant|TELNYX_LOLA_BRAIN_ID/.test(f)), 'status no longer sends you hunting for an id');
ok(s.healed.some((h) => /found on your Telnyx account: “Lola” \(assistant-lola2\)/.test(h) && /TELNYX_LOLA_BRAIN_ID = assistant-lola2/.test(h)), 'it says which one it uses and the exact value to set: ' + s.healed[0]);
ok(patches.includes('app-lola') && s.live.salon_numbers_ringing_lola === 1, 'the salon number pointed at a dead app now rings Lola');
ok(updates.some((u) => u.id === 'assistant-lola2' && u.dynamic_variables_webhook_url && u.greeting === '{{lola_greeting}}'), 'her greeting and live salon details are wired');

// An inbound call to a salon with no assistant of its own is answered by Lola (was: left ringing in silence).
const ed = crypto.generateKeyPairSync('ed25519');
process.env.TELNYX_PUBLIC_KEY = ed.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const hook = (await import(P + 'telnyx-webhook.js')).default;
const raw = JSON.stringify({ data: { event_type: 'call.initiated', payload: { call_control_id: 'v3:in-1', from: '+13055559999', to: '+13055550100', direction: 'incoming' } } });
const ts = String(Math.floor(Date.now() / 1000));
const sig = crypto.sign(null, Buffer.from(ts + '|' + raw), ed.privateKey).toString('base64');
await new Promise((resolve) => { const req = Readable.from([Buffer.from(raw)]); Object.assign(req, { method: 'POST', headers: { 'telnyx-signature-ed25519': sig, 'telnyx-timestamp': ts }, query: {} }); const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(o) { resolve(o); }, end() { resolve(); }, send() { resolve(); } }; hook(req, res); });
ok(starts.includes('assistant-lola2') && answers.some((u) => u.includes('in-1')), 'an incoming call is answered (answer, then ai_assistant_start {assistant:{id}}) by Lola even when the salon has no assistant of its own');

// No assistant at all on the account → one plain instruction.
assistants.length = 0; W._resetAssistantCache();
const s2 = await (await import(P + 'status.js?none')).buildStatus();
ok(s2.fixes.some((f) => /no AI assistant on your Telnyx account/.test(f)), 'no assistant anywhere → “create one named Lola”');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
