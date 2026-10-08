// Lola's Telnyx assistant: the core tools are added when missing, and a shared copy of one of her tools
// (Telnyx: "names must be unique") is detached — never deleted — even when its name can't be read.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'tk';
const BRAIN = 'assistant-57f2d23e-48b1-4107-9811-c40b296f15b6';
process.env.TELNYX_LOLA_BRAIN_ID = BRAIN; process.env.APP_URL = 'https://www.loladesk.com';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const wh = (name) => ({ type: 'webhook', webhook: { name, description: name, url: 'https://www.loladesk.com/api/lola-tools?tool=' + name, method: 'POST' } });
const a = { id: BRAIN, name: 'LolaBrain', greeting: '{{lola_greeting}}', instructions: '', tools: ['detect_upsell_opportunity', 'handle_recovery', 'escalate', 'book_appointment', 'check_availability'].map(wh),
  tool_ids: ['shared-1', 'shared-2', 'keep-me'], dynamic_variables: { lola_greeting: 'Hi, this call may be recorded. I’m Lola, an AI assistant.' },
  dynamic_variables_webhook_url: 'https://www.loladesk.com/api/agent-variables', dynamic_variables_webhook_timeout_ms: 3000,
  telephony_settings: { default_texml_app_id: 'app-1', supports_unauthenticated_web_calls: true } };
let deletes = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (init.method === 'DELETE') { deletes++; return J({}); }
  if (/\/ai\/tools\/keep-me/.test(u)) return J({ data: { id: 'keep-me', type: 'transfer', display_name: 'transfer_to_salon' } });
  if (/\/ai\/tools\//.test(u)) return J({ errors: [{ detail: 'not found' }] }, 404);      // name unreadable
  if (u.includes('/ai/assistants/' + BRAIN)) {
    if (init.method === 'POST' || init.method === 'PATCH') {
      const b = JSON.parse(init.body); const ids = b.tool_ids || a.tool_ids;
      if ('tools' in b && ids.some((x) => x.startsWith('shared'))) return J({ errors: [{ detail: 'Webhook tools names must be unique, the following are not unique: detect_upsell_opportunity, handle_recovery, escalate' }] }, 422);
      Object.assign(a, b); return J({ data: a });
    }
    return J({ data: a });
  }
  if (u.includes('/ai/assistants')) return J({ data: [{ id: BRAIN, name: 'LolaBrain' }] });
  return J({ data: [] });
};
await import('./fake-supabase.mjs');
const { wireAssistant } = await import(new URL('../../api/lib/assistant-wiring.js', import.meta.url).href);
const w = await wireAssistant({ heal: true });
const names = a.tools.map((t) => t.webhook?.name);
ok(!w.error, 'Telnyx accepts the update: ' + (w.error || 'saved'));
ok(['list_services', 'confirm_booking', 'cancel_appointment', 'capture_lead', 'recall_client'].every((n) => names.includes(n)), 'Lola gets her missing front-desk tools: ' + names.join(', '));
ok(names.filter((n) => n === 'escalate').length === 1 && a.tool_ids.join() === 'keep-me' && deletes === 0, 'the duplicate shared copies are detached (kept in Telnyx), other shared tools stay: ' + a.tool_ids.join());
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
