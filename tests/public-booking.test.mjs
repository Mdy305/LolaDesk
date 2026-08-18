/**
 * tests/public-booking.test.mjs — the open-source booking widget's API.
 *
 * Run:
 *   node tests/public-booking.test.mjs
 *   node --test tests/
 *
 * Drives the REAL handler chain (public-booking.js → calendar.js → the
 * availability/booking engines) against the in-memory fake Supabase.
 *
 * Regression covered: GET requests must carry their params (service_id,
 * staff_id, date) through to the handlers — the widget queries availability
 * via GET query strings, and before the fix those params were silently
 * dropped, so public web booking always fell into fuzzy name resolution
 * and returned `needs: service`.
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
  '// Generated test double — see tests/public-booking.test.mjs',
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

const handler = (await import('../api/public-booking.js')).default;

// ── seed a salon with a service, a stylist, and a weekly schedule ──
const TZ = 'America/New_York';
const target = new Date(Date.now() + 3 * 86400000);
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
  new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(target));
const DATE_KEY = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(target);

const TENANT = { id: 't1', slug: 'test-salon', name: 'Test Salon', phone_number: null };
const SERVICE = { id: 'svc-1', tenant_id: 't1', name: 'Haircut', duration_minutes: 60, active_duration_1_min: 60, price: 80, is_active: true };
const STAFF = { id: 'st-1', tenant_id: 't1', name: 'Alice', role: 'Stylist', is_active: true };
const SCHEDULE = { id: 'sc-1', tenant_id: 't1', staff_id: 'st-1', day_of_week: DOW, start_time: '09:00', end_time: '17:00' };

fake.seed('tenants', [TENANT]);
fake.seed('services', [SERVICE]);
fake.seed('staff', [STAFF]);
fake.seed('staff_schedules', [SCHEDULE]);
fake.seed('bookings', []);
fake.seed('holds', []);
fake.seed('clients', []);

function makeRes() {
  const out = { code: 200, body: null };
  const res = {
    setHeader() {},
    status(c) { out.code = c; return this; },
    json(o) { out.body = o; return o; }
  };
  return [res, out];
}
function getReq(query) {
  return {
    method: 'GET',
    url: '/api/public-booking?' + new URLSearchParams(query).toString(),
    query,
    headers: {},
    body: undefined
  };
}
function postReq(body) {
  return {
    method: 'POST',
    url: '/api/public-booking',
    query: {},
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  };
}

test('GET catalog resolves the tenant by slug and returns services', async () => {
  const req = getReq({ action: 'catalog', tenant: 'test-salon' });
  const [res, out] = makeRes();
  await handler(req, res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.services.length, 1);
  assert.equal(out.body.services[0].id, 'svc-1');
});

test('GET availability via QUERY STRING returns real slots (regression fix)', async () => {
  const req = getReq({ action: 'availability', tenant: 'test-salon', service_id: 'svc-1', staff_id: 'st-1', date: DATE_KEY });
  const [res, out] = makeRes();
  await handler(req, res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true, 'availability should resolve by query-string service_id — got: ' + JSON.stringify(out.body).slice(0, 200));
  assert.ok(Array.isArray(out.body.slots) && out.body.slots.length > 0, 'expected slots for a scheduled day');
  const s = out.body.slots[0];
  assert.equal(s.service_id, 'svc-1');
  assert.equal(s.staff_id, 'st-1');
  assert.ok(new Date(s.starts_at) > new Date(), 'slots must be in the future');
});

test('POST book — full round trip: hold → canonical booking → hold released', async () => {
  // Grab a real slot from the availability engine so the hold is valid.
  const availReq = getReq({ action: 'availability', tenant: 'test-salon', service_id: 'svc-1', staff_id: 'st-1', date: DATE_KEY });
  const [availRes, availOut] = makeRes();
  await handler(availReq, availRes);
  const slot = availOut.body.slots[0].starts_at;

  const req = postReq({
    tenant: 'test-salon', action: 'book', channel: 'public_web',
    service_id: 'svc-1', staff_id: 'st-1', starts_at: slot,
    client_name: 'Jane Doe', client_phone: '+15551234567', client_email: 'jane@example.com',
    total_amount: 80
  });
  const [res, out] = makeRes();
  await handler(req, res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true, 'book should succeed — got: ' + JSON.stringify(out.body).slice(0, 200));
  assert.equal(out.body.status, 'confirmed');
  assert.ok(out.body.booking_id);

  const bookings = fake.all('bookings');
  assert.equal(bookings.length, 1);
  assert.equal(bookings[0].status, 'confirmed');
  assert.equal(bookings[0].client_id, fake.all('clients')[0].id, 'booking links the upserted client');

  const holds = fake.all('holds');
  assert.equal(holds.filter(h => h.status === 'active').length, 0, 'hold must be released after conversion');
});

test('unknown tenant resolves to the demo tenant only — never real data', async () => {
  const req = getReq({ action: 'catalog', tenant: 'does-not-exist' });
  const [res, out] = makeRes();
  await handler(req, res);
  assert.equal(out.code, 200);
  // The demo fallback is a fixed synthetic tenant; an unknown slug must not
  // surface any REAL tenant's catalog.
  const names = (out.body.services || []).map(s => s.name);
  assert.ok(!names.includes('Haircut'), 'unknown slug must not leak the real tenant\'s catalog');
});

console.log('\npublic-booking: GET params flow + hold/book round trip ✅');
