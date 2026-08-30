/**
 * tests/widget-reschedule.test.mjs — public self-service reschedule.
 *
 * Run:
 *   node tests/widget-reschedule.test.mjs
 *   node --test tests/
 *
 * Drives the REAL public-booking.js → calendar.js chain against the in-memory
 * fake Supabase. Proves the confirmation-SMS promise ("use your code to cancel
 * or reschedule online"): a client can look up their own booking by
 * code + phone, then move it to a new open slot — while a mismatched phone or
 * an unknown code is refused, and the booking is never touched by booking_id.
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
  '// Generated test double — see tests/widget-reschedule.test.mjs',
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

// ── seed a salon with a service, a stylist, a schedule, and a client ──
const TZ = 'America/New_York';
const target = new Date(Date.now() + 3 * 86400000);
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
  new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(target));
const DATE_KEY = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(target);

const TENANT = { id: 't1', slug: 'test-salon', name: 'Test Salon', phone_number: '+13055550100' };
const SERVICE = { id: 'svc-1', tenant_id: 't1', name: 'Haircut', duration_minutes: 60, price: 80, is_active: true };
const STAFF = { id: 'st-1', tenant_id: 't1', name: 'Alice', role: 'Stylist', is_active: true };
const SCHEDULE = { id: 'sc-1', tenant_id: 't1', staff_id: 'st-1', day_of_week: DOW, start_time: '09:00', end_time: '17:00' };
const CLIENT = { id: 'cl-1', tenant_id: 't1', first_name: 'Jane', last_name: 'Doe', name: 'Jane Doe', phone: '+15551234567' };
const CODE = 'AB3X7Q';

function seed(bookingPatch = {}) {
  fake.reset();
  fake.seed('tenants', [TENANT]);
  fake.seed('services', [SERVICE]);
  fake.seed('staff', [STAFF]);
  fake.seed('staff_schedules', [SCHEDULE]);
  fake.seed('staff_time_off', []);
  fake.seed('clients', [CLIENT]);
  fake.seed('bookings', []);
  fake.seed('holds', []);
  fake.seed('availability_holds', []);
  const start = new Date(target); start.setHours(10, 0, 0, 0);
  fake.seed('bookings', [{
    id: 'bk-1', tenant_id: 't1', client_id: 'cl-1', service_id: 'svc-1', staff_id: 'st-1',
    start_time: start.toISOString(),
    end_time: new Date(start.getTime() + 60 * 60000).toISOString(),
    status: 'confirmed', total_amount: 80, source: 'public_web', confirmation_code: CODE,
    ...bookingPatch
  }]);
}

function makeRes() {
  const out = { code: 200, body: null };
  const res = {
    setHeader() {},
    status(c) { out.code = c; return this; },
    json(o) { out.body = o; return o; }
  };
  return [res, out];
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

// Grab a real open slot from the availability engine for the seeded day.
async function grabSlot() {
  const req = {
    method: 'GET',
    url: '/api/public-booking?action=availability&tenant=test-salon&service_id=svc-1&staff_id=st-1&date=' + DATE_KEY,
    query: { action: 'availability', tenant: 'test-salon', service_id: 'svc-1', staff_id: 'st-1', date: DATE_KEY },
    headers: {},
    body: undefined
  };
  const [res, out] = makeRes();
  await handler(req, res);
  assert.equal(out.body.ok, true, 'availability should resolve — got: ' + JSON.stringify(out.body).slice(0, 200));
  return out.body.slots[0].starts_at;
}

test('lookup returns the client\'s own booking with service/staff names by code + phone', async () => {
  seed();
  const [res, out] = makeRes();
  await handler(postReq({ tenant: 'test-salon', action: 'lookup', code: CODE, client_phone: '+15551234567' }), res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.booking.confirmation_code, CODE);
  assert.equal(out.body.booking.status, 'confirmed');
  assert.equal(out.body.booking.service.name, 'Haircut');
  assert.equal(out.body.booking.service.price, 80);
  assert.equal(out.body.booking.staff.name, 'Alice');
  assert.ok(out.body.booking.start_time, 'start time returned');
  assert.equal(out.body.booking.id, undefined, 'internal booking id must not leak to the public widget');
});

test('lookup refuses a mismatched phone and an unknown code', async () => {
  seed();
  const [res1, out1] = makeRes();
  await handler(postReq({ tenant: 'test-salon', action: 'lookup', code: CODE, client_phone: '+19999999999' }), res1);
  assert.equal(out1.body.ok, false);
  assert.equal(out1.body.error, 'code_phone_mismatch');

  const [res2, out2] = makeRes();
  await handler(postReq({ tenant: 'test-salon', action: 'lookup', code: 'ZZZZZZ', client_phone: '+15551234567' }), res2);
  assert.equal(out2.body.ok, false);
  assert.equal(out2.body.error, 'code_not_found');
});

test('public reschedule moves the booking to a new open slot and updates start_time', async () => {
  seed();
  const newSlot = await grabSlot();
  assert.notEqual(newSlot, fake.all('bookings')[0].start_time, 'grab a slot different from the original');

  const [res, out] = makeRes();
  await handler(postReq({
    tenant: 'test-salon', action: 'reschedule', channel: 'public_widget',
    code: CODE, client_phone: '+15551234567', starts_at: newSlot, staff_id: 'st-1'
  }), res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true, 'reschedule should succeed — got: ' + JSON.stringify(out.body).slice(0, 200));
  assert.equal(out.body.rescheduled, true);
  assert.equal(out.body.booking.status, 'confirmed');
  assert.equal(out.body.booking.start_time, newSlot, 'start_time updated to the new slot');

  const rows = fake.all('bookings');
  assert.equal(rows.length, 1, 'still exactly one booking (rescheduled, not duplicated)');
  assert.equal(rows[0].start_time, newSlot);
  // Same-status reschedule keeps the single confirmed row; no phantom booking.
  assert.equal(rows[0].status, 'confirmed');
});

test('public reschedule refuses a mismatched phone and leaves the booking untouched', async () => {
  seed();
  const before = fake.all('bookings')[0];
  const [res, out] = makeRes();
  await handler(postReq({
    tenant: 'test-salon', action: 'reschedule', channel: 'public_widget',
    code: CODE, client_phone: '+19999999999', starts_at: before.start_time, staff_id: 'st-1'
  }), res);
  assert.equal(out.body.ok, false);
  assert.equal(out.body.error, 'code_phone_mismatch');
  const after = fake.all('bookings')[0];
  assert.equal(after.start_time, before.start_time, 'booking unchanged');
});

test('public reschedule refuses an appointment that has already passed', async () => {
  const past = new Date(Date.now() - 86400000); past.setHours(10, 0, 0, 0);
  seed({ start_time: past.toISOString(), end_time: new Date(past.getTime() + 60 * 60000).toISOString() });
  const newSlot = await grabSlot();
  const [res, out] = makeRes();
  await handler(postReq({
    tenant: 'test-salon', action: 'reschedule', channel: 'public_widget',
    code: CODE, client_phone: '+15551234567', starts_at: newSlot, staff_id: 'st-1'
  }), res);
  assert.equal(out.body.ok, false);
  assert.equal(out.body.error, 'appointment_passed');
});

test('a reschedule sends a fresh confirmation SMS with the new time', async () => {
  seed();
  const newSlot = await grabSlot();
  const original = fake.all('bookings')[0];
  assert.notEqual(newSlot, original.start_time, 'must be a different slot');

  // Stub the Telnyx /v2/messages endpoint so the fire-and-forget
  // sendConfirmationSMS actually goes through sendSMS and is captured.
  const smsCalls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('/v2/messages')) {
      smsCalls.push(JSON.parse(opts.body || '{}'));
      return { ok: true, status: 200, json: async () => ({ data: {} }) };
    }
    return realFetch(url, opts);
  };

  try {
    const [res, out] = makeRes();
    await handler(postReq({
      tenant: 'test-salon', action: 'reschedule', channel: 'public_widget',
      code: CODE, client_phone: '+15551234567', starts_at: newSlot, staff_id: 'st-1'
    }), res);
    assert.equal(out.body.ok, true, 'reschedule succeeds');
  } finally {
    global.fetch = realFetch;
  }

  assert.ok(smsCalls.length >= 1, 'a confirmation SMS is sent on reschedule — got ' + smsCalls.length);
  const sms = smsCalls[0];
  assert.equal(sms.from, '+13055550100', 'sends from the salon number');
  assert.equal(sms.to, '+15551234567', 'sends to the client');
  assert.ok(String(sms.text).startsWith('Rescheduled at'), 'text uses the reschedule verb: ' + sms.text);
  assert.ok(String(sms.text).includes('Haircut'), 'text names the service');
  assert.ok(String(sms.text).includes(CODE), 'text includes the confirmation code');
  assert.ok(String(sms.text).toLowerCase().includes('stop'), 'text includes opt-out');
});
