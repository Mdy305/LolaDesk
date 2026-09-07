/**
 * tests/salon.test.mjs — the Complete Salon OS surface (api/salon.js).
 *
 * Ported from Open Salon (github.com/clawnify/open-salon) and wired to
 * Telnyx (confirmation SMS on booking create). These tests cover the
 * canonical-DB contract:
 *
 *   1. Multi-service booking create writes booking_services line items —
 *      regression: the port originally wrote a phantom `appointment_services`
 *      table with a silent .catch(), so line items vanished without error.
 *   2. Status workflow update (confirmed → in_progress → completed / no_show)
 *      persists through POST resource=appointment action=update.
 *   3. Notes POST lands in appointment_notes, and the calendar GET
 *      booking_notes action returns them tenant-scoped.
 *   4. Recurring series (repeat {rule,count} + series_id identity): every
 *      occurrence goes through the
 *      canonical booking path, lands 7 days apart, and the client gets
 *      exactly ONE confirmation SMS (first occurrence) — never N.
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
  '// Generated test double — see tests/salon.test.mjs',
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
// No TELNYX_API_KEY: confirmSMS degrades to a no-op in tests.

// Owner session: auth.getUser(token) → the owner user; tenant_users links
// that user to the seeded tenant so resolveTenantForUser resolves t1.
fake.auth = fake.auth || {};
fake.auth.getUser = async () => ({ data: { user: { id: 'u1', email: 'owner@test.dev' } }, error: null });

const handler = (await import('../api/salon.js')).default;
const calendarHandler = (await import('../api/calendar.js')).default;

const TENANT = { id: 't1', slug: 'test-salon', name: 'Test Salon', phone_number: null };
const SVC_CUT = { id: 'svc-1', tenant_id: 't1', name: 'Haircut', duration_minutes: 45, price: 60, is_active: true };
const SVC_COLOR = { id: 'svc-2', tenant_id: 't1', name: 'Color', duration_minutes: 90, price: 180, is_active: true };
const STAFF = { id: 'st-1', tenant_id: 't1', name: 'Alice', role: 'Stylist', is_active: true };
const CLIENT = { id: 'cl-1', tenant_id: 't1', first_name: 'Dana', last_name: 'Reed', name: 'Dana Reed', phone: '+15551000001', email: '' };

fake.seed('tenants', [TENANT]);
fake.seed('tenant_users', [{ user_id: 'u1', tenant_id: 't1', role: 'owner' }]);
fake.seed('services', [SVC_CUT, SVC_COLOR]);
fake.seed('staff', [STAFF]);
fake.seed('clients', [CLIENT]);
fake.seed('bookings', []);
fake.seed('booking_services', []);
fake.seed('appointment_notes', []);
fake.seed('blocked_slots', []);

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
    url: '/api/salon',
    query: {},
    headers: { 'content-type': 'application/json', authorization: 'Bearer tok-owner' },
    body: JSON.stringify(body)
  };
}
function getReq(query) {
  return {
    method: 'GET',
    url: '/api/calendar?' + new URLSearchParams(query).toString(),
    query,
    headers: { authorization: 'Bearer tok-owner' },
    body: undefined
  };
}

test('POST appointment create (multi-service) writes canonical booking_services line items', async () => {
  const req = postReq({
    resource: 'appointment',
    service_ids: ['svc-1', 'svc-2'],
    staff_id: 'st-1',
    client_id: 'cl-1',
    date: '2026-09-10',
    start_time: '10:00',
    channel: 'dashboard'
  });
  const [res, out] = makeRes();
  await handler(req, res);
  assert.equal(out.code, 200, 'create must succeed — got: ' + JSON.stringify(out.body).slice(0, 300));
  assert.equal(out.body.ok, true);
  const booking = out.body.appointment;
  assert.ok(booking?.id, 'booking id returned');

  const lineItems = fake.all('booking_services');
  assert.equal(lineItems.length, 2, 'both services must land as booking_services rows');
  assert.deepEqual(lineItems.map(r => r.service_id).sort(), ['svc-1', 'svc-2']);
  assert.deepEqual(lineItems.map(r => r.sequence_no).sort(), [1, 2]);
  assert.ok(lineItems.every(r => r.booking_id === booking.id), 'line items link to the booking');
  assert.equal(lineItems.reduce((s, r) => s + Number(r.price || 0), 0), 240, 'line-item prices sum to the quote');
});

test('POST appointment update persists the status workflow (no_show)', async () => {
  // Find the booking created above inside the fake store.
  const store = fake.all('bookings');
  const booking = store[store.length - 1];
  assert.ok(booking?.id, 'a booking exists from the create test');

  const req = postReq({ resource: 'appointment', action: 'update', id: booking.id, status: 'no_show' });
  const [res, out] = makeRes();
  await handler(req, res);
  assert.equal(out.code, 200, 'update must succeed — got: ' + JSON.stringify(out.body).slice(0, 300));
  assert.equal(out.body.ok, true);
  const now = store.find(b => b.id === booking.id);
  assert.equal(now.status, 'no_show', 'status persisted');
});

test('GET calendar booking_services returns line items enriched with service names, tenant-scoped', async () => {
  const store = fake.all('bookings');
  const booking = store[store.length - 1];
  const req = getReq({ action: 'booking_services', booking_id: booking.id });
  const [res, out] = makeRes();
  await calendarHandler(req, res);
  assert.equal(out.code, 200, 'booking_services GET must succeed — got: ' + JSON.stringify(out.body).slice(0, 300));
  assert.equal(out.body.ok, true);
  assert.equal(out.body.items.length, 2, 'both line items returned');
  assert.ok(out.body.items.every(i => i.service?.name), 'each item carries its service name');
  assert.deepEqual(out.body.items.map(i => i.sequence_no), [1, 2], 'items ordered by sequence_no');
});

// ── dashboard-modal contract: multi-service booking via the salon path ──

test('POST appointment create accepts the dashboard multi-service payload (starts_at, client_name/phone)', async () => {
  const before = fake.all('bookings').length;
  const req = postReq({
    resource: 'appointment',
    service_ids: ['svc-1', 'svc-2'],
    staff_id: 'st-1',
    client_name: 'Willa Ford',
    client_phone: '+15551000002',
    starts_at: new Date(Date.now() + 86400000).toISOString(),
    notes: 'cut + color in one visit',
    channel: 'dashboard'
  });
  const [res, out] = makeRes();
  await handler(req, res);
  assert.equal(out.code, 200, 'dashboard multi-service create must succeed — got: ' + JSON.stringify(out.body).slice(0, 300));
  assert.equal(out.body.ok, true);
  const lines = fake.all('booking_services').filter(r => r.booking_id === out.body.appointment.id);
  assert.equal(lines.length, 2, 'both line items persist');
  assert.equal(fake.all('bookings').length, before + 1, 'one booking row created');
});

// ── end: dashboard-modal contract ──

test('POST note lands in appointment_notes and GET calendar booking_notes returns it tenant-scoped', async () => {
  const store = fake.all('bookings');
  const booking = store[store.length - 1];

  const noteReq = postReq({ resource: 'note', booking_id: booking.id, content: 'Prefers oat milk latte', author: 'Owner' });
  const [noteRes, noteOut] = makeRes();
  await handler(noteReq, noteRes);
  assert.equal(noteOut.code, 200, 'note POST must succeed — got: ' + JSON.stringify(noteOut.body).slice(0, 300));
  assert.equal(noteOut.body.ok, true);

  const notesStore = fake.all('appointment_notes');
  assert.equal(notesStore.length, 1, 'note row persisted');
  assert.equal(notesStore[0].tenant_id, 't1', 'note is tenant-scoped');
  assert.equal(notesStore[0].content, 'Prefers oat milk latte');

  const getNotes = getReq({ action: 'booking_notes', booking_id: booking.id });
  const [res, out] = makeRes();
  await calendarHandler(getNotes, res);
  assert.equal(out.code, 200, 'booking_notes GET must succeed — got: ' + JSON.stringify(out.body).slice(0, 300));
  assert.equal(out.body.ok, true);
  assert.equal(out.body.notes.length, 1);
  assert.equal(out.body.notes[0].content, 'Prefers oat milk latte');
});

test('client delete fails loud (409 + real error) when the DB rejects it (FK-blocked regression)', async () => {
  fake.seed('tenants', [{ id: 't9', slug: 'fk-salon', name: 'FK Salon' }]);
  fake.seed('tenant_users', [{ user_id: 'u9', tenant_id: 't9', role: 'owner' }]);
  fake.auth.getUser = async () => ({ data: { user: { id: 'u9', email: 'owner9@test.dev' } }, error: null });
  const client = { id: 'cl-9', tenant_id: 't9', first_name: 'Fk', last_name: 'Block', phone: '+15559999999', email: '' };
  fake.seed('clients', [client]);

  // DB rejects the delete (foreign key from bookings) — the handler must
  // surface the real error instead of reporting ok:true while the row lives.
  fake.failDelete('clients', 'update or delete on table \"clients\" violates foreign key constraint');
  const req = postReq({ resource: 'client', action: 'delete', id: client.id });
  const [res, out] = makeRes();
  await handler(req, res);
  assert.equal(out.code, 409, 'FK-blocked delete must be 409 — got: ' + JSON.stringify(out.body));
  assert.equal(out.body.ok, false, 'must NOT report success');
  assert.match(String(out.body.error), /violates foreign key/, 'real DB error surfaced to the operator');
  assert.equal(fake.all('clients').length, 1, 'row survives the failed delete');
  fake.clearFailures();
});

test('client delete succeeds and removes the row when nothing blocks it', async () => {
  fake.auth.getUser = async () => ({ data: { user: { id: 'u9', email: 'owner9@test.dev' } }, error: null });
  const req = postReq({ resource: 'client', action: 'delete', id: 'cl-9' });
  const [res, out] = makeRes();
  await handler(req, res);
  assert.equal(out.code, 200, 'clean delete must succeed — got: ' + JSON.stringify(out.body));
  assert.equal(out.body.ok, true);
  assert.equal(fake.all('clients').length, 0, 'row removed');
});

// ── recurring series (real identity: series_id + cadences) ───────────
// Count Telnyx SMS sends by stubbing fetch on /v2/messages.

function seriesEnv(slug, uid, svcId, staffId, extra = {}) {
  fake.seed('tenants', [{ id: uid.replace('u', 't'), slug, phone_number: '+1555' + slug.length + '0000', name: slug + ' Salon' }]);
  fake.seed('tenant_users', [{ user_id: uid, tenant_id: uid.replace('u', 't'), role: 'owner' }]);
  fake.auth.getUser = async () => ({ data: { user: { id: uid, email: uid + '@test.dev' } }, error: null });
  fake.seed('services', [{ id: svcId, tenant_id: uid.replace('u', 't'), name: 'Blowout', duration_minutes: 45, price: 70, is_active: true }]);
  fake.seed('staff', [{ id: staffId, tenant_id: uid.replace('u', 't'), name: 'Rey', role: 'Stylist', is_active: true }]);
  fake.seed('clients', []);
  fake.seed('bookings', extra.bookings || []);
  fake.seed('booking_services', []);
  fake.seed('blocked_slots', extra.blocked || []);
}

function smsCounter() {
  let smsSends = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.telnyx.com/v2/messages')) { smsSends += 1; return { ok: true, status: 200, json: async () => ({ data: { id: 'm' } }) }; }
    throw new Error('unexpected fetch: ' + url);
  };
  return { get count() { return smsSends; }, restore() { globalThis.fetch = realFetch; } };
}

test('repeat weekly generates occurrences with shared series_id, pos/total, and ONE confirmation SMS', async () => {
  seriesEnv('series-salon', 'u7', 'sv-7', 'st-7');
  const sms = smsCounter();
  try {
    const start = new Date(Date.now() + 7 * 86400000);
    start.setUTCHours(15, 0, 0, 0);
    const req = postReq({
      resource: 'appointment', service_ids: ['sv-7'], staff_id: 'st-7',
      client_name: 'Series Client', client_phone: '+15557770001',
      starts_at: start.toISOString(), channel: 'dashboard',
      repeat: { rule: 'weekly', count: 4 }
    });
    const [res, out] = makeRes();
    await handler(req, res);
    assert.equal(out.code, 200, 'series create must succeed — got: ' + JSON.stringify(out.body).slice(0, 300));
    assert.equal(out.body.ok, true);
    assert.ok(out.body.series?.id, 'series metadata carries the series_id');
    assert.equal(out.body.series.total, 4);
    assert.equal(out.body.series.rule, 'weekly');

    const rows = fake.all('bookings');
    assert.equal(rows.length, 4, 'one bookings row per occurrence');
    const ids = new Set(rows.map(r => r.series_id));
    assert.equal(ids.size, 1, 'all occurrences share ONE series_id');
    assert.ok(rows.every(r => r.series_id === out.body.series.id), 'response series_id matches the rows');
    assert.deepEqual(rows.map(r => r.series_pos).sort((a, b) => a - b), [1, 2, 3, 4], 'pos 1..4');
    assert.ok(rows.every(r => r.series_total === 4), 'series_total on every row');
    assert.ok(rows.every(r => r.series_rule === 'weekly'), 'series_rule on every row');
    const times = rows.map(r => new Date(r.start_time).getTime()).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) {
      assert.equal(times[i] - times[i - 1], 7 * 86400000, 'occurrences exactly 7 days apart');
    }
    assert.ok(rows.every(r => Number(r.total_amount) === 70), 'every occurrence priced');
    assert.ok(rows.every(r => r.confirmation_code), 'every occurrence gets a confirmation code');
    assert.ok(rows[0].notes.includes('[recurring series 1/4]'), 'first occurrence tagged');
    assert.ok(rows[3].notes.includes('[recurring series 4/4]'), 'last occurrence tagged');
    assert.equal(sms.count, 1, 'exactly ONE Telnyx SMS for the whole series — never N');
  } finally { sms.restore(); }
});

test('biweekly cadence spaces occurrences 14 days apart', async () => {
  seriesEnv('biweekly-salon', 'u9', 'sv-9', 'st-9');
  const sms = smsCounter();
  try {
    const start = new Date(Date.now() + 7 * 86400000);
    start.setUTCHours(11, 0, 0, 0);
    const req = postReq({
      resource: 'appointment', service_ids: ['sv-9'], staff_id: 'st-9',
      client_name: 'Bi Client', client_phone: '+15559990001',
      starts_at: start.toISOString(), channel: 'dashboard',
      repeat: { rule: 'biweekly', count: 3 }
    });
    const [res, out] = makeRes();
    await handler(req, res);
    assert.equal(out.code, 200, JSON.stringify(out.body).slice(0, 300));
    const rows = fake.all('bookings');
    assert.equal(rows.length, 3);
    assert.ok(rows.every(r => r.series_rule === 'biweekly'));
    const times = rows.map(r => new Date(r.start_time).getTime()).sort((a, b) => a - b);
    assert.equal(times[1] - times[0], 14 * 86400000, '14-day gap');
    assert.equal(times[2] - times[1], 14 * 86400000, '14-day gap');
    assert.equal(sms.count, 1);
  } finally { sms.restore(); }
});

test('monthly cadence keeps the day-of-month, clamping short months (Jan 31 -> Feb 28)', async () => {
  seriesEnv('monthly-salon', 'u10', 'sv-10', 'st-10');
  const sms = smsCounter();
  try {
    const start = new Date(Date.UTC(2027, 0, 31, 15, 0, 0)); // Jan 31 2027
    const req = postReq({
      resource: 'appointment', service_ids: ['sv-10'], staff_id: 'st-10',
      client_name: 'Mo Client', client_phone: '+15551010001',
      starts_at: start.toISOString(), channel: 'dashboard',
      repeat: { rule: 'monthly', count: 3 }
    });
    const [res, out] = makeRes();
    await handler(req, res);
    assert.equal(out.code, 200, JSON.stringify(out.body).slice(0, 300));
    const rows = fake.all('bookings').sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
    assert.equal(rows.length, 3);
    assert.ok(rows.every(r => r.series_rule === 'monthly'));
    const days = rows.map(r => new Date(r.start_time).getUTCDate());
    assert.deepEqual(days, [31, 28, 31], 'Jan 31, Feb 28 (clamped), Mar 31');
    assert.equal(sms.count, 1);
  } finally { sms.restore(); }
});

test('series cancel scoped "following" cancels the target and later occurrences only', async () => {
  const t = new Date(Date.now() + 14 * 86400000); t.setUTCHours(15, 0, 0, 0);
  const mk = (pos) => ({
    id: 'sbk-' + pos, tenant_id: 't8', client_id: 'cl8', service_id: 'sv-8', staff_id: 'st-8',
    start_time: new Date(t.getTime() + (pos - 1) * 7 * 86400000).toISOString(),
    end_time: new Date(t.getTime() + (pos - 1) * 7 * 86400000 + 30 * 60000).toISOString(),
    status: 'confirmed', total_amount: 40, series_id: 'series-x', series_pos: pos, series_total: 4, series_rule: 'weekly'
  });
  seriesEnv('clash-salon', 'u8', 'sv-8', 'st-8', { bookings: [mk(1), mk(2), mk(3), mk(4)] });
  fake.seed('clients', [{ id: 'cl8', tenant_id: 't8', name: 'S C', phone: '+15558880001' }]);
  const req = postReq({ resource: 'appointment', action: 'cancel', id: 'sbk-2', series_scope: 'following' });
  const [res, out] = makeRes();
  await handler(req, res);
  assert.equal(out.code, 200, JSON.stringify(out.body).slice(0, 300));
  assert.equal(out.body.cancelled, 3, 'target + later occurrences (pos 2,3,4 of 4)');
  const rows = fake.all('bookings');
  assert.equal(rows.find(r => r.id === 'sbk-1').status, 'confirmed', 'earlier occurrence untouched');
  assert.equal(rows.find(r => r.id === 'sbk-2').status, 'cancelled');
  assert.equal(rows.find(r => r.id === 'sbk-3').status, 'cancelled');
  assert.equal(rows.find(r => r.id === 'sbk-4').status, 'cancelled');
});

test('series reschedule scoped "following" moves later occurrences by the same delta', async () => {
  const t = new Date(Date.now() + 14 * 86400000); t.setUTCHours(15, 0, 0, 0);
  const mk = (pos) => ({
    id: 'rbk-' + pos, tenant_id: 't8', client_id: 'cl8', service_id: 'sv-8', staff_id: 'st-8',
    start_time: new Date(t.getTime() + (pos - 1) * 7 * 86400000).toISOString(),
    end_time: new Date(t.getTime() + (pos - 1) * 7 * 86400000 + 30 * 60000).toISOString(),
    status: 'confirmed', total_amount: 40, series_id: 'series-y', series_pos: pos, series_total: 3, series_rule: 'weekly'
  });
  seriesEnv('clash-salon', 'u8', 'sv-8', 'st-8', { bookings: [mk(1), mk(2), mk(3)] });
  fake.seed('clients', [{ id: 'cl8', tenant_id: 't8', name: 'S C', phone: '+15558880001' }]);
  const original2 = new Date(mk(2).start_time).getTime();
  const newStart = new Date(original2 + 2 * 3600000); // +2h, same slot day
  const req = postReq({ resource: 'appointment', action: 'reschedule', id: 'rbk-2', starts_at: newStart.toISOString(), series_scope: 'following' });
  const [res, out] = makeRes();
  await handler(req, res);
  assert.equal(out.code, 200, JSON.stringify(out.body).slice(0, 300));
  const rows = fake.all('bookings');
  const r2 = rows.find(r => r.id === 'rbk-2');
  const r3 = rows.find(r => r.id === 'rbk-3');
  assert.equal(new Date(r2.start_time).getTime(), newStart.getTime(), 'target moved +2h');
  const delta = newStart.getTime() - original2;
  assert.equal(new Date(r3.start_time).getTime(), new Date(new Date(mk(3).start_time).getTime() + delta).getTime(), 'later occurrence shifted by the same +2h delta');
  assert.equal(new Date(r3.start_time).getTime() - new Date(r2.start_time).getTime(), 7 * 86400000, 'cadence preserved');
});

