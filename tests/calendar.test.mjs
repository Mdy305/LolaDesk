/**
 * tests/calendar.test.mjs — /api/calendar week/day actions with enriched names.
 *
 * Run:
 *   node tests/calendar.test.mjs
 *
 * Exercises the REAL handler against the in-memory fake DB with an
 * authenticated owner: the day action returns a single day's bookings with
 * service / staff / client objects attached (no more "Appointment"/"Client"
 * fallbacks), the week action spans a multi-day range, cancelled bookings are
 * filtered from listBookings, and a conflict still surfaces on a double-book.
 *
 * Series tests (20260902_booking_series.sql): scoped cancel (following/all)
 * and scoped reschedule on the dashboard path — series_id identity required,
 * 'this' stays the single-booking path.
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
  '// Generated test double — see tests/calendar.test.mjs',
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

const { default: handler } = await import('../api/calendar.js');

const T1 = '11111111-1111-1111-1111-111111111111';
const USER = { id: 'u1', email: 'owner@salon.com' };
const SERVICE = { id: 'svc-1', tenant_id: T1, name: 'Balayage', duration_minutes: 90, price: 180, is_active: true };
const STAFF = { id: 'st-1', tenant_id: T1, name: 'Alice', role: 'Colorist', is_active: true };
const CLIENT = { id: 'cl-1', tenant_id: T1, first_name: 'Maya', last_name: 'Chen', phone: '+13055550123', name: 'Maya Chen' };

// The availability engine only offers slots inside a staff schedule.
function scheduleFor(date) {
  const dow = date.getDay(); // 0 = Sun
  return { id: 'sc-1', tenant_id: T1, staff_id: 'st-1', day_of_week: dow, start_time: '09:00', end_time: '17:00' };
}

function seed() {
  fake.reset();
  fake.seed('tenants', [{ id: T1, slug: 'salon-a', name: 'Salon A', owner_email: 'owner@salon.com', phone_number: '+13055550100' }]);
  fake.seed('services', [SERVICE]);
  fake.seed('staff', [STAFF]);
  fake.seed('clients', [CLIENT]);
  fake.seed('bookings', []);
  fake.seed('staff_schedules', []);
  fake.seed('staff_time_off', []);
  fake.seed('availability_holds', []);
  fake.seed('blocked_slots', []);
  fake.auth.users.set('tok-owner', USER);
}

function iso(dayOffset, h = 10, m = 0) {
  const d = new Date(Date.now() + dayOffset * 86400000);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
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
function getReq(query, auth = true) {
  return {
    method: 'GET',
    url: '/api/calendar?' + new URLSearchParams(query).toString(),
    query,
    headers: auth ? { authorization: 'Bearer tok-owner' } : {},
    body: undefined
  };
}
function postReq(body) {
  return {
    method: 'POST',
    url: '/api/calendar',
    query: {},
    headers: { authorization: 'Bearer tok-owner', 'content-type': 'application/json' },
    body: JSON.stringify(body)
  };
}

test('day action enriches bookings with service, staff, and client objects', async () => {
  seed();
  const start = iso(0, 9, 0);
  const end = new Date(new Date(start).getTime() + 90 * 60000).toISOString();
  fake.seed('bookings', [{
    id: 'bk-1', tenant_id: T1, client_id: 'cl-1', service_id: 'svc-1', staff_id: 'st-1',
    start_time: start, end_time: end, status: 'confirmed', total_amount: 180, source: 'dashboard'
  }]);
  const [res, out] = makeRes();
  await handler(getReq({ action: 'day', date: iso(0, 12, 0).slice(0, 10) }), res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.bookings.length, 1, 'one booking on the day');
  const b = out.body.bookings[0];
  assert.equal(b.service.name, 'Balayage', 'service name joined');
  assert.equal(b.staff.name, 'Alice', 'staff name joined');
  assert.equal(b.client.name, 'Maya Chen', 'client name joined');
  assert.equal(b.client.phone, '+13055550123');
  assert.equal(b.total_amount, 180);
});

test('day action carries blocked_slots (lunch/breaks/days off) in the payload', async () => {
  seed();
  const day = iso(0, 12, 0).slice(0, 10);
  fake.seed('blocked_slots', [{
    id: 'bl-1', tenant_id: T1, staff_id: 'st-1', blocked_date: day,
    start_time: '12:00:00', end_time: '13:00:00', reason: 'Lunch'
  }]);
  const [res, out] = makeRes();
  await handler(getReq({ action: 'day', date: day }), res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  assert.ok(Array.isArray(out.body.blocked_slots), 'blocked_slots present');
  assert.equal(out.body.blocked_slots.length, 1);
  const bl = out.body.blocked_slots[0];
  assert.equal(bl.reason, 'Lunch');
  assert.equal(bl.staff_id, 'st-1');
  assert.equal(bl.start_time, '12:00:00');
});

test('week action returns empty blocked_slots when none exist', async () => {
  seed();
  const [res, out] = makeRes();
  await handler(getReq({ action: 'week', date: iso(0, 12, 0).slice(0, 10), days: '7' }), res);
  assert.equal(out.code, 200);
  assert.deepEqual(out.body.blocked_slots, []);
});

test('week action returns a multi-day range with enriched bookings', async () => {
  seed();
  const start = iso(0, 11, 0);
  const end = new Date(new Date(start).getTime() + 60 * 60000).toISOString();
  fake.seed('bookings', [{
    id: 'bk-w1', tenant_id: T1, client_id: 'cl-1', service_id: 'svc-1', staff_id: 'st-1',
    start_time: start, end_time: end, status: 'confirmed', total_amount: 180, source: 'dashboard'
  }]);
  const [res, out] = makeRes();
  await handler(getReq({ action: 'week', date: iso(0, 12, 0).slice(0, 10), days: '7' }), res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.days, 7);
  assert.equal(out.body.bookings.length, 1);
  assert.equal(out.body.bookings[0].service.name, 'Balayage');
  assert.equal(out.body.bookings[0].client.name, 'Maya Chen');
});

test('cancelled bookings are excluded from the day response', async () => {
  seed();
  const a = iso(0, 9, 0), aEnd = new Date(new Date(a).getTime() + 60 * 60000).toISOString();
  const b = iso(0, 13, 0), bEnd = new Date(new Date(b).getTime() + 60 * 60000).toISOString();
  fake.seed('bookings', [
    { id: 'bk-ok', tenant_id: T1, client_id: 'cl-1', service_id: 'svc-1', staff_id: 'st-1', start_time: a, end_time: aEnd, status: 'confirmed', total_amount: 180, source: 'dashboard' },
    { id: 'bk-cx', tenant_id: T1, client_id: 'cl-1', service_id: 'svc-1', staff_id: 'st-1', start_time: b, end_time: bEnd, status: 'cancelled', total_amount: 180, source: 'dashboard' }
  ]);
  const [res, out] = makeRes();
  await handler(getReq({ action: 'day', date: iso(0, 12, 0).slice(0, 10) }), res);
  assert.equal(out.body.bookings.length, 1);
  assert.equal(out.body.bookings[0].id, 'bk-ok');
});

test('unauthenticated day request is rejected', async () => {
  seed();
  const [res, out] = makeRes();
  await handler(getReq({ action: 'day' }, false), res);
  assert.equal(out.code, 401);
  assert.equal(out.body.ok, false);
});

test('book action creates a confirmed booking end-to-end', async () => {
  seed();
  const target = new Date(Date.now() + 2 * 86400000);
  fake.seed('staff_schedules', [scheduleFor(target)]);
  const [res, out] = makeRes();
  await handler(postReq({
    action: 'book', service_id: 'svc-1', staff_id: 'st-1',
    starts_at: new Date(target.setHours(14, 0, 0, 0)).toISOString(),
    client_name: 'Maya Chen', client_phone: '+13055550123',
    notes: 'Birthday blowout', channel: 'dashboard'
  }), res);
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true, 'book should succeed on a scheduled slot — got: ' + JSON.stringify(out.body).slice(0, 200));
  assert.equal(out.body.status, 'confirmed');
  assert.ok(out.body.booking_id, 'booking id returned');
  const rows = fake.all('bookings');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'confirmed');
  assert.ok(rows[0].confirmation_code, 'confirmation code generated');
});

// ── dashboard/widget book also lands on the Cal.com mesh node ────────
function seedCalBookingProvider(){
  fake.seed('tenants', [{ id: T1, slug: 'salon-a', name: 'Salon A', owner_email: 'owner@salon.com', phone_number: '+13055550100', booking_provider: 'cal_platform' }]);
  fake.seed('integrations', [
    { tenant_id: T1, provider: 'cal_platform', status: 'connected', access_token: 'legacy-plaintext', refresh_token: null }
  ]);
  fake.seed('provider_mappings', [
    { tenant_id: T1, provider: 'cal_platform', entity_type: 'service', local_id: 'svc-1', external_id: '7' }
  ]);
}

test('book action routes the dashboard booking to Cal.com when it is booking_provider', async () => {
  seed();
  const target = new Date(Date.now() + 2 * 86400000);
  fake.seed('staff_schedules', [scheduleFor(target)]);
  seedCalBookingProvider();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    assert.equal(String(url), 'https://api.cal.com/v2/bookings');
    assert.equal(opts.method, 'POST');
    assert.equal(JSON.parse(opts.body).eventTypeId, 7, 'eventTypeId resolved from provider_mappings');
    return { ok: true, status: 200, json: async () => ({
      status: 'success',
      data: { uid: 'CAL-DASH', start: new Date(target.setHours(14, 0, 0, 0)).toISOString(), end: new Date(new Date(target).getTime() + 90 * 60000).toISOString(), duration: 90, status: 'accepted', attendees: [{ name: 'Maya Chen', email: 'maya@example.com' }], eventType: { slug: 'balayage' } }
    }) };
  };
  try{
    const [res, out] = makeRes();
    await handler(postReq({
      action: 'book', service_id: 'svc-1', staff_id: 'st-1',
      starts_at: new Date(target.setHours(14, 0, 0, 0)).toISOString(),
      client_name: 'Maya Chen', client_phone: '+13055550123',
      channel: 'dashboard'
    }), res);
    assert.equal(out.code, 200);
    assert.equal(out.body.ok, true, 'dashboard book succeeds with cal write: ' + JSON.stringify(out.body).slice(0, 200));
    assert.equal(out.body.external.provider, 'cal_platform');
    assert.equal(out.body.external.id, 'CAL-DASH');
    const booking = fake.all('bookings')[0];
    assert.equal(booking.external_id, 'CAL-DASH');
    assert.equal(booking.external_provider, 'cal_platform');
    const mapping = fake.all('provider_mappings').find(m => m.entity_type === 'booking');
    assert.ok(mapping, 'booking mapping recorded');
    assert.equal(mapping.external_id, 'CAL-DASH');
    assert.equal(mapping.local_id, booking.id);
  }finally{ globalThis.fetch = realFetch; }
});

test('book action keeps the booking local when the provider is down', async () => {
  seed();
  const target = new Date(Date.now() + 2 * 86400000);
  fake.seed('staff_schedules', [scheduleFor(target)]);
  seedCalBookingProvider();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNRESET'); };
  try{
    const [res, out] = makeRes();
    await handler(postReq({
      action: 'book', service_id: 'svc-1', staff_id: 'st-1',
      starts_at: new Date(target.setHours(14, 0, 0, 0)).toISOString(),
      client_name: 'Maya Chen', client_phone: '+13055550123',
      channel: 'dashboard'
    }), res);
    assert.equal(out.code, 200);
    assert.equal(out.body.ok, true, 'local booking survives a provider outage');
    assert.equal(out.body.external, null);
    const booking = fake.all('bookings')[0];
    assert.equal(booking.external_id, null);
    assert.equal(booking.external_provider, null);
    assert.equal(fake.all('provider_mappings').filter(m => m.entity_type === 'booking').length, 0);
  }finally{ globalThis.fetch = realFetch; }
});

// ── recurring series: scoped cancel / reschedule on the dashboard path ──
// These drive the REAL /api/calendar handler the bookings.html modal uses.
// booking_status_history is inserted by updateCanonicalBooking on every
// status change; the fake auto-creates unseeded tables on first write.

const SERIES_ID = '44444444-4444-4444-4444-444444444444';

function seriesRows() {
  // 4 weekly occurrences, pos 1..4, 10:00Z each
  return [1, 2, 3, 4].map((pos) => ({
    id: 'ser-' + pos, tenant_id: T1, client_id: 'cl-1', service_id: 'svc-1', staff_id: 'st-1',
    start_time: new Date(new Date(iso(7, 10)).getTime() + (pos - 1) * 7 * 86400000).toISOString(),
    end_time: new Date(new Date(iso(7, 10)).getTime() + (pos - 1) * 7 * 86400000 + 90 * 60000).toISOString(),
    status: 'confirmed', total_amount: 180, source: 'dashboard',
    series_id: SERIES_ID, series_pos: pos, series_total: 4, series_rule: 'weekly'
  }));
}

test('dashboard cancel with series_scope following cancels target + later, spares earlier', async () => {
  seed();
  fake.seed('bookings', seriesRows());
  const [res, out] = makeRes();
  await handler(postReq({ action: 'cancel', booking_id: 'ser-2', series_scope: 'following', channel: 'dashboard' }), res);
  assert.equal(out.body.ok, true, JSON.stringify(out.body).slice(0, 300));
  assert.equal(out.body.cancelled_count, 3, 'pos 2,3,4 cancelled');
  assert.equal(out.body.scope, 'following');
  const rows = fake.all('bookings');
  assert.equal(rows.find(r => r.id === 'ser-1').status, 'confirmed', 'earlier occurrence spared');
  assert.ok(rows.filter(r => r.id !== 'ser-1').every(r => r.status === 'cancelled'));
});

test('dashboard cancel with series_scope all cancels every occurrence and reports the count', async () => {
  seed();
  fake.seed('bookings', seriesRows());
  const [res, out] = makeRes();
  await handler(postReq({ action: 'cancel', booking_id: 'ser-3', series_scope: 'all', channel: 'dashboard' }), res);
  assert.equal(out.body.ok, true, JSON.stringify(out.body).slice(0, 300));
  assert.equal(out.body.cancelled_count, 4);
  assert.ok(fake.all('bookings').every(r => r.status === 'cancelled'));
});

test('dashboard cancel with series_scope this (default) cancels only that occurrence', async () => {
  seed();
  fake.seed('bookings', seriesRows());
  const [res, out] = makeRes();
  await handler(postReq({ action: 'cancel', booking_id: 'ser-2', channel: 'dashboard' }), res);
  assert.equal(out.body.ok, true);
  const rows = fake.all('bookings');
  assert.equal(rows.find(r => r.id === 'ser-2').status, 'cancelled');
  assert.equal(rows.filter(r => r.status === 'cancelled').length, 1, 'exactly one occurrence cancelled');
});

test('series_scope on a plain booking is rejected (not_a_series)', async () => {
  seed();
  const start = iso(2, 9, 0);
  fake.seed('bookings', [{ id: 'plain-1', tenant_id: T1, client_id: 'cl-1', service_id: 'svc-1', staff_id: 'st-1', start_time: start, end_time: new Date(new Date(start).getTime() + 60 * 60000).toISOString(), status: 'confirmed', total_amount: 180, source: 'dashboard' }]);
  const [res, out] = makeRes();
  await handler(postReq({ action: 'cancel', booking_id: 'plain-1', series_scope: 'all', channel: 'dashboard' }), res);
  assert.equal(out.code, 400);
  assert.equal(out.body.error, 'not_a_series');
  assert.equal(fake.all('bookings').find(r => r.id === 'plain-1').status, 'confirmed', 'nothing was cancelled');
});

test('dashboard reschedule with series_scope following shifts later occurrences by the same delta', async () => {
  seed();
  fake.seed('bookings', seriesRows());
  const target = seriesRows().find(r => r.id === 'ser-2');
  const delta = 2 * 3600000; // +2h
  const newStart = new Date(new Date(target.start_time).getTime() + delta).toISOString();
  const [res, out] = makeRes();
  await handler(postReq({ action: 'reschedule', booking_id: 'ser-2', starts_at: newStart, staff_id: 'st-1', series_scope: 'following', channel: 'dashboard' }), res);
  assert.equal(out.body.ok, true, JSON.stringify(out.body).slice(0, 300));
  assert.equal(out.body.series_moved, 2, 'ser-3 and ser-4 shifted');
  const rows = fake.all('bookings');
  const r2 = rows.find(r => r.id === 'ser-2');
  const r3 = rows.find(r => r.id === 'ser-3');
  const r4 = rows.find(r => r.id === 'ser-4');
  const orig = Object.fromEntries(seriesRows().map(r => [r.id, new Date(r.start_time).getTime()]));
  assert.equal(new Date(r2.start_time).getTime(), orig['ser-2'] + delta, 'target moved +2h');
  assert.equal(new Date(r3.start_time).getTime(), orig['ser-3'] + delta, 'ser-3 shifted by the same delta');
  assert.equal(new Date(r4.start_time).getTime(), orig['ser-4'] + delta, 'ser-4 shifted by the same delta');
});
