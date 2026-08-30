/**
 * tests/booksy-connector.test.mjs — the Booksy partner wiring.
 *
 * Run:
 *   node tests/booksy-connector.test.mjs
 *   node --test tests/
 *
 * Proves the pieces the booking-sync cron depends on for a Booksy tenant:
 * the RS256 JWT assertion claims, the /token/ exchange (with partner_name),
 * token caching (one mint per invocation, not one per tenant), business-id
 * scoping of the appointment path, single-char status normalization, and a
 * full syncTenantAvailability round-trip into cached_availability.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSupabase } from './fake-supabase.js';

// ── @supabase/supabase-js test double (for the booking-sync round-trip) ──
const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STUB_DIR = join(API_ROOT, 'node_modules', '@supabase', 'supabase-js');
mkdirSync(STUB_DIR, { recursive: true });
writeFileSync(join(STUB_DIR, 'package.json'), JSON.stringify({
  name: '@supabase/supabase-js', version: '0.0.0-test', type: 'module',
  main: 'index.js', exports: { '.': './index.js' }
}, null, 2));
writeFileSync(join(STUB_DIR, 'index.js'), [
  '// Generated test double — see tests/booksy-connector.test.mjs',
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

// ── a real RSA key so the JWT signature path runs for real ──────────
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.BOOKSY_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
process.env.BOOKSY_PARTNER_ID = 'partner-uuid-123';
process.env.BOOKSY_PARTNER_NAME = 'LolaDesk';

const booksy = await import('../api/lib/connectors/booksy.js');
const { syncTenantAvailability } = await import('../api/lib/booking-sync.js');

function decodePart(token, idx){
  return JSON.parse(Buffer.from(String(token).split('.')[idx], 'base64url').toString('utf8'));
}

test('signAssertion builds a valid RS256 JWT with the Booksy claim set', () => {
  const now = Math.floor(Date.now() / 1000);
  const jwt = booksy.signAssertion(
    { iss: 'https://public-api.booksy.com', aud: 'partner-uuid-123', iat: now, exp: now + 300 },
    process.env.BOOKSY_PRIVATE_KEY,
    'kid-1'
  );
  const parts = String(jwt).split('.');
  assert.equal(parts.length, 3, 'JWT must be header.payload.signature');
  const header = decodePart(jwt, 0);
  assert.equal(header.typ, 'JWT');
  assert.equal(header.alg, 'RS256');
  assert.equal(header.kid, 'kid-1');
  const payload = decodePart(jwt, 1);
  assert.equal(payload.iss, 'https://public-api.booksy.com');
  assert.equal(payload.aud, 'partner-uuid-123');
  assert.equal(payload.exp - payload.iat, 300);
});

test('ensureAccessToken mints once and caches for the invocation', async () => {
  const realFetch = globalThis.fetch;
  let tokenCalls = 0;
  globalThis.fetch = async (url) => {
    tokenCalls++;
    assert.ok(String(url).includes('/token/'), `unexpected fetch ${url}`);
    return { ok: true, status: 200, json: async () => ({ access_token: 'tok-1', refresh_token: 'rt-1', expires_in: 300 }) };
  };
  try{
    const a = await booksy.ensureAccessToken(null);
    const b = await booksy.ensureAccessToken(null);
    assert.equal(a, 'tok-1');
    assert.equal(b, 'tok-1');
    assert.equal(tokenCalls, 1, 'second call must reuse the cached token');
  }finally{
    globalThis.fetch = realFetch;
  }
});

test('getAccessToken POSTs the assertion with partner_name', async () => {
  const realFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = { url: String(url), body: opts.body.toString() };
    return { ok: true, status: 200, json: async () => ({ access_token: 'tok-2', expires_in: 300 }) };
  };
  try{
    const t = await booksy.getAccessToken();
    assert.equal(t.access_token, 'tok-2');
    assert.ok(t.expires_at, 'expires_at must be set');
    assert.match(captured.url, /\/token\/$/);
    const body = new URLSearchParams(captured.body);
    assert.equal(body.get('partner_name'), 'LolaDesk');
    assert.ok(body.get('assertion'), 'assertion must be sent');
    const claims = decodePart(body.get('assertion'), 1);
    assert.equal(claims.iss, 'https://public-api.booksy.com');
    assert.equal(claims.aud, 'partner-uuid-123');
  }finally{
    globalThis.fetch = realFetch;
  }
});

test('listAppointments scopes by business_id and normalizes status codes', async () => {
  const realFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if(String(url).includes('/token/')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok-x', expires_in: 300 }) };
    if(String(url).includes('/appointment/')) {
      return { ok: true, status: 200, json: async () => ({ results: [
        { id: 1001, start_datetime: '2026-09-01T10:00', end_datetime: '2026-09-01T10:45', status: 'A', customer_name: 'Jane Doe', service_name: 'Haircut', subbookings: [{ staffer_id: 'staff-7' }] },
        { id: 1002, start_datetime: '2026-09-01T11:00', status: 'C', customer_name: 'John Roe', duration_minutes: 30 }
      ]}) };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  try{
    const apps = await booksy.listAppointments(
      { metadata: { business_id: 'biz-42' } },
      { from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' }
    );
    assert.equal(apps.length, 2);
    const a = apps[0];
    assert.equal(a.id, '1001');
    assert.equal(a.starts_at, '2026-09-01T10:00');
    assert.equal(a.ends_at, '2026-09-01T10:45');
    assert.equal(a.duration_min, 45);
    assert.equal(a.client.name, 'Jane Doe');
    assert.equal(a.service, 'Haircut');
    assert.equal(a.stylist, 'staff-7');
    assert.equal(a.status, 'booked', 'Booksy "A" (accepted) → booked');
    assert.equal(apps[1].status, 'cancelled', 'Booksy "C" (cancelled) → cancelled');
    const apptUrl = urls.find(u => u.includes('/appointment/'));
    assert.match(apptUrl, /\/business\/biz-42\/appointment\//, 'must be business-scoped');
    assert.match(apptUrl, /booked_from=/);
    assert.match(apptUrl, /booked_till=/);
    assert.match(apptUrl, /offset=0/);
  }finally{
    globalThis.fetch = realFetch;
  }
});

test('listAppointments refuses a Booksy integration without business_id', async () => {
  await assert.rejects(
    () => booksy.listAppointments({ metadata: {} }, {}),
    /business_id/,
    'must fail fast with a descriptive error'
  );
});

test('syncTenantAvailability round-trips a Booksy tenant into the cache', async () => {
  fake.reset();
  fake.seed('tenants', [{ id: 't1', name: 'Booksy Salon', owner_email: 'o@t1.com' }]);
  fake.seed('integrations', [
    { tenant_id: 't1', provider: 'booksy', status: 'connected', access_token: null, refresh_token: null, metadata: { business_id: 'biz-42' } }
  ]);
  fake.seed('cached_availability', []);
  fake.seed('booking_sync_log', []);

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if(u.includes('/token/')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok-sync', expires_in: 300 }) };
    if(u.includes('/appointment/')) {
      return { ok: true, status: 200, json: async () => ({ results: [
        { id: 2001, start_datetime: '2026-09-01T10:00', end_datetime: '2026-09-01T11:00', status: 'A', customer_name: 'Sync Client', service_name: 'Balayage', subbookings: [{ staffer_id: 'staff-9' }] }
      ]}) };
    }
    throw new Error('unexpected fetch: ' + u);
  };
  try{
    const result = await syncTenantAvailability(fake, 't1');
    assert.equal(result.ok, true);
    assert.ok(result.providers.includes('booksy'));
    assert.equal(result.fetched, 1);
    assert.equal(result.upserted, 1);
    assert.deepEqual(result.provider_errors, []);

    const cached = fake.all('cached_availability');
    assert.equal(cached.length, 1);
    assert.equal(cached[0].tenant_id, 't1');
    assert.equal(cached[0].provider, 'booksy');
    assert.equal(cached[0].external_booking_id, '2001');
    assert.equal(cached[0].client_name, 'Sync Client');
    assert.equal(cached[0].service, 'Balayage');
    assert.equal(cached[0].staff_id, 'staff-9');
    assert.equal(cached[0].status, 'booked');

    const logs = fake.all('booking_sync_log');
    assert.equal(logs.length, 1);
    assert.equal(logs[0].error_message, null);
  }finally{
    globalThis.fetch = realFetch;
  }
});

console.log('\nbooksy-connector: partner wiring ✅');
