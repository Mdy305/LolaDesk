/**
 * tests/autopilot-notices.test.mjs — /api/autopilot-notices (the feed behind
 * the "Lola recovered 3 missed calls" live notification).
 *
 * Run:
 *   node tests/autopilot-notices.test.mjs
 *
 * Exercises the REAL handler against the in-memory fake DB: auth gating, and
 * tenant-scoping — the owner sees platform-wide runs (tenant_id NULL) plus
 * their own salon's runs, and NEVER another salon's runs.
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
  '// Generated test double — see tests/autopilot-notices.test.mjs',
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
process.env.APP_URL = 'https://www.loladesk.com';

const { default: handler } = await import('../api/autopilot-notices.js');

const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';
const HOUR_MS = 3600 * 1000;
const NOW = Date.now();

function seed() {
  fake.reset();
  fake.seed('tenants', [
    { id: T1, slug: 'salon-a', name: 'Salon A', owner_email: 'owner@salon-a.com' },
    { id: T2, slug: 'salon-b', name: 'Salon B', owner_email: 'owner@salon-b.com' }
  ]);
  fake.seed('agent_runs', [
    // Platform-wide run — everyone should see it.
    { id: 'r1', agent: 'routing-heal', tenant_id: null, status: 'success', summary: 'Reconciled 1 routing row with Telnyx', ran_at: new Date(NOW - 2 * HOUR_MS).toISOString() },
    // T1's own salon runs — owner A sees them.
    { id: 'r2', agent: 'missed-call-recovery', tenant_id: T1, status: 'success', summary: 'Recovered 3 missed call(s) with a follow-up text', ran_at: new Date(NOW - 1 * HOUR_MS).toISOString() },
    // Another salon's run — owner A must NEVER see it (per-tenant isolation).
    { id: 'r3', agent: 'rebooking', tenant_id: T2, status: 'success', summary: 'Invited 5 client(s) to rebook', ran_at: new Date(NOW - 30 * 60 * 1000).toISOString() },
    // Older than 24h — filtered out.
    { id: 'r4', agent: 'sync-self-heal', tenant_id: null, status: 'success', summary: 'Old run', ran_at: new Date(NOW - 25 * HOUR_MS).toISOString() }
  ]);
  fake.auth.users.set('tok-owner-a', { id: 'u1', email: 'owner@salon-a.com' });
  fake.auth.users.set('tok-owner-b', { id: 'u2', email: 'owner@salon-b.com' });
}

function makeRes() {
  const out = { code: 200, body: null };
  return [{
    setHeader() {},
    status(c) { out.code = c; return this; },
    json(o) { out.body = o; return o; },
    end() { out.code = out.code || 200; }
  }, out];
}
function getReq(token) {
  return { method: 'GET', query: {}, headers: token ? { Authorization: 'Bearer ' + token } : {}, body: undefined, url: '/api/autopilot-notices' };
}

test('auth gate: 401 without a token', async () => {
  seed();
  const [res, out] = makeRes();
  await handler(getReq(null), res);
  assert.equal(out.code, 401);
});

test('owner sees platform runs + own salon runs, never another salon\u2019s', async () => {
  seed();
  const [res, out] = makeRes();
  await handler(getReq('tok-owner-a'), res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  const ids = out.body.runs.map(r => r.id);
  assert.deepEqual(ids.sort(), ['r1', 'r2']); // r3 (other salon) and r4 (stale) excluded
  const recovery = out.body.runs.find(r => r.id === 'r2');
  assert.equal(recovery.agent, 'missed-call-recovery');
  assert.match(recovery.summary, /3 missed call/);
});

test('each salon sees only its own per-tenant runs', async () => {
  seed();
  const [res, out] = makeRes();
  await handler(getReq('tok-owner-b'), res);
  assert.equal(out.code, 200);
  const ids = out.body.runs.map(r => r.id).sort();
  assert.deepEqual(ids, ['r1', 'r3']); // platform run + their own rebooking run — never owner A's
});
