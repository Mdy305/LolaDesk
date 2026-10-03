// Telnyx refuses ANY assistant update while a stored default is null ("Value for key 'booking_url'
// must be a boolean, string, or integer") — LolaDesk cleans those values and gets her changes through.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.TELNYX_LOLA_BRAIN_ID = 'assistant-dv1'; process.env.APP_URL = 'https://www.loladesk.com';
let assistant = { id: 'assistant-dv1', name: 'Lola', greeting: '{{lola_greeting}}', dynamic_variables_webhook_url: 'https://www.loladesk.com/api/agent-variables',
  dynamic_variables: { booking_url: null, lola_greeting: 'Hi, this is Lola, a virtual assistant. This call may be recorded.', price: 12.5, extra: { a: 1 } }, tools: [] };
const sent = []; let refuseTelephony = false;
const bad = (dv) => Object.values(dv || {}).some((v) => v == null || typeof v === 'object' || (typeof v === 'number' && !Number.isInteger(v)));
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('/ai/assistants/assistant-dv1')) {
    if (init.method === 'PATCH' || init.method === 'POST') {
      const b = JSON.parse(init.body); sent.push(b);
      if (refuseTelephony && b.telephony_settings) return J({ errors: [{ detail: 'telephony_settings: unknown field' }] }, 422);
      const names = (merged0) => (merged0.tools || []).map((t) => t?.webhook?.name).filter(Boolean);
      const m0 = { ...assistant, ...b }; const nm = names(m0);
      if (new Set(nm).size !== nm.length) return J({ errors: [{ detail: 'Webhook tools names must be unique, the following are not unique: ' + [...new Set(nm.filter((x, i) => nm.indexOf(x) !== i))].join(', ') }] }, 422);
      const merged = { ...assistant, ...b };
      if (bad(merged.dynamic_variables)) return J({ errors: [{ detail: '"Aiassistantdynamicvariables": Value for key \'booking_url\' must be a boolean, string, or integer' }] }, 422);
      assistant = merged; return J({ data: assistant });
    }
    return J({ data: assistant });
  }
  return J({ data: [] });
};
await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const { wireAssistant, updateAssistant } = await import(P + 'lib/assistant-wiring.js');

let r = await wireAssistant({ heal: false });
ok(!r.dynamic_variables.ok && r.dynamic_variables.fixed_values.includes('booking_url'), 'finds the empty booking_url that blocks Telnyx');
r = await wireAssistant({ heal: true });
ok(!r.error && assistant.dynamic_variables.booking_url === '' && assistant.dynamic_variables.price === '12.5' && typeof assistant.dynamic_variables.extra === 'string', 'stored values cleaned: null → "", 12.5 → "12.5", object → text');
ok(/virtual assistant/.test(assistant.dynamic_variables.lola_greeting), 'her greeting is kept');

// A voice-only change on an assistant still holding a null default goes through (one retry).
assistant.dynamic_variables = { booking_url: null, lola_greeting: 'Hi' };
sent.length = 0;
await updateAssistant('assistant-dv1', { voice_settings: { voice: 'ElevenLabs.eleven_multilingual_v2.v1', api_key_ref: 's' } });
ok(assistant.voice_settings?.voice?.endsWith('.v1') && assistant.dynamic_variables.booking_url === '' && sent.length === 2, 'a voice switch blocked by booking_url:null is retried with clean values and lands');
// Values LolaDesk sends itself are always clean.
sent.length = 0;
await updateAssistant('assistant-dv1', { dynamic_variables: { booking_url: null, n: 3 } });
ok(sent[0].dynamic_variables.booking_url === '' && sent[0].dynamic_variables.n === 3, 'outgoing values are made Telnyx-safe before sending');

// An optional setting Telnyx refuses (website-call flag) never blocks the essentials (signed tools, salon details).
assistant = { ...assistant, tools: [{ type: 'webhook', webhook: { name: 'book_appointment', url: 'https://www.loladesk.com/api/lola-tools?tool=book_appointment', method: 'POST' } }], dynamic_variables_webhook_url: 'https://www.loladesk.com/api/agent-variables', telephony_settings: { default_texml_app_id: 'app-9' } };
refuseTelephony = true; sent.length = 0;
r = await wireAssistant({ heal: true });
ok(/&k=[\w-]{24}$/.test(assistant.tools[0].webhook.url) && /agent-variables\?k=/.test(assistant.dynamic_variables_webhook_url), 'tools + salon details are signed even when Telnyx refuses an optional setting');
ok(assistant.telephony_settings.default_texml_app_id === 'app-9' && r.web_calls === false && /unknown field/.test(r.web_calls_error || ''), 'the number routing is kept and the refusal is reported, not hidden');
// Duplicate tool names (Telnyx: "Webhook tools names must be unique") + empty defaults, together — the live case.
refuseTelephony = false;
const dupTool = (u) => ({ type: 'webhook', webhook: { name: 'handle_recovery', url: u, method: 'POST' } });
assistant = { ...assistant, dynamic_variables: { company_name: null, hours: null, lola_greeting: 'Hi, this is Lola, a virtual assistant. This call may be recorded.' },
  tools: [dupTool('https://old.example.com/x'), dupTool('https://www.loladesk.com/api/lola-tools?tool=handle_recovery'), { type: 'webhook', webhook: { name: 'escalate', url: 'https://www.loladesk.com/api/lola-tools?tool=escalate' } }, { type: 'webhook', webhook: { name: 'escalate', url: 'https://www.loladesk.com/api/lola-tools?tool=escalate' } }, { type: 'hangup', hangup: {} }] };
r = await wireAssistant({ heal: true });
const tn = assistant.tools.map((t) => t?.webhook?.name).filter(Boolean);
ok(!r.error && new Set(tn).size === tn.length && r.duplicate_tools.length === 2, 'duplicate tools removed so Telnyx accepts the update: ' + JSON.stringify(r.duplicate_tools));
ok(assistant.tools.find((t) => t?.webhook?.name === 'handle_recovery').webhook.url.includes('loladesk.com/api/lola-tools') && assistant.tools.some((t) => t.type === 'hangup'), 'the copy wired to LolaDesk is the one kept; unnamed tools (hangup) stay');
ok(assistant.dynamic_variables.company_name === 'our salon' && assistant.dynamic_variables.hours === '', 'and the empty defaults are cleaned in the same update (company name → “our salon”)');
// A plain voice change on an assistant still stuck with duplicates gets through on the retry.
assistant.tools = [dupTool('https://a.example.com'), dupTool('https://www.loladesk.com/api/lola-tools?tool=handle_recovery')];
sent.length = 0;
await updateAssistant('assistant-dv1', { voice_settings: { voice: 'ElevenLabs.eleven_multilingual_v2.v2', api_key_ref: 's' } });
ok(assistant.voice_settings.voice.endsWith('.v2') && assistant.tools.length === 1, 'a voice switch blocked by duplicate tools is retried with them deduped and lands');
console.log(fails ? `\n${fails} FAILED` : '\nall dynvars checks passed');
process.exit(fails ? 1 : 0);
