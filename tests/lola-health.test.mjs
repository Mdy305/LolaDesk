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
      { id: 'A1', name: 'Lola — Salon A', model: 'meta-llama/Llama-3.3-70B-Instruct', voice_settings: { voice: 'elevenlabs:lola-canonical' }, created_at: '2026-08-01T00:00:00Z' },
      { id: 'A2', name: 'LolaBrain', model: 'moonshotai/Kimi-K2.6', voice_settings: { voice: 'elevenlabs:lola-canonical' }, created_at: '2026-08-02T00:00:00Z' }
    ] });
    if (path === '/connections') return json({ data: [
      { id: 'CONN-LOLA', connection_name: 'LolaDesk' },
      { id: 'CONN-OTHER', connection_name: 'ai-assistant-a0d68' }
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

    // Agent attached (the stub lists Lola + the LolaBrain assistant)
    assert.equal(j.agent.exists, true);
    assert.equal(j.agent.count, 2);
    assert.equal(j.agent.assistants[0].name, 'Lola — Salon A');
    assert.equal(j.agent.assistants[0].voice, 'elevenlabs:lola-canonical');
    assert.equal(j.agent.error, null);

    // Voice connection: 2 numbers, 2 attached, 1 on Lola's connection
    assert.equal(j.voice.expected_connection_id, 'CONN-LOLA');
    assert.deepEqual(j.voice.counts, { total: 2, attached: 2, matching: 1, known_good: 1 });
    const byPhone = Object.fromEntries(j.voice.numbers.map(n => [n.phone_number, n]));
    assert.equal(byPhone['+13055550100'].matches_expected, true);
    assert.equal(byPhone['+13055550100'].known_good, true);
    assert.equal(byPhone['+13055550100'].connection_name, 'LolaDesk');
    assert.equal(byPhone['+13055550101'].matches_expected, false);
    assert.equal(byPhone['+13055550101'].known_good, false);
    assert.equal(byPhone['+13055550101'].connection_name, 'ai-assistant-a0d68');

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

test('routing compares against LIVE Telnyx attachments, not a single constant', async () => {
  seed();
  fake.seed('tenant_numbers', [
    // Recorded id matches live attachment → ok, even though it's NOT the
    // voice app constant (it's the LolaBrain assistant — a known-good path).
    { id: 'tn1', phone_number: '+13055550100', tenant_id: 't1', kind: 'primary', status: 'active', connection_id: 'A2', tenants: { name: 'Salon A', slug: 'salon-a' } },
    // Recorded id differs from the live attachment → real drift, flagged.
    { id: 'tn2', phone_number: '+13055550101', tenant_id: 't2', kind: 'primary', status: 'active', connection_id: 'CONN-LOLA', tenants: { name: 'Salon B', slug: 'salon-b' } },
    // Recorded id matches live attachment (the ai-assistant connection) → ok.
    { id: 'tn3', phone_number: '+13055550102', tenant_id: 't3', kind: 'forwarded', status: 'active', connection_id: 'CONN-OTHER', tenants: { name: 'Salon C', slug: 'salon-c' } }
  ]);
  const t = stubTelnyx();
  // Make the live snapshot know +13055550102 is on CONN-OTHER.
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const path = u.replace('https://api.telnyx.com/v2', '').split('?')[0];
    if (path === '/phone_numbers') return json({ data: [
      { id: 'PN1', phone_number: '+13055550100', status: 'active', connection_id: 'A2' },
      { id: 'PN2', phone_number: '+13055550101', status: 'active', connection_id: 'CONN-OTHER' },
      { id: 'PN3', phone_number: '+13055550102', status: 'active', connection_id: 'CONN-OTHER' }
    ] });
    if (path === '/connections') return json({ data: [
      { id: 'CONN-LOLA', connection_name: 'LolaDesk' },
      { id: 'CONN-OTHER', connection_name: 'ai-assistant-a0d68' },
      { id: 'A2', connection_name: 'LolaBrain' }
    ] });
    if (path === '/ai/assistants') return json({ data: [
      { id: 'A1', name: 'Lola — Salon A' }, { id: 'A2', name: 'LolaBrain' }
    ] });
    if (path === '/connections/CONN-LOLA/active_calls') return json({ data: [] });
    throw new Error('unmocked Telnyx path: ' + path);
  };
  try {
    const { status, json: j } = await call({ method: 'GET', headers: { authorization: 'Bearer tok-admin' } });
    assert.equal(status, 200);
    const byPhone = Object.fromEntries(j.routing.numbers.map(n => [n.phone_number, n]));
    // +13055550100: recorded 'A2' == live 'A2' → ok, name resolved.
    assert.equal(byPhone['+13055550100'].flag, 'ok');
    assert.equal(byPhone['+13055550100'].connection_name, 'LolaBrain');
    // +13055550101: recorded 'CONN-LOLA' but live says 'CONN-OTHER' → mismatch.
    assert.equal(byPhone['+13055550101'].flag, 'mismatch');
    assert.equal(byPhone['+13055550101'].live_connection_id, 'CONN-OTHER');
    // +13055550102: recorded 'CONN-OTHER' == live 'CONN-OTHER' → ok (NOT flagged
    // just because it isn't the voice-app constant).
    assert.equal(byPhone['+13055550102'].flag, 'ok');
    assert.equal(j.routing.counts.ok, 2);
    assert.equal(j.routing.counts.flagged, 1);
  } finally { globalThis.fetch = t.realFetch; }
});

test('flags tenant_numbers with missing or rejected-legacy connection ids', async () => {
  seed();
  fake.seed('tenant_numbers', [
    { id: 'tn1', phone_number: '+13055550100', tenant_id: 't1', kind: 'primary', status: 'active', connection_id: 'CONN-LOLA', tenants: { name: 'Salon A', slug: 'salon-a' } },
    { id: 'tn2', phone_number: '+13055550101', tenant_id: 't2', kind: 'primary', status: 'active', connection_id: '2991758319724529273', tenants: { name: 'Salon B', slug: 'salon-b' } },
    { id: 'tn3', phone_number: '+13055550102', tenant_id: 't3', kind: 'forwarded', status: 'active', connection_id: null, tenants: { name: 'Salon C', slug: 'salon-c' } }
  ]);
  const t = stubTelnyx();
  try {
    const { status, json: j } = await call({ method: 'GET', headers: { authorization: 'Bearer tok-admin' } });
    assert.equal(status, 200);
    assert.deepEqual(j.routing.counts, { total: 3, ok: 1, flagged: 2, by_flag: { ok: 1, rejected_legacy: 1, missing: 1 } });
    const byPhone = Object.fromEntries(j.routing.numbers.map(n => [n.phone_number, n]));
    // Working connection → ok; the dead 'upgrade' target → rejected_legacy;
    // never-recorded → missing.
    assert.equal(byPhone['+13055550100'].flag, 'ok');
    assert.equal(byPhone['+13055550101'].flag, 'rejected_legacy');
    assert.equal(byPhone['+13055550102'].flag, 'missing');
    assert.equal(byPhone['+13055550100'].tenant_name, 'Salon A');
  } finally { globalThis.fetch = t.realFetch; }
});

test('handles a missing tenant_numbers table gracefully', async () => {
  seed();
  const t = stubTelnyx();
  try {
    const { status, json: j } = await call({ method: 'GET', headers: { authorization: 'Bearer tok-admin' } });
    assert.equal(status, 200);
    // No routing rows seeded → empty report, not a 500.
    assert.deepEqual(j.routing.counts, { total: 0, ok: 0, flagged: 0, by_flag: {} });
    assert.deepEqual(j.routing.numbers, []);
  } finally { globalThis.fetch = t.realFetch; }
});

test('uses TELNYX_VOICE_APP_ID verbatim (legacy app id is NOT rewritten)', async () => {
  seed();
  process.env.TELNYX_VOICE_APP_ID = '2982432232334951429'; // the working app
  const t = stubTelnyx();
  try {
    const { json: j } = await call({ method: 'GET', headers: { authorization: 'Bearer tok-admin' } });
    // Live probing proved this id is the working Call Control app and the
    // old rewrite target (2991758319724529273) is rejected by Telnyx.
    assert.equal(j.voice.expected_connection_id, '2982432232334951429');
    assert.equal(j.calls.connection_id, '2982432232334951429');
  } finally {
    globalThis.fetch = t.realFetch;
    process.env.TELNYX_VOICE_APP_ID = 'CONN-LOLA';
  }
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
