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
