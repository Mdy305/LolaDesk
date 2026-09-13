/**
 * tests/health-gate.test.mjs — the ONE health gate + the ONE SMS owner.
 *
 * Run:
 *   node tests/health-gate.test.mjs
 *   node --test tests/
 *
 * Before api/lib/health-gate.js, six /api/*-health endpoints each
 * re-implemented env checking and probing (execution-health even kept a
 * second, drifted copy of the required-tables manifest), and a hung DB
 * probe could leave calendar-health serving an EMPTY body — the cold-start
 * false red. Proves here that:
 *   • a hung DB probe cannot wedge calendar-health: it still answers JSON
 *     within its per-probe timeout (probe hangs 60s, gate answers in ~80ms)
 *   • a thrown probe degrades to a failing row, never an empty body
 *   • a missing table fails loudly with the gate's JSON shape
 *   • database_not_configured is a proper 503 JSON error
 * And for the SMS owner (api/lib/sms.js):
 *   • exactly one file in api/ may POST to /v2/messages
 *   • every send goes out with the Telnyx bearer and no key in the body
 *   • WhatsApp sends use the whatsapp_message payload
 *   • sendAutopilotSms keeps its skipped/reason contract and rides the owner
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
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
  '// Generated test double — see tests/health-gate.test.mjs',
  'export function createClient() {',
  "  const fake = globalThis.__LOLA_FAKE_SUPABASE__;",
  "  if (!fake) throw new Error('No fake Supabase registered');",
  '  return fake;',
  '}',
  ''
].join('\n'));

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'fake-service-key';
process.env.TELNYX_API_KEY = 'KEY01_TESTKEY_NOT_REAL';
process.env.TELNYX_PUBLIC_KEY = 'PUBKEY_TEST';

const fake = new FakeSupabase();
globalThis.__LOLA_FAKE_SUPABASE__ = fake;

const { default: calendarHandler } = await import('../api/calendar-health.js');
const { default: executionHandler } = await import('../api/execution-health.js');
const { default: telecomHandler } = await import('../api/telecom-health.js');
const gate = await import('../api/lib/health-gate.js');

function makeRes() {
  const out = { code: 200, body: null, headers: {}, ended: false };
  return [out, {
    setHeader(k, v) { out.headers[k] = v; },
    status(c) { out.code = c; return this; },
    json(o) { out.body = o; return o; },
    end() { out.ended = true; },
  }];
}

test('database_not_configured is a proper 503 JSON error, not an empty body', async () => {
  // Must run before db() memoizes its client anywhere in this file — the
  // gate's own module-level db() call caches on first success.
  const fakeNoDb = new FakeSupabase();
  globalThis.__LOLA_FAKE_SUPABASE__ = fakeNoDb;
  const realUrl = process.env.SUPABASE_URL;
  const realKey = process.env.SUPABASE_SERVICE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_KEY;
  try {
    const [out, res] = makeRes();
    await calendarHandler({ method: 'GET', query: {}, headers: {}, body: {} }, res);
    assert.equal(out.code, 503);
    assert.equal(out.body.error, 'database_not_configured');
  } finally {
    process.env.SUPABASE_URL = realUrl;
    process.env.SUPABASE_SERVICE_KEY = realKey;
    globalThis.__LOLA_FAKE_SUPABASE__ = fake;
  }
});

test('a hung DB probe cannot wedge calendar-health — JSON always answers', async () => {
  fake.reset();
  for (const t of ['tenants']) fake.seed(t, []);
  // Every read hangs forever (chainable select that never resolves).
  const realFrom = fake.from.bind(fake);
  fake.from = () => ({ select: () => new Promise(() => {}) });
  try {
    const t0 = Date.now();
    const result = await gate.calendarHealth({ timeoutMs: 80 });
    assert.ok(Date.now() - t0 < 3000, 'gate answered well before the hung probe (80ms per-probe cap)');
    assert.equal(result.ready, false);
    assert.ok(result.checks.length > 0, 'per-table rows present');
    assert.ok(result.checks.every((c) => String(c.error).includes('timed out')), 'timeout reported per table');
  } finally { fake.from = realFrom; }
});

test('a thrown probe degrades to a failing row, never an empty body', async () => {
  fake.reset();
  for (const t of ['tenants']) fake.seed(t, []);
  const realFrom = fake.from.bind(fake);
  fake.from = () => { throw new Error('connection refused'); };
  try {
    const [out, res] = makeRes();
    await calendarHandler({ method: 'GET', query: {}, headers: {}, body: {} }, res);
    assert.equal(out.code, 503);
    assert.ok(out.body && typeof out.body === 'object', 'a JSON body is always served');
    assert.equal(out.body.ready, false);
    assert.ok(out.body.checks.every((c) => !c.ok), 'the throw surfaced as failing rows');
  } finally { fake.from = realFrom; }
});

test('missing table fails loudly in the gate shape', async () => {
  fake.reset();
  for (const t of ['tenants']) fake.seed(t, []);
  fake.failRead('bookings', 'relation "public.bookings" does not exist');
  const [out, res] = makeRes();
  await calendarHandler({ method: 'GET', query: {}, headers: {}, body: {} }, res);
  assert.equal(out.code, 503);
  assert.equal(out.body.ready, false);
  assert.ok(out.body.missing.includes('bookings'));
});

test('execution-health derives from the one manifest and keeps its shape', async () => {
  fake.reset();
  // The fake treats unseeded tables as hard errors, so seed every manifest
  // member (execution-health probes REQUIRED_TABLES + conversations/messages).
  const { REQUIRED_TABLES } = await import('../api/lib/schema-gate.js');
  for (const t of [...REQUIRED_TABLES, 'conversations', 'messages']) fake.seed(t, []);
  const [out, res] = makeRes();
  await executionHandler({ method: 'GET', query: {}, headers: {}, body: {} }, res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.execution_route, '/api/lola-execute');
  assert.equal(out.body.crm_route, '/api/crm');
  assert.ok(out.body.results.tenants.ok, 'REQUIRED_TABLES members are probed');
  assert.ok(out.body.results.conversations, 'execution-only extras still probed');
  for (const t of REQUIRED_TABLES) assert.ok(t in out.body.results, `${t} probed from the one manifest`);
});

test('telecom-health keeps its shape and reports reachability via the shared gate', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{"data":[]}' });
  try {
    const [out, res] = makeRes();
    await telecomHandler({ method: 'GET', query: {}, headers: {}, body: {} }, res);
    assert.equal(out.code, 200);
    assert.equal(out.body.ok, true);
    assert.equal(out.body.telnyx, 'reachable');
    assert.equal(out.body.configuration.api_key, true);
  } finally { globalThis.fetch = realFetch; }
});

test('healthSend turns a gate result into a real response — never an empty body', async () => {
  const [out, res] = makeRes();
  gate.healthSend(res, null);
  assert.equal(out.code, 503);
  assert.deepEqual(out.body, { ok: false, error: 'health check returned nothing' });
  const [out2, res2] = makeRes();
  gate.healthSend(res2, { ok: false, error: 'x' });
  assert.equal(out2.code, 503);
  const [out3, res3] = makeRes();
  gate.healthSend(res3, { ok: true });
  assert.equal(out3.code, 200);
});

test('the ONE SMS owner: exactly one file in api/ may POST to /v2/messages', async () => {
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      let stat;
      try { stat = statSync(p); } catch { continue; }
      if (stat.isDirectory()) walk(p);
      else if (name.endsWith('.js') && readFileSync(p, 'utf8').includes('v2/messages')) offenders.push(p);
    }
  };
  walk(join(API_ROOT, 'api'));
  const normalized = offenders.map((p) => relative(API_ROOT, p));
  assert.deepEqual(normalized, ['api/lib/sms.js'],
    'only api/lib/sms.js may send — found: ' + offenders.join(', '));
});

test('every send rides the owner with the bearer in the header, key never in the body', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), headers: opts.headers, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ data: { id: 'msg-1' } }) };
  };
  const { sendSms, sendAutopilotSms } = await import('../api/lib/sms.js');
  try {
    await sendSms({ from: '+15550001111', to: '+15550002222', text: 'hello', tenantId: 't1' });
    await sendSms({ from: '+15550001111', to: '+15550002222', text: 'hi wa', tenantId: 't1', type: 'WHATSAPP' });
    const ap = await sendAutopilotSms({ from: '+15550001111', to: '+15550002222', text: 'recovered', tenantId: 't1' });
    assert.equal(ap.sent, true);
    assert.equal(calls.length, 3);
    for (const c of calls) {
      assert.equal(c.url, 'https://api.telnyx.com/v2/messages');
      assert.equal(c.headers.Authorization, 'Bearer KEY01_TESTKEY_NOT_REAL');
      assert.equal(JSON.stringify(c.body).includes('KEY01'), false, 'key never in the body');
    }
    assert.ok(calls[1].body.whatsapp_message, 'WhatsApp payload used');
    assert.ok(calls[0].body.text, 'SMS payload uses text');
  } finally { globalThis.fetch = realFetch; }
});

test('sendAutopilotSms keeps its skipped/reason contract through the owner', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  const { sendAutopilotSms } = await import('../api/lib/sms.js');
  try {
    const r = await sendAutopilotSms({ from: '+15550001111', to: '+15550002222', text: 'x' });
    assert.equal(r.skipped, true);
    assert.ok(r.reason);
    const r2 = await sendAutopilotSms({ from: '', to: '+15550002222', text: 'x' });
    assert.equal(r2.skipped, true);
    assert.match(r2.reason, /missing from\/to/);
    const saved = process.env.TELNYX_API_KEY;
    delete process.env.TELNYX_API_KEY;
    const r3 = await sendAutopilotSms({ from: '+15550001111', to: '+15550002222', text: 'x' });
    process.env.TELNYX_API_KEY = saved;
    assert.equal(r3.skipped, true);
    assert.match(r3.reason, /TELNYX_API_KEY not set/);
  } finally { globalThis.fetch = realFetch; }
});
