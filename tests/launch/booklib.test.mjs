// When book_appointment lives in the Telnyx Tools Library (shared), its copy there is given the booking
// details too (first + last name, mobile, email) — the live check's "asks name, mobile and email" then passes.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'tk';
const BRAIN = 'assistant-22222222-2222-4333-8444-555555555555';
process.env.TELNYX_LOLA_BRAIN_ID = BRAIN; process.env.APP_URL = 'https://www.loladesk.com';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const { toolUrl } = await import(new URL('../../api/lib/assistant-wiring.js', import.meta.url).href);
const lib = { id: 'tool-book', type: 'webhook', tool_definition: { type: 'webhook', webhook: { name: 'book_appointment', description: 'Book it', url: toolUrl('book_appointment'), method: 'POST', body_parameters: { type: 'object', properties: { service: { type: 'string' }, date: { type: 'string' }, time: { type: 'string' } } } } } };
const asst = { id: BRAIN, name: 'LolaBrain', greeting: '{{lola_greeting}}', instructions: 'You are Lola.', dynamic_variables: { lola_greeting: 'Hi, this call may be recorded. I’m Lola, an AI assistant.' },
  telephony_settings: { default_texml_app_id: 'app-1', supports_unauthenticated_web_calls: true }, tool_ids: ['tool-book'] };
const patches = [], saves = [], detaches = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (init.method === 'DELETE') { detaches.push(u); return J({ errors: [{ detail: 'not found' }] }, 404); }   // no documented detach call
  if (/\/ai\/tools\/tool-book/.test(u) && init.method === 'PATCH') { const b = JSON.parse(init.body); patches.push(b); lib.tool_definition = { type: 'webhook', webhook: b.webhook }; return J({ data: lib }); }
  if (/\/ai\/tools\/tool-book/.test(u)) return J({ data: lib });
  if (/\/ai\/tools(\?|$)/.test(u)) return J({ data: [lib] });
  if (u.endsWith('/ai/openai/models')) return J({ data: [{ id: 'zai-org/GLM-5.3-Flash' }] });
  if (u.includes('/ai/assistants/' + BRAIN)) {
    if (init.method === 'POST' || init.method === 'PATCH') { const b = JSON.parse(init.body); saves.push(b);
      const ids = Array.isArray(b.tool_ids) ? b.tool_ids : (asst.tool_ids || []);   // docs: tool_ids replaces
      if ((b.tools || asst._inline || []).some((t) => t.webhook?.name === 'book_appointment') && ids.includes('tool-book')) return J({ errors: [{ detail: 'Webhook tools names must be unique, the following are not unique: book_appointment' }] }, 422); if (b.tools) asst._inline = b.tools; const { tools, ...rest } = b; Object.assign(asst, rest); }
    return J({ data: { ...asst, tools: [...(asst._inline || []), ...((asst.tool_ids || []).includes('tool-book') ? [{ ...lib.tool_definition, shared: true }] : [])] } });
  }
  if (u.includes('/ai/assistants')) return J({ data: [{ id: BRAIN, name: 'LolaBrain' }] });
  return J({});
};
await import('./fake-supabase.mjs');
const { wireAssistant } = await import(new URL('../../api/lib/assistant-wiring.js', import.meta.url).href);
const w = await wireAssistant({ heal: true });
const own = saves.flatMap((b) => b.tools || []).find((t) => t.webhook?.name === 'book_appointment');
const props = own?.webhook?.body_parameters?.properties || {};
ok(own && props.client_name && props.client_phone && props.client_email && props.service, 'Lola takes her own book_appointment that asks for name, mobile and email (editing the Library copy doesn’t stick)');
ok(own?.webhook?.url === toolUrl('book_appointment'), 'signed, pointing at LolaDesk');
ok(!(asst.tool_ids || []).includes('tool-book') && saves.some((b) => Array.isArray(b.tool_ids) && !b.tool_ids.includes('tool-book')) && !detaches.length, 'the Library copy is detached the documented way — tool_ids sent without it (never deleted; it stays in Telnyx → Tools)');
ok(w.booking?.asks_full_details !== false, 'the check reads it as fixed');
const n = saves.length; const w2 = await wireAssistant({ heal: true });
ok(w2.booking?.asks_full_details === true && !saves.slice(n).some((b) => b.tools), 'next check: already right — nothing to fix, it stays fixed');
console.log(fails ? `\n${fails} FAILED` : '\nall booklib checks pass');
process.exit(fails ? 1 : 0);
