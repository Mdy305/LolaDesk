// Lola's tools vs an MCP server attached in Telnyx: when the MCP server exposes tools with her names
// (Telnyx: "names must be unique"), LolaDesk detaches only that server — never deletes it — and her tools save.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'tk';
const BRAIN = 'assistant-57f2d23e-48b1-4107-9811-c40b296f15b6';
process.env.TELNYX_LOLA_BRAIN_ID = BRAIN; process.env.APP_URL = 'https://www.loladesk.com';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const wh = (name) => ({ type: 'webhook', webhook: { name, description: name, url: 'https://www.loladesk.com/api/lola-tools?tool=' + name, method: 'POST' } });
const MCP_TOOLS = { 'mcp-dup': ['detect_upsell_opportunity', 'handle_recovery', 'escalate'], 'mcp-ok': ['weather'] };
const a = { id: BRAIN, name: 'LolaBrain', greeting: '{{lola_greeting}}', instructions: 'You are Lola.', tools: ['detect_upsell_opportunity', 'handle_recovery', 'escalate', 'book_appointment', 'check_availability'].map(wh),
  mcp_servers: [{ id: 'mcp-dup' }, { id: 'mcp-ok' }], mcp_message: null,
  dynamic_variables: { lola_greeting: 'Hi, this call may be recorded. I’m Lola, an AI assistant.' },
  dynamic_variables_webhook_url: 'https://www.loladesk.com/api/agent-variables', dynamic_variables_webhook_timeout_ms: 3000,
  telephony_settings: { default_texml_app_id: 'app-1', supports_unauthenticated_web_calls: true } };
let deletes = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (init.method === 'DELETE') { deletes++; return J({}); }
  const m = u.match(/\/ai\/mcp_servers\/([^/?]+)/); if (m) return J({ data: { id: m[1], name: m[1] === 'mcp-dup' ? 'Old Lola skills' : 'Weather', allowed_tools: MCP_TOOLS[m[1]] } });
  if (u.includes('/ai/assistants/' + BRAIN)) {
    if (init.method === 'POST' || init.method === 'PATCH') {
      const b = JSON.parse(init.body);
      if ('tools' in b) {
        const servers = b.mcp_servers || a.mcp_servers;
        const inline = new Set(b.tools.map((t) => t.webhook?.name));
        const clash = servers.flatMap((s) => MCP_TOOLS[s.id] || []).filter((n) => inline.has(n));
        if (clash.length) return J({ errors: [{ detail: 'Webhook tools names must be unique, the following are not unique: ' + clash.join(', ') }] }, 422);
      }
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
ok(!w.error, 'Telnyx accepts Lola’s tools: ' + (w.error || 'saved'));
ok(['list_services', 'confirm_booking', 'cancel_appointment', 'capture_lead', 'recall_client', 'escalate'].every((n) => names.includes(n)), 'she keeps her own signed tools and gets the missing ones: ' + names.join(', '));
ok(a.mcp_servers.map((s) => s.id).join() === 'mcp-ok' && deletes === 0, 'only the clashing MCP server is detached (nothing deleted; the other stays): ' + a.mcp_servers.map((s) => s.id).join());
ok(/Old Lola skills/.test(w.mcp_detached.join()) && /escalate/.test(w.mcp_detached.join()), 'the check names what was detached: ' + w.mcp_detached.join());
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
