/**
 * tests/live-conversations.test.mjs — the "Lola Live" plug-in endpoint.
 *
 * Run:
 *   node tests/live-conversations.test.mjs
 *   node --test tests/
 *
 * Exercises the REAL /api/live-conversations handler against the in-memory
 * fake Supabase with a stubbed global fetch for the Telnyx AI-Assistant
 * conversations/messages APIs. Proves:
 *   • the endpoint is tenant-scoped (401/403 without a mapped owner)
 *   • live call state streams from the calls table (active statuses only,
 *     ticking duration data, transcript passthrough)
 *   • the whisper (live message injection) hits the ACTIVE conversation via
 *     Telnyx with a system role — resolving the newest non-ended
 *     conversation when none is given, honoring an explicit conversation_id,
 *     failing 409 when nothing is live, 503 when Telnyx isn't configured,
 *     and never leaking the key into the response
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSupabase } from './fake-supabase.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STUB_DIR = join(API_ROOT, 'node_modules', '@supabase', 'supabase-js');
mkdirSync(STUB_DIR, { recursive: true });
writeFileSync(join(STUB_DIR, 'package.json'), JSON.stringify({
  name: '@supabase/supabase-js', version: '0.0.0-test', type: 'module',
  main: 'index.js', exports: { '.': './index.js' }
}, null, 2));
writeFileSync(join(STUB_DIR, 'index.js'), [
  '// Generated test double — see tests/live-conversations.test.mjs',
  'export function createClient() {',
  '  const fake = globalThis.__LOLA_FAKE_SUPABASE__;',
  '  if (!fake) throw new Error(\'No fake Supabase registered\');',
  '  return fake;',
  '}',
  ''
].join('\n'));

const fake = new FakeSupabase();
globalThis.__LOLA_FAKE_SUPABASE__ = fake;
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'fake-service-key';

const { default: handler } = await import('../api/live-conversations.js');

const REAL_FETCH = globalThis.fetch;
function stubFetch(impl) { globalThis.fetch = impl; }
function restoreFetch() { globalThis.fetch = REAL_FETCH; }
function okFetch(jsonBody, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => jsonBody };
}

function setupTenant(calls = [], tenantExtra = {}) {
  fake.reset();
  fake.auth.users.set('tok-1', { id: 'u1', email: 'owner@x.com', user_metadata: {} });
  fake.seed('tenants', [{ id: 't1', name: 'Salon One', slug: 'salon-one', owner_email: 'owner@x.com', ...tenantExtra }]);
  fake.seed('calls', calls);
}

function makeRes() {
  const out = { code: 200, body: null };
  return [{
    setHeader() {}, status(c) { out.code = c; return this; },
    json(o) { out.body = o; return o; }
  }, out];
}
const authReq = (body = {}) => ({ method: 'GET', headers: { authorization: 'Bearer tok-1' }, body });
const anonReq = { method: 'GET', headers: {}, body: {} };

test('GET without a session -> 401 (tenant-scoped)', async () => {
  setupTenant();
  const [res, out] = makeRes();
  await handler(anonReq, res);
  assert.equal(out.code, 401);
  assert.equal(out.body.error, 'Not authenticated');
});

test('GET with a live call streams call state even without Telnyx configured (telnyx_ready false)', async () => {
  setupTenant([{
    id: 'c1', tenant_id: 't1', from_number: '+14155550123', to_number: '+14155550999',
    direction: 'inbound', status: 'in_progress', created_at: new Date(Date.now() - 120000).toISOString(),
    started_at: new Date(Date.now() - 120000).toISOString(), duration_seconds: 120,
    telnyx_call_control_id: 'ctrl-1', call_session_id: 'sess-1',
    transcript: JSON.stringify([{ role: 'client', content: 'Do you have openings Thursday?' }, { role: 'lola', content: 'Yes — for a balayage, two o\u2019clock works.' }]),
    summary: 'Balayage inquiry'
  }]);
  delete process.env.TELNYX_API_KEY;
  delete process.env.TELNYX_ASSISTANT_ID;
  const [res, out] = makeRes();
  await handler(authReq(), res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.telnyx_ready, false);
  assert.equal(out.body.active_calls.length, 1);
  const call = out.body.active_calls[0];
  assert.equal(call.from, '+14155550123');
  assert.equal(call.status, 'in_progress');
  assert.equal(call.durationSec, 120);
  assert.equal(call.callControlId, 'ctrl-1');
  assert.equal(call.callSessionId, 'sess-1');
  assert.deepEqual(call.transcript, [{ role: 'client', content: 'Do you have openings Thursday?' }, { role: 'lola', content: 'Yes — for a balayage, two o\u2019clock works.' }]);
  assert.equal(out.body.whisper_target, null, 'no conversation -> no whisper target');
});

test('GET normalizes Telnyx conversations and picks the newest live one as whisper target', async () => {
  setupTenant([{
    id: 'c2', tenant_id: 't1', from_number: '+14155550444', direction: 'inbound', status: 'in_progress',
    created_at: new Date().toISOString()
  }]);
  process.env.TELNYX_API_KEY = 'test-key';
  process.env.TELNYX_ASSISTANT_ID = 'assistant-test';
  stubFetch(async (url) => {
    assert.ok(String(url).includes('/ai/assistants/assistant-test/conversations'), 'lists the assistant conversations');
    assert.ok(!String(url).includes('messages'), 'GET must not post messages');
    return okFetch({
      data: [
        { id: 'conv-old', status: 'ended', started_at: '2026-08-30T10:00:00Z' },
        { id: 'conv-new', status: 'in_progress', started_at: '2026-08-31T10:00:00Z', last_message_at: '2026-08-31T10:05:00Z' }
      ]
    });
  });
  const [res, out] = makeRes();
  await handler(authReq(), res);
  restoreFetch();
  assert.equal(out.code, 200);
  assert.equal(out.body.telnyx_ready, true);
  assert.equal(out.body.assistant_id, 'assistant-test');
  const ids = out.body.conversations.map((c) => c.id);
  assert.deepEqual(ids, ['conv-old', 'conv-new']);
  assert.equal(out.body.conversations.find((c) => c.id === 'conv-old').status, 'ended');
  assert.equal(out.body.whisper_target.conversationId, 'conv-new', 'newest live conversation wins');
});

test('POST whisper injects a system message into the explicit conversation and audits it', async () => {
  setupTenant();
  process.env.TELNYX_API_KEY = 'test-key';
  process.env.TELNYX_ASSISTANT_ID = 'assistant-test';
  let posted = null;
  stubFetch(async (url, opts = {}) => {
    assert.ok(String(url).endsWith('/ai/assistants/assistant-test/conversations/conv-x/messages'), 'posts to the Add Messages API');
    assert.equal(opts.method, 'POST');
    const body = JSON.parse(opts.body);
    assert.equal(body.role, 'system');
    assert.equal(body.content, 'This is a VIP — comp the blowout.');
    const auth = String(opts.headers?.Authorization || '');
    assert.ok(auth.startsWith('Bearer '), 'sends the Telnyx key as Bearer (never echoed in the response)');
    posted = { url, body };
    return okFetch({ data: { id: 'msg-1', role: 'system', content: body.content } });
  });
  const [res, out] = makeRes();
  await handler({ ...authReq(), method: 'POST', body: { conversation_id: 'conv-x', text: 'This is a VIP — comp the blowout.' } }, res);
  restoreFetch();
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.injected.conversationId, 'conv-x');
  assert.equal(posted.body.content, 'This is a VIP — comp the blowout.');
  // audit trail landed in the tenant's conversation log
  const logged = fake.all('messages').filter((m) => m.conversation_id === 'conv-x');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].conversation_id, 'conv-x');
  assert.equal(logged[0].role, 'owner');
  assert.equal(logged[0].tenant_id, 't1');
  assert.equal(logged[0].content, 'This is a VIP — comp the blowout.');
});

test('POST whisper auto-resolves the newest live conversation when none is given', async () => {
  setupTenant();
  process.env.TELNYX_API_KEY = 'test-key';
  process.env.TELNYX_ASSISTANT_ID = 'assistant-test';
  let listCalls = 0, postUrl = null;
  stubFetch(async (url, opts = {}) => {
    if (opts.method === 'POST') { postUrl = String(url); return okFetch({ data: { id: 'm' } }); }
    listCalls += 1;
    return okFetch({ data: [
      { id: 'conv-ended', status: 'ended', started_at: '2026-08-30T10:00:00Z' },
      { id: 'conv-live', status: 'in_progress', last_message_at: '2026-08-31T10:05:00Z' }
    ] });
  });
  const [res, out] = makeRes();
  await handler({ ...authReq(), method: 'POST', body: { text: 'Push the 3pm to 4pm.' } }, res);
  restoreFetch();
  assert.equal(out.code, 200);
  assert.ok(postUrl.endsWith('/conversations/conv-live/messages'), 'used the newest live conversation');
  assert.equal(listCalls, 1);
});

test('POST whisper -> 409 when no conversation is live; 503 when Telnyx is not configured; 502 on Telnyx reject (no key leak)', async () => {
  setupTenant();
  process.env.TELNYX_API_KEY = 'test-key';
  process.env.TELNYX_ASSISTANT_ID = 'assistant-test';
  stubFetch(async () => okFetch({ data: [{ id: 'conv-z', status: 'ended' }] }));
  const [res, out] = makeRes();
  await handler({ ...authReq(), method: 'POST', body: { text: 'hello' } }, res);
  restoreFetch();
  assert.equal(out.code, 409);
  assert.equal(out.body.error, 'no_active_conversation');

  delete process.env.TELNYX_API_KEY;
  const [res2, out2] = makeRes();
  await handler({ ...authReq(), method: 'POST', body: { text: 'hello' } }, res2);
  assert.equal(out2.code, 503);
  assert.equal(out2.body.error, 'telnyx_not_configured');

  process.env.TELNYX_API_KEY = 'test-key';
  stubFetch(async () => ({ ok: false, status: 422, json: async () => ({ error: { message: 'conversation not found' } }) }));
  const [res3, out3] = makeRes();
  await handler({ ...authReq(), method: 'POST', body: { conversation_id: 'conv-nope', text: 'hello' } }, res3);
  restoreFetch();
  assert.equal(out3.code, 502);
  assert.equal(out3.body.error, 'whisper_failed');
  assert.equal(out3.body.detail, 'conversation not found');
  assert.ok(!JSON.stringify(out3.body).includes('test-key'), 'the Telnyx key must never appear in a response');
});

test('POST whisper rejects empty / oversized text', async () => {
  setupTenant();
  process.env.TELNYX_API_KEY = 'test-key';
  process.env.TELNYX_ASSISTANT_ID = 'assistant-test';
  const [res, out] = makeRes();
  await handler({ ...authReq(), method: 'POST', body: { conversation_id: 'c', text: '  ' } }, res);
  assert.equal(out.code, 400);
  const [res2, out2] = makeRes();
  await handler({ ...authReq(), method: 'POST', body: { conversation_id: 'c', text: 'x'.repeat(401) } }, res2);
  assert.equal(out2.code, 400);
});

test('GET closes a call whose insights already landed (insight_at) — panel returns to Standing by', async () => {
  setupTenant([{
    id: 'c-stuck', tenant_id: 't1', from_number: '+14155550123', to_number: '+14155550999',
    direction: 'inbound', status: 'in_progress', created_at: new Date(Date.now() - 60000).toISOString(),
    telnyx_call_control_id: 'ctrl-stuck', call_session_id: 'sess-stuck',
    insight_at: new Date().toISOString() // insights delivered, but status never flipped
  }]);
  delete process.env.TELNYX_API_KEY;
  delete process.env.TELNYX_ASSISTANT_ID;
  const [res, out] = makeRes();
  await handler(authReq(), res);
  assert.equal(out.code, 200);
  assert.equal(out.body.active_calls.length, 0, 'a call with landed insights can no longer be live');
  assert.equal(fake.all('calls')[0].status, 'completed', 'self-heal closed the stuck row');
});

test('GET closes a stale live call (>2h, no end signal) instead of streaming a ghost', async () => {
  setupTenant([{
    id: 'c-ghost', tenant_id: 't1', from_number: '+14155550777', direction: 'inbound', status: 'in_progress',
    created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), // 3h old, still "live"
    telnyx_call_control_id: 'ctrl-ghost'
  }]);
  delete process.env.TELNYX_API_KEY;
  delete process.env.TELNYX_ASSISTANT_ID;
  const [res, out] = makeRes();
  await handler(authReq(), res);
  assert.equal(out.code, 200);
  assert.equal(out.body.active_calls.length, 0, 'ghost call is not streamed');
  assert.equal(fake.all('calls')[0].status, 'completed', 'stale live row closed best-effort');
});

test('GET keeps a fresh live call streaming after the self-heal sweep (no false close)', async () => {
  setupTenant([{
    id: 'c-fresh', tenant_id: 't1', from_number: '+14155550123', to_number: '+14155550999',
    direction: 'inbound', status: 'in_progress', created_at: new Date(Date.now() - 30000).toISOString(),
    telnyx_call_control_id: 'ctrl-fresh', call_session_id: 'sess-fresh'
  }]);
  delete process.env.TELNYX_API_KEY;
  delete process.env.TELNYX_ASSISTANT_ID;
  const [res, out] = makeRes();
  await handler(authReq(), res);
  assert.equal(out.code, 200);
  assert.equal(out.body.active_calls.length, 1, 'fresh live call still streams');
  assert.equal(out.body.active_calls[0].callSessionId, 'sess-fresh');
  assert.equal(fake.all('calls')[0].status, 'in_progress', 'fresh row untouched by the sweep');
});

test('GET marks an ended Telnyx conversation correctly while a DB row stays non-active statuses-only', async () => {
  // Regression guard: rows matching neither the live filter nor the sweep's
  // closed shapes must behave exactly as before (list only active statuses).
  setupTenant([
    { id: 'c-done', tenant_id: 't1', from_number: '+14155550001', direction: 'inbound', status: 'completed', created_at: new Date().toISOString() },
    { id: 'c-ring', tenant_id: 't1', from_number: '+14155550002', direction: 'inbound', status: 'ringing', created_at: new Date().toISOString() }
  ]);
  delete process.env.TELNYX_API_KEY;
  delete process.env.TELNYX_ASSISTANT_ID;
  const [res, out] = makeRes();
  await handler(authReq(), res);
  assert.equal(out.code, 200);
  assert.equal(out.body.active_calls.length, 1);
  assert.equal(out.body.active_calls[0].status, 'ringing', 'non-live rows are excluded, ring state included');
});

test('POST takeover without a session -> 401 (tenant-scoped)', async () => {
  setupTenant();
  process.env.TELNYX_API_KEY = 'test-key';
  const [res, out] = makeRes();
  await handler({ ...anonReq, method: 'POST', body: { action: 'takeover', call_id: 'c1' } }, res);
  assert.equal(out.code, 401);
});

test('POST takeover transfers the live call to the owner phone via Call Control and audits it', async () => {
  setupTenant([{
    id: 'c1', tenant_id: 't1', from_number: '+14155550123', to_number: '+14155550999',
    direction: 'inbound', status: 'in_progress', created_at: new Date().toISOString(),
    telnyx_call_control_id: 'ctrl-1'
  }], { operator_phone: '+16505550100' });
  process.env.TELNYX_API_KEY = 'test-key';
  let hit = null;
  stubFetch(async (url, opts = {}) => {
    hit = { url: String(url), opts };
    assert.ok(String(url).endsWith('/v2/calls/ctrl-1/actions/transfer'), 'POSTs to the Telnyx transfer action');
    assert.equal(opts.method, 'POST');
    const body = JSON.parse(opts.body);
    assert.equal(body.to, '+16505550100', 'targets the owner operator phone');
    assert.equal(body.from, '+14155550999', 'from is the call dialed number');
    assert.ok(String(opts.headers?.Authorization || '').startsWith('Bearer '));
    return okFetch({ data: {} });
  });
  const [res, out] = makeRes();
  await handler({ ...authReq(), method: 'POST', body: { action: 'takeover', call_id: 'c1' } }, res);
  restoreFetch();
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.transferred.callId, 'c1');
  assert.equal(out.body.transferred.to, '+16505550100');
  assert.equal(out.body.transferred.callControlId, 'ctrl-1');
  const audited = fake.all('messages').filter((m) => m.role === 'owner');
  assert.equal(audited.length, 1);
  assert.match(audited[0].content, /took over the call/);
});

test('POST takeover without call_id picks the newest active call', async () => {
  setupTenant([
    { id: 'old', tenant_id: 't1', from_number: '+14155550100', to_number: '+14155550999', direction: 'inbound', status: 'in_progress', created_at: '2026-08-30T10:00:00Z', telnyx_call_control_id: 'ctrl-old' },
    { id: 'new', tenant_id: 't1', from_number: '+14155550101', to_number: '+14155550999', direction: 'inbound', status: 'in_progress', created_at: '2026-08-31T10:00:00Z', telnyx_call_control_id: 'ctrl-new' }
  ], { operator_phone: '+16505550100' });
  process.env.TELNYX_API_KEY = 'test-key';
  stubFetch(async (url) => {
    assert.ok(String(url).endsWith('/actions/transfer'));
    return okFetch({ data: {} });
  });
  const [res, out] = makeRes();
  await handler({ ...authReq(), method: 'POST', body: { action: 'takeover' } }, res);
  restoreFetch();
  assert.equal(out.code, 200);
  assert.equal(out.body.transferred.callId, 'new');
});

test('POST takeover -> 409 no_active_call, no_call_control, and no_owner_phone', async () => {
  setupTenant([
    { id: 'done', tenant_id: 't1', from_number: '+14155550123', status: 'completed', created_at: new Date().toISOString(), telnyx_call_control_id: 'ctrl-done' },
    { id: 'nolc', tenant_id: 't1', from_number: '+14155550124', status: 'in_progress', created_at: new Date().toISOString() }
  ], { operator_phone: '+16505550100' });
  process.env.TELNYX_API_KEY = 'test-key';
  const [res, out] = makeRes();
  await handler({ ...authReq(), method: 'POST', body: { action: 'takeover', call_id: 'done' } }, res);
  assert.equal(out.code, 409);
  assert.equal(out.body.error, 'no_active_call');

  const [res2, out2] = makeRes();
  await handler({ ...authReq(), method: 'POST', body: { action: 'takeover', call_id: 'nolc' } }, res2);
  assert.equal(out2.code, 409);
  assert.equal(out2.body.error, 'no_call_control');

  setupTenant([{ id: 'c9', tenant_id: 't1', from_number: '+14155550125', status: 'in_progress', created_at: new Date().toISOString(), telnyx_call_control_id: 'ctrl-9' }]);
  process.env.TELNYX_API_KEY = 'test-key';
  const [res3, out3] = makeRes();
  await handler({ ...authReq(), method: 'POST', body: { action: 'takeover', call_id: 'c9' } }, res3);
  assert.equal(out3.code, 409);
  assert.equal(out3.body.error, 'no_owner_phone');
});

test('POST takeover -> 503 when Telnyx is not configured; 502 on Telnyx reject (no key leak)', async () => {
  setupTenant([{ id: 'c1', tenant_id: 't1', from_number: '+14155550123', status: 'in_progress', created_at: new Date().toISOString(), telnyx_call_control_id: 'ctrl-1' }], { operator_phone: '+16505550100' });
  delete process.env.TELNYX_API_KEY;
  const [res, out] = makeRes();
  await handler({ ...authReq(), method: 'POST', body: { action: 'takeover', call_id: 'c1' } }, res);
  assert.equal(out.code, 503);
  assert.equal(out.body.error, 'telnyx_not_configured');

  process.env.TELNYX_API_KEY = 'test-key';
  stubFetch(async () => ({ ok: false, status: 422, json: async () => ({ error: { message: 'call control id not found' } }) }));
  const [res2, out2] = makeRes();
  await handler({ ...authReq(), method: 'POST', body: { action: 'takeover', call_id: 'c1' } }, res2);
  restoreFetch();
  assert.equal(out2.code, 502);
  assert.equal(out2.body.error, 'takeover_failed');
  assert.equal(out2.body.detail, 'call control id not found');
  assert.ok(!JSON.stringify(out2.body).includes('test-key'), 'the Telnyx key must never appear in a response');
});
