// Salon isolation: no salon's clients, memories, conversations or business snapshot can be read or
// changed by anyone but that salon — and each person's thread with Lola is their own and persists.
process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.TELNYX_API_KEY = 'k';
process.env.APP_URL = 'https://www.loladesk.com';
delete process.env.LOLA_TOOL_SECRET; delete process.env.TELNYX_PUBLIC_KEY; delete process.env.OWNER_LINE_NUMBER; delete process.env.LOLADESK_OWNER_LINE;
process.env.OPERATOR_TOOLS_SECRET = 'op-master';
const sms = [], whispers = [];
let convList = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url); const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('/v2/messages')) { sms.push(JSON.parse(init.body)); return J({ data: { id: 'm' + sms.length } }); }
  if (/\/conversations\/[^/]+\/messages$/.test(u) && init.method === 'POST') { whispers.push(u); return J({ data: { id: 'w' } }); }
  if (/\/ai\/assistants\/[^/]+\/conversations/.test(u)) return J({ data: convList });
  return J({ data: [] });
};
const { T } = await import('./fake-supabase.mjs');
const P = new URL('../../api/', import.meta.url).href;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEMO = '00000000-0000-0000-0000-000000000000';
const LINE_A = '+13055550100', LINE_B = '+17865550200', LINE_C = '+19545550300';
const OWNER_A = '+13055559001', SHARED_CELL = '+13055559999', MARIA = '+13055551111';
const now = new Date().toISOString();
function reset() {
  T.tenants = [
    { id: DEMO, name: 'Demo Salon', slug: 'demo', phone_number: null },
    { id: A, name: 'Salon A', slug: 'salon-a', owner_email: 'a@x.com', phone_number: LINE_A, operator_phone: OWNER_A, subscription_status: 'active', status: 'active', created_at: '2026-01-01T00:00:00Z' },
    { id: B, name: 'Salon B', slug: 'salon-b', owner_email: 'b@x.com', phone_number: LINE_B, operator_phone: SHARED_CELL, subscription_status: 'active', status: 'active', created_at: '2026-01-02T00:00:00Z' },
    { id: C, name: 'Salon C', slug: 'salon-c', owner_email: 'c@x.com', phone_number: LINE_C, operator_phone: SHARED_CELL, subscription_status: 'active', status: 'active', created_at: '2026-01-03T00:00:00Z' }];
  T.tenant_users = [{ user_id: 'uA', tenant_id: A, role: 'owner' }, { user_id: 'uA2', tenant_id: A, role: 'staff' }, { user_id: 'uB', tenant_id: B, role: 'owner' }];
  T.tenant_numbers = [];
  T.clients = [{ id: 'cA', tenant_id: A, first_name: 'Maria', last_name: 'Lopez', name: 'Maria Lopez', phone: MARIA, visit_count: 7, no_show_count: 2, birthday: '1990-04-01', tags: ['vip'] },
    { id: 'cB', tenant_id: B, first_name: 'Zoe', last_name: 'Klein', name: 'Zoe Klein', phone: MARIA, visit_count: 1 }];
  T.client_memories = []; T.conversations = []; T.messages = []; T.usage_events = []; T.opt_outs = []; T.telnyx_events = [];
  T.calls = []; T.call_sessions = []; T.booking_settings = []; T.knowledge_base = []; T.staff = []; T.services = [];
  T.bookings = [{ id: 'bA', tenant_id: A, client_id: 'cA', status: 'confirmed', start_time: now, total_amount: 100 },
    { id: 'bB1', tenant_id: B, client_id: 'cB', status: 'confirmed', start_time: now, total_amount: 1 },
    { id: 'bB2', tenant_id: B, client_id: 'cB', status: 'confirmed', start_time: now, total_amount: 1 }];
}
reset();
globalThis.__authUsers = { tA: { id: 'uA', email: 'a@x.com' }, tA2: { id: 'uA2', email: 'staff@x.com' }, tB: { id: 'uB', email: 'b@x.com' } };
const run = async (mod, { body = {}, method = 'POST', headers = {}, query = {}, url } = {}) => {
  const h = (await import(P + mod)).default;
  return new Promise((resolve) => {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; },
      json(o) { resolve({ status: this.statusCode, body: o }); return this; }, send(o) { resolve({ status: this.statusCode, body: o }); return this; }, end() { resolve({ status: this.statusCode }); } };
    h({ method, url: url || ('/api/' + mod + (Object.keys(query).length ? '?' + new URLSearchParams(query) : '')), headers, query, body }, res);
  });
};
const { toolKey } = await import(P + 'lib/tool-key.js');
const { _resetAssistantCache } = await import(P + 'lib/assistant-wiring.js').catch(() => ({}));
const hasPII = (o) => /Maria|Lopez|no-show|1990-04-01|vip|Zoe|Klein|cA\b|cB\b/.test(JSON.stringify(o));

