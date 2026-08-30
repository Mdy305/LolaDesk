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

// ── POST: one-click "Sync now" ────────────────────────────────────
// The fake stores integration tokens in legacy plaintext; db.js decrypt()
// passes those through but logs a loud console.error. Silence it around the
// calls that read integrations so the test output stays readable.
async function quietAsync(fn){
  const orig = console.error;
  console.error = () => {};
  try{ return await fn(); }finally{ console.error = orig; }
}

function callPost(req){
  const res = {};
  res.statusCode = 200;
  res._json = null;
  res.setHeader = () => {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res._json = obj; return res; };
  return handler(req, res).then(() => ({ status: res.statusCode, json: res._json }));
}

test('POST syncs a single tenant and returns the live result + refreshed snapshot', async () => {
  seed();
  // Give T1 a connected Vagaro integration so the sync has something to poll.
  fake.seed('integrations', [
    { tenant_id: T1, provider: 'vagaro', status: 'connected', access_token: 'legacy-plaintext', refresh_token: null }
  ]);
  const start = new Date(Date.now() + 2 * 864e5).toISOString();
  const end = new Date(new Date(start).getTime() + 60 * 60000).toISOString();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.ok(String(url).includes('api.vagaro.com'), `expected vagaro call, got ${url}`);
    return { ok: true, status: 200, json: async () => ({ appointments: [{ id: 'VAG-9', startDateTime: start, endDateTime: end, duration: 60, customerName: 'Sarah', serviceTitle: 'Balayage', serviceProviderName: 'Mia', status: 'confirmed' }] }) };
  };

  fake.auth.users.set('tok-admin', { id: 'u1', email: 'boss@loladesk.com' });
  process.env.ADMIN_EMAILS = 'boss@loladesk.com';

  try{
    const { status, json } = await quietAsync(() => callPost({
      method: 'POST',
      headers: { authorization: 'Bearer tok-admin', 'content-type': 'application/json' },
      body: JSON.stringify({ tenant_id: T1 })
    }));
    assert.equal(status, 200);
    assert.equal(json.ok, true);

    // live sync result
    assert.equal(json.sync.ok, true);
    assert.equal(json.sync.fetched, 1);
    assert.equal(json.sync.upserted, 1);

    // refreshed snapshot reflects the new run
    const byId = Object.fromEntries(json.tenants.map(t => [t.id, t]));
    assert.equal(byId[T1].status, 'ok');
    assert.equal(byId[T1].cached_appointments, 3);   // 2 seeded + 1 fresh
    assert.ok(byId[T1].last_sync_at);

    // audit row written
    const logs = fake.all('booking_sync_log');
    assert.ok(logs.some(l => l.tenant_id === T1 && l.fetched === 1));
  }finally{
    globalThis.fetch = realFetch;
  }
});

test('POST requires tenant_id and rejects unknown tenants', async () => {
  seed();
  fake.auth.users.set('tok-admin', { id: 'u1', email: 'boss@loladesk.com' });
  process.env.ADMIN_EMAILS = 'boss@loladesk.com';
  const missing = await quietAsync(() => callPost({
    method: 'POST', headers: { authorization: 'Bearer tok-admin' }, body: '{}'
  }));
  assert.equal(missing.status, 400);

  const unknown = await quietAsync(() => callPost({
    method: 'POST', headers: { authorization: 'Bearer tok-admin' },
    body: JSON.stringify({ tenant_id: '00000000-0000-0000-0000-000000000000' })
  }));
  assert.equal(unknown.status, 404);
});

test('POST is admin-gated like GET', async () => {
  seed();
  fake.auth.users.set('tok-user', { id: 'u2', email: 'salon@example.com' });
  process.env.ADMIN_EMAILS = 'boss@loladesk.com';
  const denied = await quietAsync(() => callPost({
    method: 'POST', headers: { authorization: 'Bearer tok-user' },
    body: JSON.stringify({ tenant_id: T1 })
  }));
  assert.equal(denied.status, 403);
});

