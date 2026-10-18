// When book_appointment lives in the Telnyx Tools Library (shared), its copy there is given the booking
// details too (first + last name, mobile, email) — the live check's "asks name, mobile and email" then passes.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'tk';
const BRAIN = 'assistant-22222222-2222-4333-8444-555555555555';
process.env.TELNYX_LOLA_BRAIN_ID = BRAIN; process.env.APP_URL = 'https://www.loladesk.com';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const { toolUrl } = await import(new URL('../../api/lib/assistant-wiring.js', import.meta.url).href);
const lib = { id: 'tool-book', type: 'webhook', tool_definition: { type: 'webhook', webhook: { name: 'book_appointment', description: 'Book it', url: toolUrl('book_appointment'), method: 'POST', body_parameters: { type: 'object', properties: { service: { type: 'string' }, date: { type: 'string' }, time: { type: 'string' } } } } } };
const asst = { id: BRAIN, name: 'LolaBrain', greeting: '{{lola_greeting}}', instructions: 'You are Lola.', dynamic_variables: { lola_greeting: 'Hi, this call may be recorded. I’m Lola, an AI assistant.' },
  telephony_settings: { default_texml_app_id: 'app-1', supports_unauthenticated_web_calls: true } };
const patches = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (/\/ai\/tools\/tool-book/.test(u) && init.method === 'PATCH') { const b = JSON.parse(init.body); patches.push(b); lib.tool_definition = { type: 'webhook', webhook: b.webhook }; return J({ data: lib }); }
  if (/\/ai\/tools(\?|$)/.test(u)) return J({ data: [lib] });
  if (u.endsWith('/ai/openai/models')) return J({ data: [{ id: 'zai-org/GLM-5.3-Flash' }] });
  if (u.includes('/ai/assistants/' + BRAIN)) {
    if (init.method === 'POST' || init.method === 'PATCH') { const b = JSON.parse(init.body); const { tools, ...rest } = b; Object.assign(asst, rest); }
    return J({ data: { ...asst, tools: [{ ...lib.tool_definition, shared: true }] } });
  }
  if (u.includes('/ai/assistants')) return J({ data: [{ id: BRAIN, name: 'LolaBrain' }] });
  return J({});
};
await import('./fake-supabase.mjs');
const { wireAssistant } = await import(new URL('../../api/lib/assistant-wiring.js', import.meta.url).href);
const w = await wireAssistant({ heal: true });
const props = patches[0]?.webhook?.body_parameters?.properties || {};
ok(patches.length === 1 && props.client_name && props.client_phone && props.client_email && props.service, 'the Library copy of book_appointment now asks for name, mobile and email (and keeps its own fields)');
ok(patches[0]?.webhook?.url === toolUrl('book_appointment'), 'its signed URL is kept');
ok(w.booking?.asks_full_details !== false, 'the check reads it as fixed');
const again = patches.length; await wireAssistant({ heal: true });
ok(patches.length === again, 'once fixed, it is left alone');
console.log(fails ? `\n${fails} FAILED` : '\nall booklib checks pass');
process.exit(fails ? 1 : 0);