// ── 1. Salon details webhook (/api/lola/dynamic-variables): no caller memory without our signature ──
let r = await run('lola/dynamic-variables.js', { body: { to: LINE_A, from: MARIA } });
ok(r.status === 200 && r.body.company_name === 'Salon A', 'unsigned: salon public facts still answered');
ok(!hasPII(r.body) && r.body.client_id === '', 'unsigned {to, from} returns NO client name / visits / birthday / tags / id');
r = await run('lola/dynamic-variables.js', { body: { to: LINE_A, from: MARIA }, query: { k: 'wrong-key-wrong-key-wron' } });
ok(!hasPII(r.body), 'a wrong key is treated as unsigned');
r = await run('lola/dynamic-variables.js', { body: { to: LINE_A, from: MARIA }, query: { k: toolKey('variables') } });
ok(/Maria Lopez/.test(r.body.caller_brief) && r.body.client_id === 'cA', 'signed (k for variables) phone caller: her own salon\'s memory of her');
ok(!/Zoe/.test(JSON.stringify(r.body)), "same phone at another salon: that salon's record never leaks in");
r = await run('lola/dynamic-variables.js', { body: { to: LINE_A, from: MARIA, telnyx_conversation_channel: 'web_call' }, query: { k: toolKey('variables') } });
ok(!hasPII(r.body), 'signed but a website visitor (typed number, not a verified line): no memory');
r = await run('lola/dynamic-variables.js', { body: { to: LINE_A, from: MARIA }, query: { k: toolKey('tools') } });
ok(!hasPII(r.body), 'a tools key is not a variables key');

// ── 2. Voice tools: get-context / check-availability / book-appointment ──
r = await run('lola/get-context.js', { body: { to_number: LINE_A, from_number: MARIA } });
ok(r.status === 200 && r.body.found && r.body.business?.name === 'Salon A', 'get-context unsigned: salon facts');
ok(r.body.caller === null && !hasPII(r.body), 'get-context unsigned: NO caller record, greeting without her name');
r = await run('lola/get-context.js', { body: { to_number: LINE_A, from_number: MARIA }, query: { k: toolKey() } });
ok(r.body.caller?.display_name === 'Maria Lopez' && /Maria/.test(r.body.greeting), 'get-context signed k: the caller is recognised');
r = await run('lola/get-context.js', { body: { to_number: LINE_A, from_number: '+19995550000' }, query: { k: toolKey(), from: MARIA } });
ok(r.body.caller?.display_name === 'Maria Lopez', 'signed: the caller line Telnyx put on the URL wins over what the model typed');
process.env.LOLA_TOOL_SECRET = 'legacy';
r = await run('lola/get-context.js', { body: { to_number: LINE_A, from_number: MARIA } });
ok(r.status === 401, 'legacy strict mode (secret set) without header or k → 401');
r = await run('lola/get-context.js', { body: { to_number: LINE_A, from_number: MARIA }, headers: { 'x-lola-tool-secret': 'legacy' } });
ok(r.body.caller?.display_name === 'Maria Lopez', 'legacy header still works');
r = await run('lola/check-availability.js', { body: { to_number: LINE_A, service_id: 'x' }, query: { k: toolKey() } });
ok(r.status !== 401, 'secret set: our signed k is accepted too (no header needed)');
delete process.env.LOLA_TOOL_SECRET;
r = await run('lola/check-availability.js', { body: { to_number: LINE_A, service_id: 'nope' } });
ok(r.status === 404 && r.body.error === 'service_not_found', 'check-availability stays public (no secret configured) and answers');
r = await run('lola/book-appointment.js', { body: { to_number: LINE_A, from_number: MARIA, service_id: 'nope', start_iso: new Date(Date.now() + 864e5).toISOString() } });
ok(r.status === 401 && !hasPII(r.body), 'book-appointment (a write) refuses an unsigned caller, even with no secret configured');
r = await run('lola/book-appointment.js', { body: { to_number: LINE_A, from_number: MARIA, service_id: 'nope', start_iso: new Date(Date.now() + 864e5).toISOString() }, query: { k: toolKey() } });
ok(r.status !== 401 && !hasPII(r.body), 'book-appointment with LolaDesk\'s signed k answers, and never returns a client\'s record');

