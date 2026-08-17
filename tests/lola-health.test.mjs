/**
 * tests/lola-health.test.mjs — /api/admin/lola-health live routing panel.
 *
 * Run:
 *   node tests/lola-health.test.mjs
 *
 * Exercises the REAL handler against the in-memory fake DB (auth only) with
 * the Telnyx API stubbed via global fetch: admin gating, agent attached,
 * voice-connection matching, active calls, and graceful degradation when a
 * probe fails.
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
  '// Generated test double — see tests/lola-health.test.mjs',
  'export function createClient() {',
  "  const fake = globalThis.__LOLA_FAKE_SUPABASE__;",
  "  if (!fake) throw new Error('No fake Supabase registered');",
  '  return fake;',
  '}',
  ''
].join('\n'));

const fake = new FakeSupabase();
globalThis.__LOLA_FAKE_SUPABASE__ = fake;
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'fake-service-key';
process.env.TELNYX_API_KEY = 'test-telnyx-key';
process.env.TELNYX_VOICE_APP_ID = 'CONN-LOLA';
process.env.ADMIN_EMAILS = 'boss@loladesk.com';

const { default: handler } = await import('../api/admin/lola-health.js');

function seed() {
  fake.reset();
  fake.auth.users.set('tok-admin', { id: 'u1', email: 'boss@loladesk.com' });
  fake.auth.users.set('tok-user', { id: 'u2', email: 'salon@example.com' });
}

function json(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300, status,
    text: async () => JSON.stringify(payload),
    json: async () => payload
  };
}

// Telnyx API stub — routes by path. `failPaths` lets a test make one probe
// error out so we can assert graceful degradation.
function stubTelnyx(failPaths = []) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('api.telnyx.com')) throw new Error('unexpected non-Telnyx call: ' + u);
    const path = u.replace('https://api.telnyx.com/v2', '').split('?')[0];

    if (failPaths.includes(path)) return json({ errors: [{ detail: 'forbidden' }] }, 403);

    if (path === '/ai/assistants') return json({ data: [
      { id: 'A1', name: 'Lola — Salon A', model: 'meta-llama/Llama-3.3-70B-Instruct', voice_settings: { voice: 'Polly.Joanna-Neural' }, created_at: '2026-08-01T00:00:00Z' }
    ] });
    if (path === '/phone_numbers') return json({ data: [
      { id: 'PN1', phone_number: '+13055550100', status: 'active', connection_id: 'CONN-LOLA' },
      { id: 'PN2', phone_number: '+13055550101', status: 'active', connection_id: 'CONN-OTHER' }
    ] });
    if (path === '/connections/CONN-LOLA/active_calls') return json({ data: [
      { call_control_id: 'v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg', call_leg_id: 'leg-1', call_session_id: 'sess-1', call_duration: 42 }
    ] });
    throw new Error('unmocked Telnyx path: ' + path);
  };
  return { realFetch };
}

function call(req) {
  const res = {};
  res.statusCode = 200;
  res._json = null;
  res.setHeader = () => {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res._json = obj; return res; };
  res.end = () => {};
  return handler(req, res).then(() => ({ status: res.statusCode, json: res._json }));
}

test('rejects anonymous and non-admin users', async () => {
  seed();
  const t = stubTelnyx();
  try {
    const anon = await call({ method: 'GET', headers: {} });
    assert.equal(anon.status, 401);

    const denied = await call({ method: 'GET', headers: { authorization: 'Bearer tok-user' } });
    assert.equal(denied.status, 403);
  } finally { globalThis.fetch = t.realFetch; }
});

test('rejects non-GET methods', async () => {
  seed();
  const t = stubTelnyx();
  try {
    const r = await call({ method: 'POST', headers: { authorization: 'Bearer tok-admin' } });
    assert.equal(r.status, 405);
  } finally { globalThis.fetch = t.realFetch; }
});

test('reports agent attached, voice wiring, and active calls', async () => {
  seed();
  const t = stubTelnyx();
  try {
    const { status, json: j } = await call({ method: 'GET', headers: { authorization: 'Bearer tok-admin' } });
    assert.equal(status, 200);
    assert.equal(j.ok, true);
    assert.ok(j.generated_at);

    // Agent attached
    assert.equal(j.agent.exists, true);
    assert.equal(j.agent.count, 1);
    assert.equal(j.agent.assistants[0].name, 'Lola — Salon A');
    assert.equal(j.agent.assistants[0].voice, 'Polly.Joanna-Neural');
    assert.equal(j.agent.error, null);

    // Voice connection: 2 numbers, 2 attached, 1 on Lola's connection
    assert.equal(j.voice.expected_connection_id, 'CONN-LOLA');
    assert.deepEqual(j.voice.counts, { total: 2, attached: 2, matching: 1 });
    const byPhone = Object.fromEntries(j.voice.numbers.map(n => [n.phone_number, n]));
    assert.equal(byPhone['+13055550100'].matches_expected, true);
    assert.equal(byPhone['+13055550101'].matches_expected, false);

    // Active calls
    assert.equal(j.calls.connection_id, 'CONN-LOLA');
    assert.equal(j.calls.active, 1);
    assert.equal(j.calls.calls[0].call_duration, 42);
    assert.equal(j.calls.error, null);
  } finally { globalThis.fetch = t.realFetch; }
});

test('degrades gracefully when a probe fails', async () => {
  seed();
  const t = stubTelnyx(['/ai/assistants']);
  try {
    const { status, json: j } = await call({ method: 'GET', headers: { authorization: 'Bearer tok-admin' } });
    assert.equal(status, 200);
    assert.equal(j.ok, true);

    // The failed probe reports an error but the others still populate.
    assert.equal(j.agent.exists, false);
    assert.equal(j.agent.count, 0);
    assert.match(j.agent.error, /forbidden/);

    assert.equal(j.voice.counts.matching, 1);
    assert.equal(j.calls.active, 1);
  } finally { globalThis.fetch = t.realFetch; }
});

test('reports the missing-env case for active calls', async () => {
  seed();
  delete process.env.TELNYX_VOICE_APP_ID;
  const t = stubTelnyx();
  try {
    const { json: j } = await call({ method: 'GET', headers: { authorization: 'Bearer tok-admin' } });
    assert.equal(j.calls.active, 0);
    assert.match(j.calls.error, /TELNYX_VOICE_APP_ID/);
    assert.equal(j.voice.expected_connection_id, null);
  } finally {
    globalThis.fetch = t.realFetch;
    process.env.TELNYX_VOICE_APP_ID = 'CONN-LOLA';
  }
});
