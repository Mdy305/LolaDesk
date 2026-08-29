/**
 * tests/call-insights.test.mjs — Telnyx post-call insights → Calls page.
 *
 * Run: node tests/call-insights.test.mjs
 *
 * Exercises the real parse/classify/persist pipeline (api/lib/call-insights.js)
 * and the signed webhook route (api/webhooks/telnyx-insights.js) against the
 * in-memory FakeSupabase: extraction, shape-dispatch classification, updating
 * an existing calls row, creating one via the call_sessions map, ignoring
 * unresolvable calls, exactly-once dedupe by event id, and signature gating.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert';
import { FakeSupabase } from './fake-supabase.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STUB_DIR = join(API_ROOT, 'node_modules', '@supabase', 'supabase-js');
mkdirSync(STUB_DIR, { recursive: true });
writeFileSync(join(STUB_DIR, 'package.json'), JSON.stringify({
  name: '@supabase/supabase-js', version: '0.0.0-test', type: 'module',
  main: 'index.js', exports: { '.': './index.js' }
}, null, 2));
writeFileSync(join(STUB_DIR, 'index.js'), [
  '// Generated test double — see tests/call-insights.test.mjs',
  'export function createClient() {',
  '  const fake = globalThis.__LOLA_FAKE_SUPABASE__;',
  '  if (!fake) throw new Error("No fake Supabase registered");',
  '  return fake;',
  '}', ''
].join('\n'));

const fake = new FakeSupabase();
globalThis.__LOLA_FAKE_SUPABASE__ = fake;

process.env.APP_URL = 'https://www.loladesk.com';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'fake-service-key';
delete process.env.TELNYX_PUBLIC_KEY; // non-production: signature check skipped

const { parseInsightsEvent, classifyResults, persistCallInsights } = await import('../api/lib/call-insights.js');
const { default: handler } = await import('../api/webhooks/telnyx-insights.js');

const TENANT = '11111111-1111-1111-1111-111111111111';

function fresh(){
  fake.reset();
  fake.seed('tenants', [{ id: TENANT, name: 'MMΛ Salon', slug: 'mmsalon' }]);
}

function summaryResult(){
  return { insight_id: 'ins-summary', result: JSON.stringify({
    summary: 'Booked a balayage for Friday at 2pm.',
    outcome: 'booked', booked: true, duration_seconds: 142
  }) };
}
function transcriptResult(){
  return { insight_id: 'ins-transcript', result: { transcript: [
    { role: 'assistant', content: 'Hi, this is Lola. How can I help you?' },
    { role: 'client', content: 'I want to book a balayage Friday.' }
  ] } };
}
function eventBody(overrides = {}){
  return {
    data: {
      event_type: 'call.conversation_insights.generated',
      id: overrides.eventId || 'evt-1',
      occurred_at: '2026-08-27T18:02:49.371Z',
      payload: {
        call_control_id: overrides.callControlId || 'v3:ctrl-1',
        call_session_id: 'sess-1',
        call_leg_id: 'leg-1',
        results: overrides.results || [summaryResult(), transcriptResult()]
      }
    }
  };
}

function resMock(){
  const r = { statusCode: 200, headers: {}, body: null };
  r.setHeader = (k, v) => { r.headers[k] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (j) => { r.body = j; return r; };
  r.end = (b) => { if (b) r.body = b; return r; };
  return r;
}

// ── parse ───────────────────────────────────────────────────────────────────
test('parseInsightsEvent extracts ids, event id, and results', () => {
  const p = parseInsightsEvent(eventBody());
  assert.equal(p.eventType, 'call.conversation_insights.generated');
  assert.equal(p.eventId, 'evt-1');
  assert.equal(p.callControlId, 'v3:ctrl-1');
  assert.equal(p.callSessionId, 'sess-1');
  assert.equal(p.callLegId, 'leg-1');
  assert.equal(p.results.length, 2);
});

test('parseInsightsEvent survives malformed envelopes', () => {
  const p = parseInsightsEvent({});
  assert.equal(p.callControlId, null);
  assert.deepEqual(p.results, []);
});

// ── classify ────────────────────────────────────────────────────────────────
test('classifyResults merges summary + transcript results by shape', () => {
  const c = classifyResults([summaryResult(), transcriptResult()]);
  assert.equal(c.summary, 'Booked a balayage for Friday at 2pm.');
  assert.equal(c.outcome, 'booked');
  assert.equal(c.booked, true);
  assert.equal(c.durationSeconds, 142);
  assert.equal(c.transcript.length, 2);
  assert.equal(c.transcript[0].role, 'assistant');
});

test('classifyResults handles plain-string results and empty input', () => {
  assert.equal(classifyResults([{ result: 'Caller asked about pricing' }]).summary, 'Caller asked about pricing');
  const c = classifyResults([]);
  assert.equal(c.summary, null);
  assert.equal(c.transcript, null);
});

// ── persist ─────────────────────────────────────────────────────────────────
test('persistCallInsights updates an existing calls row matched by control id', async () => {
  fresh();
  fake.seed('calls', [{ id: 'call-1', tenant_id: TENANT, telnyx_call_control_id: 'v3:ctrl-1', status: 'completed', duration_seconds: 60 }]);
  const parsed = parseInsightsEvent(eventBody());
  const r = await persistCallInsights(fake, parsed, classifyResults(parsed.results));
  assert.equal(r.mode, 'updated');
  assert.equal(r.callId, 'call-1');
  const row = fake.all('calls')[0];
  assert.equal(row.summary, 'Booked a balayage for Friday at 2pm.');
  assert.equal(row.outcome, 'booked');
  assert.equal(row.insight_id, 'evt-1');
  assert.equal(row.call_session_id, 'sess-1');
  assert.deepEqual(row.transcript, transcriptResult().result.transcript);
});

test('persistCallInsights creates a row via the call_sessions map when no call row exists', async () => {
  fresh();
  fake.seed('call_sessions', [{ call_control_id: 'v3:ctrl-9', tenant_id: TENANT, from_number: '+19294568227', to_number: '+14107848940' }]);
  const parsed = parseInsightsEvent(eventBody({ callControlId: 'v3:ctrl-9', eventId: 'evt-9' }));
  const r = await persistCallInsights(fake, parsed, classifyResults(parsed.results));
  assert.equal(r.mode, 'created');
  const rows = fake.all('calls');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tenant_id, TENANT);
  assert.equal(rows[0].from_number, '+19294568227');
  assert.equal(rows[0].to_number, '+14107848940');
  assert.equal(rows[0].direction, 'inbound');
  assert.equal(rows[0].status, 'completed');
  assert.equal(rows[0].summary, 'Booked a balayage for Friday at 2pm.');
});

test('persistCallInsights teaches Lola: writes a last_call memory per caller', async () => {
  fresh();
  fake.seed('call_sessions', [{ call_control_id: 'v3:ctrl-11', tenant_id: TENANT, from_number: '+19294568227', to_number: '+14107848940' }]);
  const parsed = parseInsightsEvent(eventBody({ callControlId: 'v3:ctrl-11', eventId: 'evt-11' }));
  const r = await persistCallInsights(fake, parsed, classifyResults(parsed.results));
  assert.equal(r.mode, 'created');
  const memories = fake.all('client_memories');
  assert.equal(memories.length, 1);
  const mem = memories[0];
  assert.equal(mem.tenant_id, TENANT);
  assert.equal(mem.client_phone, '+19294568227');   // the CALLER, tenant-scoped
  assert.equal(mem.key, 'last_call');
  assert.equal(mem.value.outcome, 'booked');
  assert.equal(mem.value.summary, 'Booked a balayage for Friday at 2pm.');
  assert.ok(mem.value.at);
});

test('persistCallInsights does not write memory without a caller number', async () => {
  fresh();
  fake.seed('call_sessions', [{ call_control_id: 'v3:ctrl-12', tenant_id: TENANT, from_number: null, to_number: '+14107848940' }]);
  const parsed = parseInsightsEvent(eventBody({ callControlId: 'v3:ctrl-12', eventId: 'evt-12' }));
  const r = await persistCallInsights(fake, parsed, classifyResults(parsed.results));
  assert.equal(r.mode, 'created');
  assert.equal(fake.all('client_memories').length, 0);
});

test('persistCallInsights ignores calls with no resolvable tenant', async () => {
  fresh(); // no call_sessions, no calls rows
  const parsed = parseInsightsEvent(eventBody());
  const r = await persistCallInsights(fake, parsed, classifyResults(parsed.results));
  assert.equal(r.mode, 'ignored');
  assert.ok(String(r.reason).includes('tenant'));
  assert.equal(fake.all('calls').length, 0);
});

test('persistCallInsights skips a redelivered event id (exactly-once)', async () => {
  fresh();
  fake.seed('calls', [{ id: 'call-1', tenant_id: TENANT, telnyx_call_control_id: 'v3:ctrl-1', insight_id: 'evt-1' }]);
  const parsed = parseInsightsEvent(eventBody());
  const r = await persistCallInsights(fake, parsed, classifyResults(parsed.results));
  assert.equal(r.mode, 'duplicate');
  assert.equal(r.callId, 'call-1');
  assert.equal(fake.all('calls').length, 1); // no second row
});

test('persistCallInsights no-ops without a database', async () => {
  const r = await persistCallInsights(null, parseInsightsEvent(eventBody()), {});
  assert.equal(r.mode, 'ignored');
});

// ── route ───────────────────────────────────────────────────────────────────
test('webhook returns 200 with created mode for a valid event', async () => {
  fresh();
  fake.seed('call_sessions', [{ call_control_id: 'v3:ctrl-1', tenant_id: TENANT, from_number: '+19294568227', to_number: '+14107848940' }]);
  const req = { method: 'POST', body: JSON.stringify(eventBody()) };
  const res = resMock();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.mode, 'created');
});

test('webhook acknowledges and ignores unknown calls without crashing', async () => {
  fresh();
  const req = { method: 'POST', body: JSON.stringify(eventBody()) };
  const res = resMock();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.mode, 'ignored');
});

test('webhook rejects garbage and non-POST', async () => {
  fresh();
  const bad = resMock();
  await handler({ method: 'POST', body: 'not json{{{' }, bad);
  assert.equal(bad.statusCode, 400);
  const wrong = resMock();
  await handler({ method: 'GET' }, wrong);
  assert.equal(wrong.statusCode, 405);
});

test('webhook enforces the signature when TELNYX_PUBLIC_KEY is set', async () => {
  fresh();
  process.env.TELNYX_PUBLIC_KEY = 'test-public-key';
  try{
    const req = { method: 'POST', body: JSON.stringify(eventBody()) }; // no signature headers
    const res = resMock();
    await handler(req, res);
    assert.equal(res.statusCode, 401);
  }finally{
    delete process.env.TELNYX_PUBLIC_KEY;
  }
});

// ── agent-variables correlation ─────────────────────────────────────────────
test('agent-variables records the call_sessions mapping for a resolved tenant', async () => {
  fresh();
  fake.seed('tenant_numbers', [{ tenant_id: TENANT, phone_number: '+14107848940', status: 'active' }]);
  fake.seed('tenants', [{ id: TENANT, name: 'MMΛ Salon', slug: 'mmsalon', phone_number: '+14107848940' }]);
  const { default: av } = await import('../api/agent-variables.js');
  const req = {
    method: 'POST',
    body: JSON.stringify({
      data: { payload: { to: '+14107848940', from: '+19294568227', call_control_id: 'v3:ctrl-av' } }
    })
  };
  const res = resMock();
  await av(req, res);
  assert.equal(res.statusCode, 200);
  const sess = fake.all('call_sessions').find(s => s.call_control_id === 'v3:ctrl-av');
  assert.ok(sess, 'session mapping recorded');
  assert.equal(sess.tenant_id, TENANT);
  assert.equal(sess.from_number, '+19294568227');
});

// ── Lola remembers: last_call memory → next call's caller_brief ─────────────
test('agent-variables repeats the caller\u2019s last_call memory in the next caller_brief', async () => {
  fresh();
  fake.seed('tenant_numbers', [{ tenant_id: TENANT, phone_number: '+14107848940', status: 'active' }]);
  fake.seed('tenants', [{ id: TENANT, name: 'MMΛ Salon', slug: 'mmsalon', phone_number: '+14107848940' }]);
  // The client exists and has a last_call memory row (written by the
  // post-call insights pipeline, keyed 'last_call' under the caller\u2019s E.164).
  fake.seed('clients', [{ id: 'cli-mem', tenant_id: TENANT, phone: '+19294568227', first_name: 'Sarah', last_name: 'Kim', name: 'Sarah Kim' }]);
  fake.seed('client_memories', [{
    tenant_id: TENANT,
    client_phone: '+19294568227',
    key: 'last_call',
    value: { outcome: 'booked', summary: 'Booked a balayage for Friday at 2pm.', booked: true },
    created_at: new Date().toISOString()
  }]);
  const { default: av } = await import('../api/agent-variables.js');
  const req = {
    method: 'POST',
    body: JSON.stringify({
      data: { payload: { to: '+14107848940', from: '+19294568227', call_control_id: 'v3:ctrl-mem' } }
    })
  };
  const res = resMock();
  await av(req, res);
  assert.equal(res.statusCode, 200);
  const vars = res.body.dynamic_variables;
  assert.equal(vars.caller_known, 'true');
  assert.equal(vars.caller_name, 'Sarah Kim');
  assert.ok(vars.caller_brief.includes('Last call:'), 'brief repeats the last call');
  assert.ok(vars.caller_brief.includes('Booked a balayage for Friday at 2pm.'), 'brief carries the summary');
  assert.ok(vars.caller_brief.includes('booked'), 'brief carries the outcome');
});

test('agent-variables with no last_call memory stays neutral (no phantom brief)', async () => {
  fresh();
  fake.seed('tenant_numbers', [{ tenant_id: TENANT, phone_number: '+14107848940', status: 'active' }]);
  fake.seed('tenants', [{ id: TENANT, name: 'MMΛ Salon', slug: 'mmsalon', phone_number: '+14107848940' }]);
  fake.seed('clients', [{ id: 'cli-mem2', tenant_id: TENANT, phone: '+19294568227', first_name: 'Sarah', last_name: 'Kim', name: 'Sarah Kim' }]);
  fake.seed('client_memories', []);
  const { default: av } = await import('../api/agent-variables.js');
  const req = {
    method: 'POST',
    body: JSON.stringify({ data: { payload: { to: '+14107848940', from: '+19294568227' } } })
  };
  const res = resMock();
  await av(req, res);
  assert.equal(res.statusCode, 200);
  const vars = res.body.dynamic_variables;
  assert.ok(!String(vars.caller_brief || '').includes('Last call:'), 'no memory → no last-call tail');
});
