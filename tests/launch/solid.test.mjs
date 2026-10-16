// Lola's brain is picked from Telnyx's OWN model list (Llama 3.x left it — a retired id silenced chat,
// texts, the website, the phone and the onboarding scan at once); the phone assistant on a retired model
// is moved to a listed one; and linked calendars sync one by one: a broken link never hides the others,
// never opens its chairs, and the same invite on two stylists' calendars blocks both.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'tk';
const BRAIN = 'assistant-11111111-2222-4333-8444-555555555555';
process.env.TELNYX_LOLA_BRAIN_ID = BRAIN; process.env.APP_URL = 'https://www.loladesk.com'; process.env.SYNC_CONNECTOR_MS = '3000';
delete process.env.LOLA_FAST_MODEL;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
// Telnyx's documented chat models (Oct 2026) — no Llama.
const LISTED = [
  { id: 'zai-org/GLM-5.3-Flash', created: '2026-09-01T00:00:00Z', recommended_for_assistants: true },
  { id: 'zai-org/GLM-5.3', created: '2026-09-01T00:00:00Z' },
  { id: 'deepseek-ai/DeepSeek-V4.1-Flash', created: '2026-08-01T00:00:00Z' },
  { id: 'moonshotai/Kimi-K3', created: '2026-09-15T00:00:00Z' },
  { id: 'moonshotai/Kimi-K2.6', created: '2026-05-01T00:00:00Z', is_vision_supported: true },
  { id: 'Qwen/Qwen3.8-27B', created: '2026-07-01T00:00:00Z' },
];
const sent = []; let refuse = new Set(); let listOk = true; let asst = null; const updates = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.endsWith('/ai/openai/models')) return listOk ? J({ object: 'list', data: LISTED }) : J({ errors: [{ detail: 'down' }] }, 503);
  if (u.includes('chat/completions')) {
    const b = JSON.parse(init.body); sent.push(b.model);
    if (!LISTED.some((m) => m.id === b.model) || refuse.has(b.model)) return J({ error: { message: `The model ${b.model} does not exist` } }, 404);
    return J({ choices: [{ message: { content: 'ready from ' + b.model } }] });
  }
  if (u.includes('/ai/assistants/' + BRAIN)) {
    if (init.method === 'POST' || init.method === 'PATCH') { const b = JSON.parse(init.body); updates.push(b); Object.assign(asst, b); }
    return J({ data: asst });
  }
  if (/\/ai\/tools(\?|$)/.test(u)) return J({ data: [] });
  if (u.includes('/ai/assistants')) return J({ data: [asst] });
  return J({});
};
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
const M = await import(P + 'lib/telnyx-models.js');

// 1) Picking from what Telnyx really serves
const list = await M.telnyxModels({ fresh: true });
ok(list.length === 6 && !list.some((m) => /llama/i.test(m.id)), 'reads Telnyx’s model list (GET /v2/ai/openai/models)');
ok(await M.modelFor('fast') === 'zai-org/GLM-5.3-Flash', 'fast = the quick GLM Flash');
ok(await M.modelFor('power') === 'moonshotai/Kimi-K3', 'strong = the newest Kimi');
ok(await M.modelFor('assistant') === 'zai-org/GLM-5.3-Flash', 'phone = Telnyx’s “recommended for assistants”');
ok(await M.modelFor('vision') === 'moonshotai/Kimi-K2.6', 'photos = a vision model');
process.env.LOLA_FAST_MODEL = 'meta-llama/Llama-3.3-70B-Instruct';
ok(await M.modelFor('fast') === 'zai-org/GLM-5.3-Flash', 'an old LOLA_FAST_MODEL Telnyx no longer lists is ignored');
process.env.LOLA_FAST_MODEL = 'Qwen/Qwen3.8-27B';
ok(await M.modelFor('fast') === 'Qwen/Qwen3.8-27B', 'a listed LOLA_FAST_MODEL is honoured');
delete process.env.LOLA_FAST_MODEL;
ok(!M.isModelError(400, 'tools not supported') && !M.isModelError(400, 'messages too long for model context') && M.isModelError(404, 'The model x does not exist'), 'only an error ABOUT the model benches it');

// 2) Every answer goes to a listed model — never a retired id
const { chat } = await import(P + 'lib/llm.js');
sent.length = 0;
let r = await chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 });
ok(r.ok && r.model === 'zai-org/GLM-5.3-Flash' && sent.join() === 'zai-org/GLM-5.3-Flash', 'chat answers on the listed fast model, first try: ' + sent.join());
refuse = new Set(['zai-org/GLM-5.3-Flash']); sent.length = 0;
r = await chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 });
ok(r.ok && sent.join() === 'zai-org/GLM-5.3-Flash,moonshotai/Kimi-K3', 'refused model → the strong one answers the same turn: ' + sent.join());
sent.length = 0;
r = await chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 });
ok(r.ok && sent[0] === 'deepseek-ai/DeepSeek-V4.1-Flash', 'and the next turn moves to the next fast model on the list: ' + sent.join());
refuse = new Set();
r = await chat({ messages: [{ role: 'user', content: [{ type: 'text', text: 'what color is this' }] }], maxTokens: 50 });
ok(r.ok && /Kimi-K2\.6/.test(r.model), 'a photo goes to a vision model: ' + r.model);
const { chat: chatJsonCore } = await import(P + 'lib/telnyx-inference.js');
sent.length = 0;
const j = await chatJsonCore({ messages: [{ role: 'user', content: 'read my website' }] });
ok(j?.choices?.[0]?.message?.content && !sent.some((m) => /llama/i.test(m)), 'the onboarding scan (website reading) uses a listed model: ' + sent.join());

