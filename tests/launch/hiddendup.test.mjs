// Telnyx's documented contract (OpenAPI, Oct 2026): GET /ai/assistants/{id} merges Tools-Library (shared)
// tools into `tools` with shared:true; an update's `tools` array fully REPLACES the inline tools and must
// leave the shared ones out — sending them back is "Webhook tools names must be unique". LolaDesk now:
// never sends a shared tool inline, re-signs shared copies of her skills in the Library (PATCH /ai/tools),
// keeps every core skill (an assistant that lost them gets them back), and never empties her tools.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'tk';
const BRAIN = 'assistant-57f2d23e-48b1-4107-9811-c40b296f15b6';
process.env.TELNYX_LOLA_BRAIN_ID = BRAIN; process.env.APP_URL = 'https://www.loladesk.com';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const wh = (name, k = 'stale') => ({ type: 'webhook', webhook: { name, description: name, url: `https://www.loladesk.com/api/lola-tools?tool=${name}&to={{telnyx_agent_target}}&from={{telnyx_end_user_target}}&salon={{loladesk_salon}}&call={{call_control_id}}&ch={{telnyx_conversation_channel}}&k=${k}`, method: 'POST' } });
// The Library: three of Lola's skills live there (stale signature), attached to LolaBrain.
const LIB = new Map(['detect_upsell_opportunity', 'handle_recovery', 'escalate'].map((n, i) => [n, { id: 'tool-' + i, type: 'webhook', display_name: n, tool_definition: wh(n) }]));
const inline = ['recommend_service', 'book_appointment', 'check_availability', 'get_pricing', 'take-message'].map((n) => wh(n));
const a = { id: BRAIN, name: 'LolaBrain', greeting: '{{lola_greeting}}', instructions: 'You are Lola.', mcp_servers: [], mcp_message: null,
  dynamic_variables: { lola_greeting: 'Hi, this call may be recorded. I’m Lola, an AI assistant.' },
  dynamic_variables_webhook_url: 'https://www.loladesk.com/api/agent-variables', dynamic_variables_webhook_timeout_ms: 3000,
  telephony_settings: { default_texml_app_id: 'app-1', supports_unauthenticated_web_calls: true } };
const view = () => ({ ...a, tools: [...inline.map((t) => ({ ...t, shared: false })), ...[...LIB.values()].map((t) => ({ ...t.tool_definition, shared: true }))] });
let patched = [], refused = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  const lt = u.match(/\/ai\/tools\/([^/?]+)/);
  if (lt && init.method === 'PATCH') { const b = JSON.parse(init.body); const hit = [...LIB.values()].find((x) => x.id === lt[1]); hit.tool_definition = { type: 'webhook', webhook: b.webhook }; patched.push(b.webhook.name); return J({ data: hit }); }
  if (/\/ai\/tools(\?|$)/.test(u)) return J({ data: [...LIB.values()] });
  if (u.includes('/ai/assistants/' + BRAIN)) {
    if (init.method === 'POST' || init.method === 'PATCH') {
      const b = JSON.parse(init.body);
      if ('tools' in b) {
        if (b.tools.some((t) => 'shared' in t)) return J({ errors: [{ detail: 'shared is read-only' }] }, 422);
        const names = [...b.tools.map((t) => t.webhook?.name), ...LIB.keys()].map((n) => String(n).replace(/-/g, '_'));
        const dup = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
        if (dup.length) { refused++; return J({ errors: [{ detail: 'Webhook tools names must be unique, the following are not unique: ' + dup.join(', ') }] }, 422); }
        inline.splice(0, inline.length, ...b.tools);   // fully replaces the inline tools
      }
      const { tools, ...rest } = b; Object.assign(a, rest);
      return J({ data: view() });
    }
    return J({ data: view() });
  }
  if (u.includes('/ai/assistants')) return J({ data: [{ id: BRAIN, name: 'LolaBrain' }] });
  return J({ data: [] });
};
await import('./fake-supabase.mjs');
const { wireAssistant } = await import(new URL('../../api/lib/assistant-wiring.js', import.meta.url).href);
const { toolKeyOk } = await import(new URL('../../api/lib/tool-key.js', import.meta.url).href);
const w = await wireAssistant({ heal: true });
const all = view().tools, names = all.map((t) => String(t.webhook?.name).replace(/-/g, '_'));
ok(!w.error && refused === 0, 'Telnyx accepts the save the first time (no "not unique"): ' + (w.error || 'saved'));
ok(!inline.some((t) => LIB.has(t.webhook?.name)), 'the shared tools are never sent back inline');
ok(['detect_upsell_opportunity', 'handle_recovery', 'escalate'].every((n) => patched.includes(n)) && [...LIB.values()].every((x) => toolKeyOk(new URL(x.tool_definition.webhook.url.replace(/\{\{[^}]*\}\}/g, 'x')).searchParams.get('k'))), 'the shared copies are re-signed where they live (the Tools Library)');
ok(inline.filter((t) => /lola-tools/.test(t.webhook?.url)).every((t) => toolKeyOk(new URL(t.webhook.url.replace(/\{\{[^}]*\}\}/g, 'x')).searchParams.get('k'))), 'every inline tool is signed — calls can book again');
ok(['check_availability', 'book_appointment', 'reschedule_appointment', 'get_pricing', 'take_message', 'list_services', 'confirm_booking', 'cancel_appointment', 'capture_lead', 'recall_client', 'waitlist_add', 'rebook_next_visit'].every((n) => names.includes(n)) && new Set(names).size === names.length, 'she has every core skill, each exactly once: ' + names.join(', '));
// An assistant that lost its inline tools gets the core skills back (never left empty)
inline.splice(0, inline.length);
const w2 = await wireAssistant({ heal: true });
const n2 = view().tools.map((t) => String(t.webhook?.name).replace(/-/g, '_'));
ok(!w2.error && ['check_availability', 'book_appointment', 'get_pricing'].every((n) => n2.includes(n)), 'tools wiped → the booking skills come back on the next check');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