// ── 3. Owner texts: only the real owner, on their own line or the owner line ──
const smsIn = (from, to, text) => run('telnyx-sms.js', { body: { data: { event_type: 'message.received', id: 'ev' + Math.random(), payload: { id: 'p' + Math.random(), from: { phone_number: from }, to: [{ phone_number: to }], text, type: 'SMS' } } } });
const { getTenantByOperatorPhone, getOrStartConversation, getConversationHistory, logMessage, participantFor } = await import(P + 'lib/db.js');
ok(await getTenantByOperatorPhone(SHARED_CELL) === null, 'a cell registered on two different salons is nobody\'s owner phone');
ok((await getTenantByOperatorPhone(OWNER_A))?.id === A, 'a cell registered on exactly one salon is that owner');
r = await smsIn(SHARED_CELL, LINE_B, "what's my revenue today?");
// On a salon's OWN line, that salon trusts its own operator phone (even if a test/duplicate salon lists the same cell).
ok(r.body.handled === 'owner_chat' && T.conversations.some((c) => c.tenant_id === B && c.channel === 'operator') && !T.conversations.some((c) => c.tenant_id === C && c.channel === 'operator'), `B's own operator phone texting B's own line gets B's assistant — never C's (${r.body.handled})`);
r = await smsIn(SHARED_CELL, '+18885550000', 'revenue?');
ok(r.body.handled !== 'owner_chat', 'the ambiguous cell on the owner line gets no salon at all');
r = await smsIn(OWNER_A, LINE_B, 'how was today?');
ok(r.body.handled !== 'owner_chat' && !T.conversations.some((c) => c.channel === 'operator' && c.tenant_id === A), "salon A's owner texting salon B's line is just a client of B (never B's brain, never A's)");
r = await smsIn(OWNER_A, LINE_A, 'how was today?');
ok(r.body.handled === 'owner_chat', "A's owner texting A's own line → owner chat");
r = await smsIn(OWNER_A, LINE_A, 'and tomorrow?');
const ownerThreads = T.conversations.filter((c) => c.tenant_id === A && c.channel === 'operator');
ok(ownerThreads.length === 1 && T.messages.filter((m) => m.conversation_id === ownerThreads[0].id).length === 4, `owner's SMS thread persists across texts (${ownerThreads.length} thread, ${T.messages.filter((m) => m.conversation_id === ownerThreads[0]?.id).length} messages)`);
r = await smsIn(OWNER_A, '+18885550000', 'brief me');
ok(r.body.handled === 'owner_chat', 'the unique owner on the LolaDesk owner line → owner chat');
process.env.OWNER_LINE_NUMBER = '+18885551234';
r = await smsIn(OWNER_A, '+18885550000', 'brief me');
ok(r.body.handled !== 'owner_chat', 'with OWNER_LINE_NUMBER set, only that number is the owner line');
r = await smsIn(OWNER_A, '+18885551234', 'brief me');
ok(r.body.handled === 'owner_chat', '…and that number works');
delete process.env.OWNER_LINE_NUMBER;

