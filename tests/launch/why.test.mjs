// When Telnyx refuses Lola's settings update, LolaDesk sends each part alone (so the empty-value cleanup
// still lands), names the part Telnyx refused, and the public check shows that reason in plain words.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'tk';
const BRAIN = 'assistant-57f2d23e-48b1-4107-9811-c40b296f15b6';
process.env.TELNYX_LOLA_BRAIN_ID = BRAIN; process.env.APP_URL = 'https://www.loladesk.com';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const a = { id: BRAIN, name: 'LolaBrain', greeting: '{{lola_greeting}}', instructions: 'You are Lola.', tools: [],
  dynamic_variables: { company_name: null, booking_url: null, hours: null, lola_greeting: 'Hi, this call may be recorded. I’m Lola, an AI assistant.' },
  dynamic_variables_webhook_url: 'https://www.loladesk.com/api/agent-variables', dynamic_variables_webhook_timeout_ms: 3000,
  telephony_settings: { default_texml_app_id: 'app-1', supports_unauthenticated_web_calls: true } };
const posts = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('/ai/assistants/' + BRAIN)) {
    if (init.method === 'POST' || init.method === 'PATCH') {
      const b = JSON.parse(init.body); posts.push(Object.keys(b).sort().join(','));
      if ('instructions' in b) return J({ errors: [{ title: 'Invalid', detail: 'instructions exceeds the maximum length' }] }, 422);
      Object.assign(a, b); return J({ data: a });
    }
    return J({ data: a });
  }
  if (u.includes('/ai/assistants')) return J({ data: [{ id: BRAIN, name: 'LolaBrain' }] });
  return J({ data: [] });
};
await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
const { wireAssistant } = await import(P + 'lib/assistant-wiring.js');
const w = await wireAssistant({ heal: true });
ok(a.dynamic_variables.company_name === 'our salon' && a.dynamic_variables.booking_url !== null && a.dynamic_variables.hours !== null, 'the empty values are cleaned even though Telnyx refused another part: ' + JSON.stringify(a.dynamic_variables));
ok(/instructions: .*maximum length/.test(String(w.error)), 'the refused part is named with Telnyx’s own words: ' + w.error);

const { publicStatus } = await import(P + 'status.js');
const pub = publicStatus({ ok: false, live: { wiring_error: 'Telnyx refused instructions: too long for ' + BRAIN + ' (+13055550100)', elevenlabs: 'out_of_credit', database: true }, fixes: [] });
ok(/instructions: too long/.test(pub.live.wiring_error) && !pub.live.wiring_error.includes('57f2d23e') && !/3055550100/.test(pub.live.wiring_error) && pub.live.elevenlabs === 'out_of_credit', 'the public check shows why (ids and numbers hidden): ' + pub.live.wiring_error);
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
