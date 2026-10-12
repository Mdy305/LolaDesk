// Telnyx says three of Lola's tool names are "not unique" but the second copy is somewhere LolaDesk can't
// see or edit (no shared tool, no MCP server listed). Her save must still land: Telnyx keeps its copy of
// those three, every other tool + the booking rules go through, and the check says so in plain words.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'tk';
const BRAIN = 'assistant-57f2d23e-48b1-4107-9811-c40b296f15b6';
process.env.TELNYX_LOLA_BRAIN_ID = BRAIN; process.env.APP_URL = 'https://www.loladesk.com';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const HIDDEN = ['detect_upsell_opportunity', 'handle_recovery', 'escalate'];
const wh = (name) => ({ type: 'webhook', webhook: { name, description: name, url: 'https://www.loladesk.com/api/lola-tools?tool=' + name, method: 'POST' } });
const a = { id: BRAIN, name: 'LolaBrain', greeting: '{{lola_greeting}}', instructions: 'You are Lola.', tools: [...HIDDEN, 'book_appointment', 'check_availability'].map(wh), mcp_servers: [], mcp_message: null,
  dynamic_variables: { lola_greeting: 'Hi, this call may be recorded. I’m Lola, an AI assistant.' },
  dynamic_variables_webhook_url: 'https://www.loladesk.com/api/agent-variables', dynamic_variables_webhook_timeout_ms: 3000,
  telephony_settings: { default_texml_app_id: 'app-1', supports_unauthenticated_web_calls: true } };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('/ai/assistants/' + BRAIN)) {
    if (init.method === 'POST' || init.method === 'PATCH') {
      const b = JSON.parse(init.body);
      if ('tools' in b && b.tools.some((t) => HIDDEN.includes(t.webhook?.name))) return J({ errors: [{ detail: 'Webhook tools names must be unique, the following are not unique: ' + HIDDEN.join(', ') }] }, 422);
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
ok(!w.error, 'the save lands: ' + (w.error || 'saved'));
ok(['list_services', 'confirm_booking', 'cancel_appointment', 'capture_lead', 'recall_client', 'waitlist_add', 'rebook_next_visit', 'book_appointment'].every((n) => names.includes(n)), 'every other tool goes through: ' + names.join(', '));
ok(/\[LolaDesk booking\]/.test(a.instructions) && /\[LolaDesk sales\]/.test(a.instructions), 'the booking and sales rules land on her');
ok(w.dup_kept_in_telnyx.join() === HIDDEN.join(), 'the check names the three Telnyx keeps: ' + w.dup_kept_in_telnyx.join(', '));
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
