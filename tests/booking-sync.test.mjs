/**
 * tests/booking-sync.test.mjs — the Supabase Ingestion Engine (blueprint §2).
 *
 * Run:
 *   node tests/booking-sync.test.mjs
 *   node --test tests/
 *
 * Exercises the REAL lib/booking-sync.js + the real aggregator/connectors
 * against an in-memory Supabase stand-in (tests/fake-supabase.js) and a
 * mocked provider HTTP call. No network, no real DB.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSupabase } from './fake-supabase.js';

// ── provision the @supabase/supabase-js test double ────────────────
const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STUB_DIR = join(API_ROOT, 'node_modules', '@supabase', 'supabase-js');
mkdirSync(STUB_DIR, { recursive: true });
writeFileSync(join(STUB_DIR, 'package.json'), JSON.stringify({
  name: '@supabase/supabase-js',
  version: '0.0.0-test',
  type: 'module',
  main: 'index.js',
  exports: { '.': './index.js' }
}, null, 2));
writeFileSync(join(STUB_DIR, 'index.js'), [
  '// Generated test double — see tests/booking-sync.test.mjs',
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

const { syncTenantAvailability, SYNC_PROVIDERS } = await import('../api/lib/booking-sync.js');

const tenantA = { id: 'tenant-a', slug: 'salon-a', name: 'Salon A' };

// The fake stores integration tokens in legacy plaintext; db.js decrypt()
// passes those through but logs a loud console.error. Silence it.
async function quietAsync(fn){
  const orig = console.error;
  console.error = () => {};
  try{ return await fn(); }finally{ console.error = orig; }
}

function seedVagaro(appointments){
  fake.reset();
  fake.seed('integrations', [
    { tenant_id: tenantA.id, provider: 'vagaro', status: 'connected', access_token: 'legacy-plaintext', refresh_token: null }
  ]);
  fake.seed('cached_availability', []);
  fake.seed('booking_sync_log', []);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.ok(String(url).includes('api.vagaro.com'), `expected vagaro call, got ${url}`);
    return { ok: true, status: 200, json: async () => ({ appointments }) };
  };
  return realFetch;
}

test('SYNC_PROVIDERS covers the six writable/sync booking platforms', () => {
  for(const p of ['square', 'boulevard', 'vagaro', 'mindbody', 'fresha', 'google_calendar']){
    assert.ok(SYNC_PROVIDERS.includes(p), `missing ${p}`);
  }
  assert.ok(!SYNC_PROVIDERS.includes('shopify'), 'shopify is retail-only and must not be polled');
});

test('syncTenantAvailability upserts provider appointments into the cache', async () => {
  const start = new Date(Date.now() + 2 * 864e5).toISOString();
  const end = new Date(new Date(start).getTime() + 60 * 60000).toISOString();
  const realFetch = seedVagaro([
    { id: 'VAG-1', startDateTime: start, endDateTime: end, duration: 60, customerName: 'Sarah', serviceTitle: 'Balayage', serviceProviderName: 'Mia', status: 'confirmed' }
  ]);

  try{
    const r = await quietAsync(() => syncTenantAvailability(fake, tenantA.id));
    assert.equal(r.ok, true);
    assert.equal(r.fetched, 1);
    assert.equal(r.upserted, 1);

    const rows = fake.all('cached_availability');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tenant_id, tenantA.id);
    assert.equal(rows[0].provider, 'vagaro');
    assert.equal(rows[0].external_booking_id, 'VAG-1');
    assert.equal(rows[0].starts_at, start);
    assert.equal(rows[0].status, 'booked');
    assert.equal(rows[0].staff_id, 'Mia');
    assert.equal(rows[0].client_name, 'Sarah');

    // audit log row written
    const logs = fake.all('booking_sync_log');
    assert.equal(logs.length, 1);
    assert.equal(logs[0].tenant_id, tenantA.id);
    assert.equal(logs[0].fetched, 1);
    assert.equal(logs[0].upserted, 1);
  }finally{
    globalThis.fetch = realFetch;
  }
});

test('re-sync upserts instead of duplicating (onConflict tenant,provider,external_booking_id)', async () => {
  const start = new Date(Date.now() + 2 * 864e5).toISOString();
  const end = new Date(new Date(start).getTime() + 60 * 60000).toISOString();
  const realFetch = seedVagaro([
    { id: 'VAG-1', startDateTime: start, endDateTime: end, duration: 60, customerName: 'Sarah', serviceTitle: 'Balayage', serviceProviderName: 'Mia', status: 'confirmed' }
  ]);

  try{
    await quietAsync(() => syncTenantAvailability(fake, tenantA.id));
    await quietAsync(() => syncTenantAvailability(fake, tenantA.id));
    const rows = fake.all('cached_availability');
    assert.equal(rows.length, 1, 'same booking must not duplicate across syncs');
  }finally{
    globalThis.fetch = realFetch;
  }
});

test('stale rows the provider no longer lists are pruned', async () => {
  const start = new Date(Date.now() + 2 * 864e5).toISOString();
  const end = new Date(new Date(start).getTime() + 60 * 60000).toISOString();
  const realFetch = seedVagaro([{ id: 'VAG-2', startDateTime: start, endDateTime: end, duration: 60, customerName: 'Nina', serviceTitle: 'Cut', serviceProviderName: 'Mia', status: 'confirmed' }]);

  try{
    // seed a stale row the provider no longer reports
    fake.seed('cached_availability', [
      { id: 'stale-1', tenant_id: tenantA.id, provider: 'vagaro', external_booking_id: 'VAG-GONE', starts_at: start, ends_at: end, duration_min: 60, status: 'booked' }
    ]);
    const r = await quietAsync(() => syncTenantAvailability(fake, tenantA.id));
    assert.equal(r.stale_removed, 1);

    const ids = fake.all('cached_availability').map(x => x.external_booking_id);
    assert.ok(!ids.includes('VAG-GONE'));
    assert.ok(ids.includes('VAG-2'));
  }finally{
    globalThis.fetch = realFetch;
  }
});

test('no connected booking integrations is a clean no-op', async () => {
  fake.reset();
  fake.seed('integrations', []);
  const r = await quietAsync(() => syncTenantAvailability(fake, tenantA.id));
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.equal(fake.all('cached_availability').length, 0);
  assert.equal(fake.all('booking_sync_log').length, 0);
});

test('a provider fetch failure is recorded in the log, not fatal', async () => {
  fake.reset();
  fake.seed('integrations', [
    { tenant_id: tenantA.id, provider: 'vagaro', status: 'connected', access_token: 'legacy-plaintext', refresh_token: null }
  ]);
  fake.seed('cached_availability', []);
  fake.seed('booking_sync_log', []);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNRESET'); };

  try{
    const r = await quietAsync(() => syncTenantAvailability(fake, tenantA.id));
    assert.equal(r.ok, true);
    assert.equal(r.fetched, 0);
    assert.equal(r.provider_errors.length, 1);
    assert.match(r.provider_errors[0].error, /ECONNRESET/);
    const logs = fake.all('booking_sync_log');
    assert.equal(logs.length, 1);
    assert.ok(logs[0].error_message, 'provider error should be captured in the audit log');
  }finally{
    globalThis.fetch = realFetch;
  }
});
