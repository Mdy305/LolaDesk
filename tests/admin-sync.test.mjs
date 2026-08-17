/**
 * tests/admin-sync.test.mjs — the /api/admin/sync booking-sync health panel.
 *
 * Run:
 *   node tests/admin-sync.test.mjs
 *
 * Exercises the REAL handler against the in-memory fake DB: admin gating,
 * per-tenant status derivation (ok / stale / error / never), cache counts,
 * and the 7-day error tally.
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
  '// Generated test double — see tests/admin-sync.test.mjs',
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

const { default: handler } = await import('../api/admin/sync.js');

const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';
const T3 = '33333333-3333-3333-3333-333333333333';

function seed(){
  fake.reset();
  const now = Date.now();
  const iso = ms => new Date(now - ms).toISOString();
  fake.seed('tenants', [
    { id: T1, slug: 'salon-a', name: 'Salon A', plan: 'pro', billing_status: 'active' },
    { id: T2, slug: 'salon-b', name: 'Salon B', plan: 'starter', billing_status: 'trial' },
    { id: T3, slug: 'salon-c', name: 'Salon C', plan: 'starter', billing_status: 'trial' }
  ]);
  fake.seed('booking_sync_log', [
    // T1: healthy run 5 minutes ago, no errors
    { tenant_id: T1, provider: 'vagaro,square', kind: 'availability', fetched: 12, upserted: 12, stale_removed: 1, error_message: null, created_at: iso(5 * 60000) },
    // T1: an older error run (still inside 7d) — should count in error_count_7d
    { tenant_id: T1, provider: 'vagaro', kind: 'availability', fetched: 0, upserted: 0, stale_removed: 0, error_message: 'ECONNRESET', created_at: iso(2 * 86400000) },
    // T2: errored run 10 minutes ago (latest = error)
    { tenant_id: T2, provider: 'square', kind: 'availability', fetched: 3, upserted: 0, stale_removed: 0, error_message: '401 unauthorized', created_at: iso(10 * 60000) },
    // T3: stale — last sync 3 days ago
    { tenant_id: T3, provider: 'fresha', kind: 'availability', fetched: 5, upserted: 5, stale_removed: 0, error_message: null, created_at: iso(3 * 86400000) }
  ]);
  fake.seed('cached_availability', [
    { tenant_id: T1 }, { tenant_id: T1 }, { tenant_id: T2 }
  ]);
}

function call(req){
  const res = {};
  res.statusCode = 200;
  res._json = null;
  res.setHeader = () => {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res._json = obj; return res; };
  return handler(req, res).then(() => ({ status: res.statusCode, json: res._json }));
}

test('rejects non-admin', async () => {
  seed();
  fake.auth.users.set('tok-admin', { id: 'u1', email: 'boss@loladesk.com' });
  fake.auth.users.set('tok-user', { id: 'u2', email: 'salon@example.com' });
  process.env.ADMIN_EMAILS = 'boss@loladesk.com';
  const ok = await call({ method: 'GET', headers: { authorization: 'Bearer tok-admin' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  const denied = await call({ method: 'GET', headers: { authorization: 'Bearer tok-user' } });
  assert.equal(denied.status, 403);
  const anon = await call({ method: 'GET', headers: {} });
  assert.equal(anon.status, 401);
});

test('derives per-tenant status: ok / error / stale / never', async () => {
  seed();
  fake.auth.users.set('tok-admin', { id: 'u1', email: 'boss@loladesk.com' });
  process.env.ADMIN_EMAILS = 'boss@loladesk.com';
  const { status, json } = await call({ method: 'GET', headers: { authorization: 'Bearer tok-admin' } });
  assert.equal(status, 200);
  assert.equal(json.ok, true);

  const byId = Object.fromEntries(json.tenants.map(t => [t.id, t]));

  // T1: latest run is healthy and recent -> ok
  assert.equal(byId[T1].status, 'ok');
  assert.equal(byId[T1].cached_appointments, 2);
  assert.equal(byId[T1].error_count_7d, 1);       // the older ECONNRESET counts
  assert.equal(byId[T1].last_sync_age_min <= 6, true);

  // T2: latest run errored -> error
  assert.equal(byId[T2].status, 'error');
  assert.match(byId[T2].error, /401/);
  assert.equal(byId[T2].cached_appointments, 1);
  assert.equal(byId[T2].error_count_7d, 1);

  // T3: last sync 3 days ago (no error) -> stale
  assert.equal(byId[T3].status, 'stale');
  assert.equal(byId[T3].cached_appointments, 0);

  // counts roll up correctly
  assert.equal(json.counts.synced, 1);
  assert.equal(json.counts.erroring, 1);
  assert.equal(json.counts.stale, 1);
  assert.equal(json.counts.never, 0);
});

test('tenants with no sync logs are "never"', async () => {
  seed();
  fake.seed('booking_sync_log', []);   // no logs at all
  fake.auth.users.set('tok-admin', { id: 'u1', email: 'boss@loladesk.com' });
  process.env.ADMIN_EMAILS = 'boss@loladesk.com';
  const { json } = await call({ method: 'GET', headers: { authorization: 'Bearer tok-admin' } });
  assert.equal(json.counts.never, 3);
  assert.ok(json.tenants.every(t => t.status === 'never' && t.last_sync_at === null));
});
