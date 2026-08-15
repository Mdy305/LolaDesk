/**
 * tests/booking-brain.test.mjs — end-to-end tests for the unified smart-booking brain.
 *
 * Run:
 *   node tests/booking-brain.test.mjs
 *   node --test tests/
 *
 * The REAL lib/booking-brain.js (and its whole closure) is exercised against an
 * in-memory Supabase stand-in (tests/fake-supabase.js). Because
 * @supabase/supabase-js isn't installed here, this file provisions a tiny test
 * double for it under node_modules at import time and injects the fake through
 * a global. No network, no real DB, no other dependencies.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSupabase } from './fake-supabase.js';
import { zonedLocalToUtc, dayBoundsUtc, localWeekday } from '../api/lib/timezone.js';

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
  '// Generated test double — see tests/booking-brain.test.mjs',
  'export function createClient() {',
  "  const fake = globalThis.__LOLA_FAKE_SUPABASE__;",
  "  if (!fake) throw new Error('No fake Supabase registered');",
  '  return fake;',
  '}',
  ''
].join('\n'));

const fake = new FakeSupabase();
globalThis.__LOLA_FAKE_SUPABASE__ = fake;
// db() lazily builds its client only when these are set; the stub above
// intercepts createClient() and returns the fake regardless of the URL/key.
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'fake-service-key';
// Belt-and-suspenders: never touch the network (confirmation SMS / LLM).
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

// Load the REAL brain (and its closure) against the fake DB.
const brain = await import('../api/lib/booking-brain.js');
const { getTenantMemory } = await import('../api/lib/db.js');

const TZ = 'America/New_York';
const tenantA = { id: 'tenant-a', slug: 'salon-a', name: 'Salon A' };
const tenantB = { id: 'tenant-b', slug: 'salon-b', name: 'Salon B' };

function futureDateKey(daysAhead = 14) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Reseed a minimal, deterministic calendar for tenant A:
// one service, one stylist, a 09:00–17:00 schedule on the future day.
function seedStandard() {
  fake.reset();
  const dateKey = futureDateKey(14);
  const startsAt = zonedLocalToUtc(dateKey, '14:00:00', TZ);
  const from = dayBoundsUtc(startsAt, TZ).start;
  const weekday = localWeekday(new Date(from), TZ);

  fake.seed('services', [
    { id: 'srv-1', tenant_id: tenantA.id, name: 'Balayage', price: 250, duration_minutes: 60, is_active: true }
  ]);
  fake.seed('staff', [
    { id: 'stf-1', tenant_id: tenantA.id, name: 'Mia', is_active: true }
  ]);
  fake.seed('staff_schedules', [
    { id: 'sch-1', tenant_id: tenantA.id, staff_id: 'stf-1', day_of_week: weekday, start_time: '09:00', end_time: '17:00' }
  ]);
  return { dateKey, startsAt, weekday };
}

const bookParams = overrides => ({
  service_id: 'srv-1',
  staff_id: 'stf-1',
  client_name: 'Sarah',
  client_phone: '+13055550100',
  ...overrides
});

test('bookAppointment books an available slot and remembers it', async () => {
  const { startsAt } = seedStandard();
  const r = await brain.bookAppointment(tenantA, bookParams({ starts_at: startsAt }), { channel: 'voice' });

  assert.equal(r.ok, true);
  assert.equal(r.booked, true);
  assert.ok(r.booking?.id);

  const booking = fake.all('bookings')[0];
  assert.equal(booking.tenant_id, tenantA.id);
  assert.equal(booking.start_time, new Date(startsAt).toISOString());
  assert.equal(booking.service, 'Balayage'); // legacy compat columns written too
  assert.equal(booking.stylist, 'Mia');

  // "Lola remembers": a tenant event_log entry was recorded for this salon.
  const mem = await getTenantMemory(tenantA.id);
  assert.ok(mem.some(m => m.key === 'event_log'));
});

test('bookAppointment returns a conflict when the slot is already booked', async () => {
  const { startsAt } = seedStandard();
  const first = await brain.bookAppointment(tenantA, bookParams({ starts_at: startsAt }), { channel: 'voice' });
  assert.equal(first.ok, true);

  const second = await brain.bookAppointment(tenantA, bookParams({ starts_at: startsAt, client_phone: '+13055550101' }), { channel: 'voice' });
  assert.equal(second.ok, false);
  assert.equal(second.conflict, true);
  assert.equal(second.needs, 'alternate_time');
});

test('an active availability hold blocks a booking (hold conflict)', async () => {
  const { startsAt } = seedStandard();
  const start = new Date(startsAt).toISOString();
  const end = new Date(new Date(startsAt).getTime() + 60 * 60000).toISOString();
  fake.seed('availability_holds', [
    { tenant_id: tenantA.id, staff_id: 'stf-1', status: 'active', starts_at: start, ends_at: end, expires_at: new Date(Date.now() + 600000).toISOString() }
  ]);

  const r = await brain.bookAppointment(tenantA, bookParams({ starts_at: startsAt }), { channel: 'voice' });
  assert.equal(r.ok, false);
  assert.equal(r.conflict, true);
});

test('rescheduleAppointment moves the booking and records history', async () => {
  const { dateKey, startsAt } = seedStandard();
  const booked = await brain.bookAppointment(tenantA, bookParams({ starts_at: startsAt }), { channel: 'voice' });
  assert.equal(booked.ok, true);

  const newStart = zonedLocalToUtc(dateKey, '15:00:00', TZ);
  const r = await brain.rescheduleAppointment(tenantA, { booking_id: booked.booking.id, starts_at: newStart }, { channel: 'voice' });

  assert.equal(r.ok, true);
  assert.equal(r.rescheduled, true);

  const booking = fake.all('bookings')[0];
  assert.equal(booking.start_time, new Date(newStart).toISOString());

  const rescheduled = fake.all('booking_status_history').filter(h => h.reason === 'rescheduled');
  assert.equal(rescheduled.length, 1);
});

test('cancelAppointment cancels the booking and records status history', async () => {
  const { startsAt } = seedStandard();
  const booked = await brain.bookAppointment(tenantA, bookParams({ starts_at: startsAt }), { channel: 'voice' });
  assert.equal(booked.ok, true);

  const r = await brain.cancelAppointment(tenantA, { booking_id: booked.booking.id }, { channel: 'voice' });
  assert.equal(r.ok, true);
  assert.equal(r.cancelled, true);

  const booking = fake.all('bookings')[0];
  assert.equal(booking.status, 'cancelled');

  const cancelled = fake.all('booking_status_history').filter(h => h.to_status === 'cancelled');
  assert.equal(cancelled.length, 1);
});

test('tenant memory is isolated per tenant', async () => {
  const { startsAt } = seedStandard();
  await brain.remember(tenantA, { key: 'vip_note', value: 'prefers Balayage with Mia' });
  await brain.bookAppointment(tenantA, bookParams({ starts_at: startsAt }), { channel: 'voice' });

  const aMem = await getTenantMemory(tenantA.id);
  const bMem = await getTenantMemory(tenantB.id);

  assert.ok(aMem.some(m => m.key === 'vip_note'));
  assert.ok(aMem.some(m => m.key === 'event_log'));
  assert.equal(bMem.length, 0);

  const blockA = await brain.tenantMemoryBlock(tenantA.id);
  const blockB = await brain.tenantMemoryBlock(tenantB.id);
  assert.match(blockA, /vip_note/);
  // Recent event_log entries are surfaced by their kind (booking_created,
  // remembered, …), not by the literal 'event_log' key.
  assert.match(blockA, /booking_created/);
  assert.match(blockA, /remembered/);
  assert.equal(blockB, '');
});
