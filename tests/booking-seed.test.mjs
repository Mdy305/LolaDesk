/**
 * tests/booking-seed.test.mjs — the booking baseline seed.
 *
 * Run:
 *   node tests/booking-seed.test.mjs
 *
 * Exercises the REAL ensureBookingBaseline() (api/lib/booking-seed.js)
 * against the in-memory fake DB: creating booking_settings + services-from-
 * menu + a default staff/schedule + location/hours for a bookless tenant,
 * idempotency on re-run, the single-default-service fallback, and the cheap
 * short-circuit when a tenant is already bookable.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
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
  '// Generated test double — see tests/booking-seed.test.mjs',
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

const { ensureBookingBaseline } = await import('../api/lib/booking-seed.js');

const T1 = '11111111-1111-1111-1111-111111111111';

function seedTenant({ servicesMinus } = {}) {
  fake.reset();
  const menu = servicesMinus === 'none' ? [] : [
    { name: 'Balayage', price: 180, duration: 90 },
    { name: 'Cut & Gloss', price: 120 }
  ];
  fake.seed('tenants', [{ id: T1, slug: 'new-salon', name: 'Salon B', owner_email: 'owner@sallon.com', services: menu }]);
  fake.seed('booking_settings', []);
  fake.seed('services', []);
  fake.seed('staff', []);
  fake.seed('staff_schedules', []);
}

test('seeds the full booking baseline for a bookless tenant from its menu', async () => {
  seedTenant();
  const out = await ensureBookingBaseline(T1);

  assert.ok(out.seeded.includes('booking_settings'));
  assert.ok(out.seeded.includes('services'));
  assert.ok(out.seeded.includes('staff'));
  assert.ok(out.seeded.includes('staff_schedules'));

  assert.equal(fake.all('booking_settings').length, 1);
  assert.equal(fake.all('booking_settings')[0].tenant_id, T1);

  const svcNames = fake.all('services').map(s => s.name).sort();
  assert.deepEqual(svcNames, ['Balayage', 'Cut & Gloss'].sort());
  assert.equal(fake.all('services')[0].tenant_id, T1);

  assert.equal(fake.all('staff').length, 1);
  assert.equal(fake.all('staff')[0].tenant_id, T1);
  // Mon..Sun = 7 schedule rows for the default staff member.
  assert.equal(fake.all('staff_schedules').length, 7);
  assert.ok(fake.all('staff_schedules').every(r => r.staff_id === fake.all('staff')[0].id));
});

test('idempotent: a second run short-circuits once the full baseline is present', async () => {
  seedTenant();
  await ensureBookingBaseline(T1);
  const before = {
    settings: fake.all('booking_settings').length,
    services: fake.all('services').length,
    staff: fake.all('staff').length
  };
  const out = await ensureBookingBaseline(T1);
  assert.deepEqual(out.seeded, []);
  assert.equal(out.skipped, 'present');
  assert.equal(fake.all('booking_settings').length, before.settings);
  assert.equal(fake.all('services').length, before.services);
  assert.equal(fake.all('staff').length, before.staff);
});

test('falls back to one default service when the owner has no menu', async () => {
  seedTenant({ servicesMinus: 'none' });
  await ensureBookingBaseline(T1);
  const names = fake.all('services').map(s => s.name);
  assert.deepEqual(names, ['Consultation']);
  // But the rest of the baseline still lands.
  assert.equal(fake.all('booking_settings').length, 1);
  assert.equal(fake.all('staff').length, 1);
});

test('does not seed at all when the tenant is fully bookable (all baseline pieces present)', async () => {
  seedTenant();
  // A truly bookable tenant has every piece: settings, services, staff + schedules.
  fake.seed('booking_settings', [{ tenant_id: T1, timezone: 'America/New_York' }]);
  fake.seed('services', [{ id: 'svc1', tenant_id: T1, name: 'Balayage', duration_minutes: 90, price: 180 }]);
  const staffId = fake.nextId('staff');
  fake.seed('staff', [{ id: staffId, tenant_id: T1, name: 'Jamie', role: 'Stylist' }]);
  fake.seed('staff_schedules', [1,2,3,4,5,6,0].map(day => ({ staff_id: staffId, tenant_id: T1, day_of_week: day, start_time: '09:00:00', end_time: '19:00:00' })));

  const out = await ensureBookingBaseline(T1);
  assert.deepEqual(out.seeded, []);
  assert.equal(out.skipped, 'present');
  assert.equal(fake.all('services').length, 1);
  assert.equal(fake.all('staff').length, 1);
});

test('heals a tenant that has settings + services + staff but is missing schedules', async () => {
  seedTenant();
  fake.seed('booking_settings', [{ tenant_id: T1, timezone: 'America/New_York' }]);
  fake.seed('services', [{ id: 'svc1', tenant_id: T1, name: 'Balayage', duration_minutes: 90, price: 180 }]);
  const staffId = fake.nextId('staff');
  fake.seed('staff', [{ id: staffId, tenant_id: T1, name: 'Jamie', role: 'Stylist' }]);
  fake.seed('staff_schedules', []); // the actual gap backfilled in production

  const out = await ensureBookingBaseline(T1);
  assert.deepEqual(out.seeded, ['staff_schedules']);
  assert.equal(fake.all('staff_schedules').length, 7);
  assert.ok(fake.all('staff_schedules').every(r => r.staff_id === staffId));
  // Existing pieces are untouched — no duplicate staff or services.
  assert.equal(fake.all('staff').length, 1);
  assert.equal(fake.all('services').length, 1);
  // Idempotent: the second call sees all pieces present.
  const again = await ensureBookingBaseline(T1);
  assert.deepEqual(again.seeded, []);
  assert.equal(again.skipped, 'present');
});

test('heals a tenant that has services + staff schedules but is missing a default staff member', async () => {
  seedTenant();
  fake.seed('booking_settings', [{ tenant_id: T1, timezone: 'America/New_York' }]);
  fake.seed('services', [{ id: 'svc1', tenant_id: T1, name: 'Balayage', duration_minutes: 90, price: 180 }]);
  fake.seed('staff', []); // no staff at all
  fake.seed('staff_schedules', []);

  const out = await ensureBookingBaseline(T1);
  assert.ok(out.seeded.includes('staff'), out.seeded.join(','));
  assert.ok(out.seeded.includes('staff_schedules'), out.seeded.join(','));
  assert.equal(fake.all('staff').length, 1);
  assert.equal(fake.all('staff_schedules').length, 7);
  // A default staff member would not duplicate existing services.
  assert.equal(fake.all('services').length, 1);
});

test('fail-loud: a rejected write surfaces and stops instead of silently continuing', async () => {
  seedTenant();
  // booking_settings insert passes, then the services upsert is rejected.
  fake.failWrite('services', 'column services.featured_at does not exist');
  await assert.rejects(() => ensureBookingBaseline(T1), /does not exist/);
  // It stopped at services — no staff/step-3 rows got written behind the error.
  assert.equal(fake.all('staff').length, 0);
});