// ── Drift check (read-only) ────────────────────────────────────────
function seedDrift(){
  seed();
  fake.seed('integrations', [
    { tenant_id: T1, provider: 'vagaro', status: 'connected', access_token: 'legacy-plaintext', refresh_token: null },
    { tenant_id: T1, provider: 'square', status: 'connected', access_token: 'legacy-plaintext', refresh_token: null }
  ]);
  // Cache holds 2 vagaro + 1 square rows; provider will report 5 vagaro + 1 square.
  fake.seed('cached_availability', [
    { tenant_id: T1, provider: 'vagaro', external_booking_id: 'VAG-1' },
    { tenant_id: T1, provider: 'vagaro', external_booking_id: 'VAG-2' },
    { tenant_id: T1, provider: 'square', external_booking_id: 'SQ-1' }
  ]);
  const start = new Date(Date.now() + 2 * 864e5).toISOString();
  const end = new Date(new Date(start).getTime() + 60 * 60000).toISOString();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if(String(url).includes('api.vagaro.com')){
      return { ok: true, status: 200, json: async () => ({ appointments: [0,1,2,3,4].map(i => ({ id: 'VAG-'+i, startDateTime: start, endDateTime: end, duration: 60 })) }) };
    }
    if(String(url).includes('connect.squareupsandbox.com') || String(url).includes('connect.squareup.com')){
      // Square's listAppointments does a two-step flow: locations -> bookings/search.
      if(String(url).includes('/v2/locations')){
        return { ok: true, status: 200, json: async () => ({ locations: [{ id: 'L1' }] }) };
      }
      return { ok: true, status: 200, json: async () => ({ bookings: [{ id: 'SQ-1', start_at: start, appointment_segments: [{ duration_minutes: 60 }] }] }) };
    }
    throw new Error('unexpected ' + url);
  };
  return realFetch;
}

test('drift action reports per-provider live vs cached counts', async () => {
  const realFetch = seedDrift();
  fake.auth.users.set('tok-admin', { id: 'u1', email: 'boss@loladesk.com' });
  process.env.ADMIN_EMAILS = 'boss@loladesk.com';
  try{
    const { status, json } = await quietAsync(() => callPost({
      method: 'POST', headers: { authorization: 'Bearer tok-admin' },
      body: JSON.stringify({ tenant_id: T1, action: 'drift' })
    }));
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.drift.ok, true);
    assert.equal(json.drift.accurate, false);
    assert.equal(json.drift.drifted, 1);

    const byProvider = Object.fromEntries(json.drift.providers.map(p => [p.provider, p]));
    assert.equal(byProvider.vagaro.provider_count, 5);
    assert.equal(byProvider.vagaro.cached_count, 2);
    assert.equal(byProvider.vagaro.drift, 3);          // cache is behind by 3
    assert.equal(byProvider.square.provider_count, 1);
    assert.equal(byProvider.square.cached_count, 1);
    assert.equal(byProvider.square.drift, 0);          // in sync
    assert.equal(json.drift.total_drift, 3);
  }finally{
    globalThis.fetch = realFetch;
  }
});

test('drift is read-only: it never writes to the cache or the audit log', async () => {
  const realFetch = seedDrift();
  fake.auth.users.set('tok-admin', { id: 'u1', email: 'boss@loladesk.com' });
  process.env.ADMIN_EMAILS = 'boss@loladesk.com';
  const beforeCache = fake.all('cached_availability').length;
  const beforeLogs = fake.all('booking_sync_log').length;
  try{
    await quietAsync(() => callPost({
      method: 'POST', headers: { authorization: 'Bearer tok-admin' },
      body: JSON.stringify({ tenant_id: T1, action: 'drift' })
    }));
    assert.equal(fake.all('cached_availability').length, beforeCache, 'drift must not change the cache');
    assert.equal(fake.all('booking_sync_log').length, beforeLogs, 'drift must not write audit logs');
  }finally{
    globalThis.fetch = realFetch;
  }
});

test('drift with no connected providers is a clean no-op', async () => {
  seed();   // no integrations
  fake.auth.users.set('tok-admin', { id: 'u1', email: 'boss@loladesk.com' });
  process.env.ADMIN_EMAILS = 'boss@loladesk.com';
  const { json } = await quietAsync(() => callPost({
    method: 'POST', headers: { authorization: 'Bearer tok-admin' },
    body: JSON.stringify({ tenant_id: T1, action: 'drift' })
  }));
  assert.equal(json.drift.skipped, true);
});

test('unknown action is rejected', async () => {
  seed();
  fake.auth.users.set('tok-admin', { id: 'u1', email: 'boss@loladesk.com' });
  process.env.ADMIN_EMAILS = 'boss@loladesk.com';
  const { status } = await quietAsync(() => callPost({
    method: 'POST', headers: { authorization: 'Bearer tok-admin' },
    body: JSON.stringify({ tenant_id: T1, action: 'explode' })
  }));
  assert.equal(status, 400);
});
