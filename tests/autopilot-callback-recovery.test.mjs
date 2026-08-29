/**
 * tests/autopilot-callback-recovery.test.mjs — callback-recovery autopilot
 * agent (api/lib/autopilot.js). Lola ORIGINATES a call back from the salon's
 * own line to callers who rang and weren't served, via the shared
 * originate core (api/lib/call-callback.js).
 *
 * Run:
 *   node tests/autopilot-callback-recovery.test.mjs
 *
 * Exercises the REAL agent runner against the in-memory fake DB with Telnyx
 * stubbed via global fetch: unserved → called back, served → skipped, cooldown,
 * no primary line, opt-out, and per-call memory dedup.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSupabase } from './fake-supabase.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Stub @supabase/supabase-js so db() returns the fake.
const STUB_DIR = join(API_ROOT, 'node_modules', '@supabase', 'supabase-js');
mkdirSync(STUB_DIR, { recursive: true });
writeFileSync(join(STUB_DIR, 'package.json'), JSON.stringify({
  name: '@supabase/supabase-js', version: '0.0.0-test', type: 'module',
  main: 'index.js', exports: { '.': './index.js' }
}, null, 2));
writeFileSync(join(STUB_DIR, 'index.js'), [
  '// Generated test double — see tests/autopilot-callback-recovery.test.mjs',
  'export function createClient() {',
  "  const fake = globalThis.__LOLA_FAKE_SUPABASE__;",
  "  if (!fake) throw new Error('No fake Supabase registered');",
  '  return fake;',
  '}', ''
].join('\n'));

const fake = new FakeSupabase();
globalThis.__LOLA_FAKE_SUPABASE__ = fake;
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'fake-service-key';
process.env.TELNYX_API_KEY = 'test-telnyx-key';
process.env.TELNYX_LOLA_BRAIN_ID = 'assistant-lola';
delete process.env.TELNYX_VOICE_APP_ID;

const { runAutopilot, AUTOPILOT_AGENT_ORDER } = await import('../api/lib/autopilot.js');

const T1 = '11111111-1111-1111-1111-111111111111'; // has line, autopilot on
const T2 = '22222222-2222-2222-2222-222222222222'; // no line
const T3 = '33333333-3333-3333-3333-333333333333'; // autopilot paused
const LINE_1 = '+19294568227';

const NOW = new Date('2026-08-27T12:00:00Z').getTime();

let telnyxCalls = [];
const realFetch = globalThis.fetch;
function stubTelnyx({ fail = false } = {}) {
  telnyxCalls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const respond = (payload, status = 200) => ({
      ok: status < 400, status,
      text: async () => JSON.stringify(payload),
      json: async () => JSON.parse(JSON.stringify(payload))
    });
    if (u.includes('/v2/calls') && (opts.method === 'POST')) {
      telnyxCalls.push({ url: u, body: JSON.parse(opts.body || '{}') });
      if (fail) return respond({ errors: [{ detail: 'Simulated Telnyx rejection' }] }, 422);
      return respond({ data: { call_control_id: 'v3:cbcat-1', id: 'v3:cbcat-1' } });
    }
    if (u.includes('/v2/phone_numbers')) {
      return respond({ data: [{ phone_number: '+19294568227', connection_id: 'CONN-BRAIN' }] });
    }
    if (u.includes('/v2/ai/assistants/')) {
      return respond({ telephony_settings: { default_texml_app_id: 'CONN-CANON' } });
    }
    return realFetch(url, opts);
  };
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}

function seed() {
  fake.reset();
  fake.seed('tenants', [
    { id: T1, slug: 'mma', name: 'MMΛ Salon', phone_number: LINE_1, plan: 'pro', billing_status: 'active', autopilot_enabled: true },
    { id: T2, slug: 'bloom', name: 'Bloom', phone_number: null, autopilot_enabled: true },
    { id: T3, slug: 'paused', name: 'Paused', phone_number: LINE_1, autopilot_enabled: false }
  ]);
  fake.seed('tenant_numbers', [
    { tenant_id: T1, phone_number: LINE_1, kind: 'primary', status: 'active', connection_id: 'CONN-BRAIN' }
  ]);
  fake.seed('usage_events', []);
  const iso = (ms) => new Date(ms).toISOString();
  fake.seed('calls', [
    // Unserved: missed, zero duration.
    { id: 'call-missed-1', tenant_id: T1, direction: 'inbound', from_number: '+14155550123', status: 'missed', duration_seconds: 0, created_at: iso(NOW - 3600e3) },
    // Served: answered, has duration.
    { id: 'call-served', tenant_id: T1, direction: 'inbound', from_number: '+14155550999', status: 'completed', duration_seconds: 120, created_at: iso(NOW - 7200e3) }
  ]);
  fake.seed('client_memories', []);
  fake.seed('agent_runs', []);
}

test('unserved callers are called back; served callers are not', async () => {
  seed(); stubTelnyx();
  const res = await runAutopilot(fake, { agents: ['callback-recovery'], now: NOW });
  assert.equal(res.ok, true);
  const run = res.runs.find(r => r.agent === 'callback-recovery');
  assert.equal(run.status, 'success');
  // Exactly one originate, to the missed caller, from the salon line.
  assert.equal(telnyxCalls.length, 1);
  assert.equal(telnyxCalls[0].body.to, '+14155550123');
  assert.equal(telnyxCalls[0].body.from, LINE_1);
  // Memory dedup recorded for the call id.
  const mem = fake.all('client_memories');
  assert.ok(mem.some(m => m.key === 'callback:call-missed-1'));
  // Usage logged.
  assert.ok(fake.all('usage_events').some(e => e.kind === 'callback_recovered'));
  // Cooldown stamp set.
  const t1 = fake.all('tenants').find(t => t.id === T1);
  assert.ok(t1.callback_sent_at);
  // Served caller (call-served) produced no originate.
  assert.ok(telnyxCalls.every(c => c.body.to !== '+14155550999'));
  restoreFetch();
});

test('cooldown: a tenant with a recent callback_sent_at is skipped', async () => {
  seed(); stubTelnyx();
  const t1 = fake.all('tenants').find(t => t.id === T1);
  t1.callback_sent_at = new Date(NOW - 3600e3).toISOString(); // 1h ago < 6h
  const res = await runAutopilot(fake, { agents: ['callback-recovery'], now: NOW });
  const run = res.runs.find(r => r.agent === 'callback-recovery');
  assert.equal(run.status, 'skipped');
  assert.equal(telnyxCalls.length, 0);
  restoreFetch();
});

test('no primary line: tenant skipped with a reason, others still processed', async () => {
  seed(); stubTelnyx();
  // Give T1 an unserved caller but no line (remove tenant_numbers row + phone).
  fake.seed('tenant_numbers', []);
  const t1 = fake.all('tenants').find(t => t.id === T1);
  t1.phone_number = null;
  const res = await runAutopilot(fake, { agents: ['callback-recovery'], now: NOW });
  const run = res.runs.find(r => r.agent === 'callback-recovery');
  // No originations possible (no line anywhere) — a skip action is recorded.
  assert.equal(telnyxCalls.length, 0);
  assert.equal(run.status, 'partial');
  restoreFetch();
});

test('opted-out caller is skipped (no originate)', async () => {
  seed(); stubTelnyx();
  fake.seed('clients', [
    { id: 'cli-1', tenant_id: T1, phone: '+14155550123', opted_out: true }
  ]);
  const res = await runAutopilot(fake, { agents: ['callback-recovery'], now: NOW });
  const run = res.runs.find(r => r.agent === 'callback-recovery');
  assert.equal(telnyxCalls.length, 0);
  assert.equal(run.status, 'partial'); // a skip action is recorded
  restoreFetch();
});

test('per-call memory dedup: a previously-called-back call is not called again', async () => {
  seed(); stubTelnyx();
  fake.seed('client_memories', [
    { tenant_id: T1, client_phone: 'autopilot:', key: 'callback:call-missed-1', value: new Date(NOW).toISOString(), created_at: new Date(NOW).toISOString() }
  ]);
  const res = await runAutopilot(fake, { agents: ['callback-recovery'], now: NOW });
  const run = res.runs.find(r => r.agent === 'callback-recovery');
  assert.equal(telnyxCalls.length, 0);
  assert.equal(run.status, 'skipped');
  restoreFetch();
});

test('announced in the canonical agent registry/order', () => {
  assert.ok(AUTOPILOT_AGENT_ORDER.includes('callback-recovery'));
});