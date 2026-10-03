// Telnyx refuses ANY assistant update while a stored default is null ("Value for key 'booking_url'
// must be a boolean, string, or integer") — LolaDesk cleans those values and gets her changes through.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.TELNYX_LOLA_BRAIN_ID = 'assistant-dv1'; process.env.APP_URL = 'https://www.loladesk.com';
let assistant = { id: 'assistant-dv1', name: 'Lola', greeting: '{{lola_greeting}}', dynamic_variables_webhook_url: 'https://www.loladesk.com/api/agent-variables',
  dynamic_variables: { booking_url: null, lola_greeting: 'Hi, this is Lola, a virtual assistant. This call may be recorded.', price: 12.5, extra: { a: 1 } }, tools: [] };
const sent = [];
const bad = (dv) => Object.values(dv || {}).some((v) => v == null || typeof v === 'object' || (typeof v === 'number' && !Number.isInteger(v)));
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('/ai/assistants/assistant-dv1')) {
    if (init.method === 'PATCH' || init.method === 'POST') {
      const b = JSON.parse(init.body); sent.push(b);
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

console.log(fails ? `\n${fails} FAILED` : '\nall dynvars checks passed');
process.exit(fails ? 1 : 0);
