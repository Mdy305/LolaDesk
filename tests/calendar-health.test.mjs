/**
 * tests/calendar-health.test.mjs — the calendar schema health gate.
 *
 * Run:
 *   node tests/calendar-health.test.mjs
 *   node --test tests/
 *
 * Exercises the REAL /api/calendar-health handler against the in-memory fake
 * Supabase. Proves the gate covers the 20260901_inventory_ops.sql tables
 * (products, blocked_slots, appointment_notes): when the migration has NOT
 * been applied the endpoint must report ready:false with those tables named
 * in `missing` — never a silent 21/21 'ready' while the inventory and
 * blocked-time features are dead. When all tables are seeded it reports
 * ready:true.
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
  '// Generated test double — see tests/calendar-health.test.mjs',
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

const { default: handler } = await import('../api/calendar-health.js');

// The full gate list, mirroring REQUIRED_TABLES in calendar-health.js.
const REQUIRED = [
  'tenants','tenant_config','booking_settings','clients','services','staff','staff_services','staff_schedules','staff_time_off',
  'bookings','availability_holds','booking_services','booking_status_history','resources','service_resources',
  'integrations','provider_mappings','external_appointments','booking_sync_log','telnyx_call_sessions','telnyx_messages',
  'products','blocked_slots','appointment_notes'
];

function seedAll() {
  fake.reset();
  for (const t of REQUIRED) fake.seed(t, []);
}

function makeRes() {
  const out = { code: 200, body: null };
  return [{
    setHeader() {}, status(c) { out.code = c; return this; },
    json(o) { out.body = o; return o; }
  }, out];
}

test('all tables present -> ready true, including the inventory tables', async () => {
  seedAll();
  const [res, out] = makeRes();
  await handler({ method: 'GET', query: {}, headers: {}, body: {} }, res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.ready, true);
  assert.equal(out.body.required, REQUIRED.length);
  assert.equal(out.body.missing.length, 0);
  const names = out.body.checks.map(c => c.table);
  for (const t of ['products', 'blocked_slots', 'appointment_notes']) {
    assert.ok(names.includes(t), t + ' is part of the gate');
  }
});

test('missing products table fails loudly and names it', async () => {
  seedAll();
  fake.failRead('products', 'relation "public.products" does not exist');
  const [res, out] = makeRes();
  await handler({ method: 'GET', query: {}, headers: {}, body: {} }, res);
  assert.equal(out.code, 503);
  assert.equal(out.body.ready, false);
  assert.ok(out.body.missing.includes('products'), 'products named in missing');
});

test('missing blocked_slots table fails loudly (silent availability loss would hide it)', async () => {
  seedAll();
  fake.failRead('blocked_slots', 'relation "public.blocked_slots" does not exist');
  const [res, out] = makeRes();
  await handler({ method: 'GET', query: {}, headers: {}, body: {} }, res);
  assert.equal(out.code, 503);
  assert.equal(out.body.ready, false);
  assert.ok(out.body.missing.includes('blocked_slots'));
  assert.ok(out.body.checks.find(c => c.table === 'blocked_slots').ok === false);
});