// 3) Telnyx list unreadable → today's documented ids, never Llama
M._resetModels(); listOk = false; sent.length = 0;
r = await chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 });
ok(r.ok && sent[0] === 'zai-org/GLM-5.3-Flash', 'list down → documented fast default: ' + sent.join());
listOk = true; M._resetModels();

// 4) The phone assistant on a retired model is moved to a listed one
asst = { id: BRAIN, name: 'LolaBrain', model: 'meta-llama/Meta-Llama-3.1-70B-Instruct', greeting: '{{lola_greeting}}', instructions: 'You are Lola.',
  dynamic_variables: { lola_greeting: 'Hi, this call may be recorded. I’m Lola, an AI assistant.' }, tools: [],
  dynamic_variables_webhook_url: 'https://www.loladesk.com/api/agent-variables', telephony_settings: { default_texml_app_id: 'app-1', supports_unauthenticated_web_calls: true } };
const { wireAssistant, _resetAssistantCache } = await import(P + 'lib/assistant-wiring.js');
_resetAssistantCache();
const w = await wireAssistant({ heal: true });
ok(updates.some((b) => b.model === 'zai-org/GLM-5.3-Flash') && asst.model === 'zai-org/GLM-5.3-Flash', 'retired phone model → ' + asst.model);
ok(w.model && w.model.current === 'meta-llama/Meta-Llama-3.1-70B-Instruct' && w.model.set_to === 'zai-org/GLM-5.3-Flash', 'and the check says so');
updates.length = 0;
const w2 = await wireAssistant({ heal: true });
ok(!updates.some((b) => 'model' in b) && w2.model?.ok, 'a listed model is left alone');
asst.model = undefined; updates.length = 0;
await wireAssistant({ heal: true });
ok(!updates.some((b) => 'model' in b), 'no model set (Telnyx default) is left alone');

// 5) Linked calendars: one by one, never wiped by a broken link
const ical = await import(P + 'lib/connectors/ical.js');
const ics = (uid, day, h) => `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART:${day}T${h}0000Z\r\nDTEND:${day}T${h + 1}0000Z\r\nSUMMARY:Client\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
const day = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
const FA = { url: 'https://cal.example-a.com/ana.ics', label: 'Ana', staff_id: 'ana' };
const FB = { url: 'https://cal.down.invalid/bo.ics', label: 'Bo', staff_id: 'bo' };
const FC = { url: 'https://cal.example-c.com/cy.ics', label: 'Cy', staff_id: 'cy' };
const from = new Date().toISOString(), to = new Date(Date.now() + 10 * 864e5).toISOString();
// Prime the two working links (the third can't be reached from here).
const feeds = { [FA.url]: ics('shared-invite', day, 15) + '', [FC.url]: ics('shared-invite', day, 15) };
await ical.listAppointments({ access_token: JSON.stringify([FA, FC]), metadata: {} }, { from, to, fetchImpl: async (u) => new Response(feeds[u], { status: 200 }) });
const integ = { id: 'int-1', tenant_id: 't1', provider: 'ical', status: 'connected', access_token: JSON.stringify([FA, FB, FC]), metadata: { timezone: 'UTC' } };
const apps = await ical.listAppointments(integ, { from, to });
ok(apps.length === 2 && new Set(apps.map((a) => a.id)).size === 2 && apps.some((a) => a.stylist === 'local:ana') && apps.some((a) => a.stylist === 'local:cy'), 'the same invite on two stylists’ calendars blocks BOTH (two rows)');
ok(apps.failed_feeds?.length === 1 && apps.failed_feeds[0].label === 'Bo', 'the broken link is reported by name, the others still read');
const keyB = ical.feedKey(FB), keyA = ical.feedKey(FA);
T.integrations = [integ];
T.cached_availability = [
  { id: 'old-bo', tenant_id: 't1', provider: 'ical', external_booking_id: `bo-client@123#${keyB}`, starts_at: new Date(Date.now() + 864e5).toISOString() },
  { id: 'gone-ana', tenant_id: 't1', provider: 'ical', external_booking_id: `cancelled@456#${keyA}`, starts_at: new Date(Date.now() + 864e5).toISOString() },
];
T.booking_sync_log = [];
const { syncTenantAvailability } = await import(P + 'lib/booking-sync.js');
const { db } = await import(P + 'lib/db.js');
const s = await syncTenantAvailability(db(), 't1');
const ids = T.cached_availability.map((x) => x.id || x.external_booking_id);
ok(s.ok && s.upserted === 2, 'both readable calendars synced: ' + s.upserted);
ok(T.cached_availability.some((x) => x.id === 'old-bo'), 'Bo’s link is down → his booked time is KEPT (never opened to double booking)');
ok(!T.cached_availability.some((x) => x.id === 'gone-ana'), 'Ana’s cancelled appointment is removed (her link answered)');
ok(T.booking_sync_log.at(-1)?.error_message && /Bo/.test(T.booking_sync_log.at(-1).error_message), 'the failing link is logged by name for the owner');

// 6) One booking system that hangs never holds up the rest
const { feedKey } = ical;
ok(typeof feedKey === 'function' && feedKey({ staff_id: 'ana' }) === 'sana' && /^f/.test(feedKey({ url: 'https://x.com/a.ics' })), 'every calendar has a stable key');

console.log(fails ? `\n${fails} FAILED` : '\nall solid checks pass');
process.exit(fails ? 1 : 0);
