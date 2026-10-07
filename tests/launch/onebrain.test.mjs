// One brain: LolaBrain answers every salon's calls by default, a salon's old per-salon assistant is never
// preferred over her, and a call app whose Voice URL was typed over ("LolaBrain") is repaired.
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'tk';
const BRAIN = 'assistant-57f2d23e-48b1-4107-9811-c40b296f15b6', OLD = 'assistant-dd5ea175-9bce-4fa3-8b80-572c47dc4277';
process.env.TELNYX_LOLA_BRAIN_ID = BRAIN; delete process.env.LOLA_PHONE_MODE; process.env.CRON_SECRET = 'x';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const apps = {
  'app-brain': { id: 'app-brain', friendly_name: 'ai-assistant-57f2d23e-48b1-4107-9811-c40b296f15b6', voice_url: 'LolaBrain', voice_method: 'post' },
  'app-old': { id: 'app-old', friendly_name: 'ai-assistant-dd5ea175-9bce-4fa3-8b80-572c47dc4277', voice_url: 'https://api.telnyx.com/v2/ai/assistants/assistant-dd5ea175-9bce-4fa3-8b80-572c47dc4277/texml', voice_method: 'post' },
};
const starts = [], patches = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  const tm = u.match(/\/texml_applications\/([^/?]+)/);
  if (tm) { const a = apps[decodeURIComponent(tm[1])]; if (init.method === 'PATCH') { const b = JSON.parse(init.body); patches.push(b); Object.assign(a, b); } return J({ data: a }); }
  if (u.includes('/texml_applications')) return J({ data: Object.values(apps) });
  if (u.includes('/ai/assistants/' + BRAIN)) return J({ data: { id: BRAIN, name: 'LolaBrain', greeting: '{{lola_greeting}}', tools: [], telephony_settings: { default_texml_app_id: 'app-brain', supports_unauthenticated_web_calls: true } } });
  if (u.includes('/ai/assistants')) return J({ data: [{ id: BRAIN, name: 'LolaBrain' }, { id: OLD, name: 'Lola — MMA Salon' }] });
  if (/\/calls\/[^/]+\/actions\/ai_assistant_start/.test(u)) { starts.push(JSON.parse(init.body).assistant?.id); return J({ data: {} }); }
  if (u.endsWith('/balance')) return J({ data: { balance: '9', available_credit: '9' } });
  if (u.includes('/chat/completions')) return J({ choices: [{ message: { role: 'assistant', content: 'ready' } }] });
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
T.tenants = [{ id: 't1', slug: 'mma', name: 'MMA Salon', phone_number: '+13055550100', telnyx_assistant_id: OLD }];
T.tenant_numbers = [{ tenant_id: 't1', phone_number: '+13055550100', status: 'active' }]; T.calls = []; T.platform_settings = [];
const P = new URL('../../api/', import.meta.url).href;

const pv = await import(P + 'lib/telnyx-provision.js');
ok(await pv.phoneMode() === 'assistant', 'by default LolaBrain answers every salon’s calls');

const { buildStatus } = await import(P + 'status.js');
const s = await buildStatus();
ok(patches.some((p) => p.voice_url === 'https://api.telnyx.com/v2/ai/assistants/' + BRAIN + '/texml') && s.live.lolabrain_call_app === true, 'LolaBrain’s call app (Voice URL typed over as “LolaBrain”) is pointed back at LolaBrain: ' + s.healed.join(' | '));

// An inbound call to a salon that still has an old per-salon assistant: LolaBrain answers.
const ed = crypto.generateKeyPairSync('ed25519');
process.env.TELNYX_PUBLIC_KEY = ed.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const hook = (await import(P + 'telnyx-webhook.js')).default;
const raw = JSON.stringify({ data: { id: 'ev1', event_type: 'call.initiated', payload: { call_control_id: 'v3:in-9', from: '+13055559999', to: '+13055550100', direction: 'incoming' } } });
const ts = String(Math.floor(Date.now() / 1000));
const sig = crypto.sign(null, Buffer.from(ts + '|' + raw), ed.privateKey).toString('base64');
await new Promise((resolve) => { const req = Readable.from([Buffer.from(raw)]); Object.assign(req, { method: 'POST', headers: { 'telnyx-signature-ed25519': sig, 'telnyx-timestamp': ts }, query: {} }); const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(o) { resolve(o); }, end() { resolve(); }, send() { resolve(); } }; hook(req, res); });
ok(starts.length === 1 && starts[0] === BRAIN, 'the call is answered by LolaBrain — never the salon’s old assistant');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