// ── 4. No demo / other-salon fallback ──
const { resolveExecutionTenant } = await import(P + 'lib/lola-executor.js');
T.tenants[0].phone_number = '+10000000000';
ok(await resolveExecutionTenant({ to: '+19995550000' }) === null, 'execution: unknown number → no salon (never the demo salon)');
ok((await resolveExecutionTenant({ to: LINE_B }))?.id === B, 'execution: known number → exactly that salon');
const { tenantToolSecret } = await import(P + 'lib/operator-db.js');
r = await run('operator-tools.js', { body: { tenant: 'salon-b', tool: 'find_revenue' }, query: { tenant: 'salon-a', tool: 'find_revenue' }, headers: { 'x-lola-operator-secret': tenantToolSecret('salon-a') } });
ok(r.body.count === 1, `salon A's operator key can't read salon B by naming it in the body (count ${r.body.count})`);
r = await run('operator-tools.js', { body: { to: '+19995550000', tool: 'find_revenue' }, headers: { 'x-lola-operator-secret': 'op-master' } });
ok(/couldn't tell which salon/.test(r.body.speak || ''), 'operator tools: unknown number → no salon (never the demo salon)');

// ── 5. Each person's thread with Lola is their own, and it persists ──
reset();
const t1 = await getOrStartConversation(A, { channel: 'dashboard', participant: participantFor({ id: 'uA' }) });
const t2 = await getOrStartConversation(A, { channel: 'dashboard', participant: participantFor({ id: 'uA' }) });
const t3 = await getOrStartConversation(A, { channel: 'dashboard', participant: participantFor({ id: 'uA2' }) });
const t4 = await getOrStartConversation(B, { channel: 'dashboard', participant: participantFor({ id: 'uA' }) });
ok(t1?.id && t1.id === t2.id, 'the owner\'s dashboard thread is found and reused');
ok(t3.id !== t1.id && t4.id !== t1.id, 'a staff member gets their own thread; another salon never shares it');
const n1 = await getOrStartConversation(A, { channel: 'sms' }), n2 = await getOrStartConversation(A, { channel: 'sms' });
ok(n1.id !== n2.id, 'no client and no participant → never a shared client-less thread');
for (let i = 0; i < 20; i++) { await logMessage({ conversationId: t1.id, tenantId: A, role: i % 2 ? 'assistant' : 'user', agent: 'lola', content: 'm' + i }); await new Promise((r) => setTimeout(r, 2)); }
const h = await getConversationHistory(t1.id, 4);
ok(h.map((m) => m.content).join(',') === 'm16,m17,m18,m19', `history is the LATEST turns in order (${h.map((m) => m.content).join(',')})`);

const { dashboardBrainReply } = await import(P + 'lib/dashboard-brain.js');
const tenantA = T.tenants.find((t) => t.id === A);
const turn = (user, text) => dashboardBrainReply({ tenant: tenantA, user, body: { messages: [{ role: 'user', content: text }], channel: 'dashboard_test' } }).catch((e) => ({ error: String(e) }));
await turn({ id: 'uA' }, 'what are my hours?');
await turn({ id: 'uA' }, 'and my services?');
await turn({ id: 'uA2' }, 'what are my hours?');
const dash = T.conversations.filter((c) => c.channel === 'dashboard_test');
const ownerDash = dash.filter((c) => c.metadata?.participant === 'user:uA'), staffDash = dash.filter((c) => c.metadata?.participant === 'user:uA2');
ok(ownerDash.length === 1 && staffDash.length === 1 && dash.every((c) => c.tenant_id === A), `Lola's dashboard brain reuses the owner's thread across turns and keeps staff separate (${ownerDash.length}/${staffDash.length})`);
ok(T.messages.filter((m) => m.conversation_id === ownerDash[0]?.id && m.role === 'user').length === 2, "both of the owner's turns are in the owner's thread");
await turn(null, 'hi');
ok(T.conversations.some((c) => c.channel === 'dashboard_test' && c.metadata?.participant === 'owner'), "no login (owner line) → the salon's own 'owner' thread");
r = await run('lola.js', { body: { messages: [{ role: 'user', content: 'what are my hours?' }], channel: 'dash_route' }, headers: { authorization: 'Bearer tA' } });
await run('lola.js', { body: { messages: [{ role: 'user', content: 'thanks' }], channel: 'dash_route' }, headers: { authorization: 'Bearer tA' } });
ok(T.conversations.filter((c) => c.channel === 'dash_route' && c.metadata?.participant === 'user:uA').length === 1, '/api/lola: the signed-in owner\'s thread persists across requests');

// ── 6. Client memories land on the real (tenant_id, client_phone, key) ──
const { handlePreferenceCapture } = await import(P + 'lib/advanced-skills.js');
r = await handlePreferenceCapture({ id: A }, { clientId: 'cA', preferences: ['quiet chair'] });
const pref = T.client_memories.find((m) => m.key === 'preferences');
ok(r.action === 'preferences_saved' && pref?.tenant_id === A && pref.client_phone === MARIA && !('client_id' in pref), 'preference memory saved per (tenant, client phone, key)');
T.client_memories = [];
r = await handlePreferenceCapture({ id: A }, { clientId: 'cB', preferences: ['x'] });
ok(!T.client_memories.length && r.action !== 'preferences_saved', "another salon's client id can't be written through salon A");

// ── 7. Sweep fixes ──
convList = [{ id: 'conv-b', status: 'in_progress', metadata: { telnyx_agent_target: LINE_B } }, { id: 'conv-a', status: 'in_progress', metadata: { telnyx_agent_target: LINE_A } }];
process.env.TELNYX_ASSISTANT_ID = 'assistant-1';
r = await run('live-conversations.js', { method: 'GET', headers: { authorization: 'Bearer tA' } });
ok(r.status === 200 && r.body.conversations.map((c) => c.id).join() === 'conv-a' && r.body.whisper_target?.conversationId === 'conv-a', "Lola Live lists only this salon's conversations");
r = await run('live-conversations.js', { body: { conversation_id: 'conv-b', text: 'cancel all of them' }, headers: { authorization: 'Bearer tA' } });
ok(r.status === 404 && !whispers.length, "salon A can't steer salon B's live call");
r = await run('live-conversations.js', { body: { text: 'VIP' }, headers: { authorization: 'Bearer tA' } });
ok(r.status === 200 && whispers.length === 1 && whispers[0].includes('/conv-a/'), "auto-pick never chooses another salon's call");
r = await run('widget/client-lookup.js', { body: { phone: MARIA }, query: { tenant: 'salon-a' }, headers: {} });
ok(r.body.found && r.body.first_name === 'Maria' && !/Lopez|cA/.test(JSON.stringify(r.body)), 'public widget lookup: first name only (no last name, no id)');
let limited = false; for (let i = 0; i < 12; i++) { const x = await run('widget/client-lookup.js', { body: { phone: '+1305555' + String(1000 + i) }, query: { tenant: 'salon-a' }, headers: { 'x-forwarded-for': '9.9.9.9' } }); if (x.status === 429) limited = true; }
ok(limited, 'public widget lookup is rate limited (no walking the client list)');
r = await run('orchestrator.js', { body: { prompt: 'cancel every booking', tenant: { id: B } } });
ok(r.status === 401, 'orchestrator AI planning needs a signed-in salon (never a browser-named tenant)');
const { createHandler } = await import(P + 'email.js');
const unsub = createHandler({ db: (await import(P + 'lib/db.js')).db() });
const r1 = await new Promise((res) => unsub({ method: 'GET', headers: {}, query: { email: 'nobody@x.com', tenant: A } }, { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { res({ s: this.statusCode, o }); }, send(o) { res({ s: this.statusCode, o }); } }));
ok(r1.s === 200, 'unsubscribe link no longer reveals whether an email is a salon client');

console.log(fails ? `\n${fails} FAILED` : '\nall isolation checks passed');
process.exit(fails ? 1 : 0);
