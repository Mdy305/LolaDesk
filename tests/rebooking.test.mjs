/**
 * tests/rebooking.test.mjs — the auto-rebooking loop (Loop #3), end to end.
 *
 * Run:
 *   node tests/rebooking.test.mjs
 *   node --test tests/
 *
 * Proves the loop against the in-memory fake DB:
 *   • policy resolution tolerates junk config (off / defaults / clamps)
 *   • target-date math (interval, junk input)
 *   • offerRebooking proposes a REAL engine slot (schedules + blocked time
 *     apply), writes the offer row, and texts the persona copy once
 *   • the skip ladder (policy off, no completion, no client, no service,
 *     exactly-once per booking, engine with no open slots)
 *   • the completion seam: marking a booking completed via /api/salon fires
 *     exactly one offer; re-completing or moving it fires none
 *   • acceptance: creating the next booking through createCanonicalBooking
 *     flips the open offer to `booked` (the dynamic-import path)
 *   • the hourly sweep: advances a filled slot to the next open day with one
 *     re-text, expires out-of-window offers with one nudge, expires quietly
 *     when the completed booking was undone, and re-runs nothing (exactly-once)
 *   • the persona owns the client-facing copy (valet voice, facts intact)
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
  name: '@supabase/supabase-js', version: '0.0.0-test', type: 'module', main: 'index.js', exports: { '.': './index.js' }
}, null, 2));
writeFileSync(join(STUB_DIR, 'index.js'), [
  '// Generated test double — see tests/rebooking.test.mjs',
  'export function createClient() {',
  '  const fake = globalThis.__LOLA_FAKE_SUPABASE__;',
  "  if (!fake) throw new Error('No fake Supabase registered');",
  '  return fake;',
  '}',
  ''
].join('\n'));

const fake = new FakeSupabase();
globalThis.__LOLA_FAKE_SUPABASE__ = fake;
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'fake-service-key';
delete process.env.STRIPE_SECRET_KEY; // deposits off — this suite isolates rebooking

const rebooking = await import('../api/lib/rebooking.js');
const persona = await import('../api/lib/lola-persona.js');
const repo = await import('../api/lib/booking-repository.js');
const { default: salonHandler } = await import('../api/salon.js');

const T1 = 'tenant-rb';
const TENANT = { id: T1, name: 'Valet Suites Beverly Hills', phone_number: '+15551000001', owner_email: 'owner@valetsuites.com', slug: 'valet-suites' };
const CLIENT = { id: 'cl-1', tenant_id: T1, name: 'Maya', phone: '+15551000002' };
const SERVICE = { id: 'svc-1', tenant_id: T1, name: 'Balayage', price: 200, duration_minutes: 120, is_active: true };
const STAFF = { id: 'st-1', tenant_id: T1, name: 'Gigi', is_active: true };
const POLICY = { enabled: true, interval_days: 42, window_days: 7 };

const HOUR = 3600000;
const DAY = 86400000;

// Completed visit this morning; the target date (interval out) is a weekday
// whose local 9:00 AM is guaranteed in the future at test-run time.
const COMPLETED_AT = new Date(Date.now() - 3 * HOUR);
const TARGET = new Date(COMPLETED_AT.getTime() + POLICY.interval_days * DAY);
const TARGET_KEY = TARGET.toISOString().slice(0, 10);
const BOOKING = {
  id: 'bk-1', tenant_id: T1, client_id: CLIENT.id, service_id: SERVICE.id,
  staff_id: STAFF.id, start_time: new Date(COMPLETED_AT.getTime() - 2 * HOUR).toISOString(),
  end_time: COMPLETED_AT.toISOString(), status: 'completed', total_amount: 200,
  completed_at: COMPLETED_AT.toISOString(), updated_at: COMPLETED_AT.toISOString()
};

function fresh({ metadata } = {}){
  fake.reset();
  fake.seed('tenants', [TENANT]);
  fake.seed('booking_settings', [{ tenant_id: T1, timezone: 'America/New_York',
    metadata: metadata === undefined ? { rebooking: POLICY, deposits: { enabled: false } } : metadata }]);
  fake.seed('clients', [CLIENT]);
  fake.seed('services', [SERVICE]);
  fake.seed('staff', [STAFF]);
  // Gigi works every day 09:00–18:00 — the loop may re-propose on any day.
  fake.seed('staff_schedules', [0, 1, 2, 3, 4, 5, 6].map(d => ({ tenant_id: T1, staff_id: STAFF.id, day_of_week: d, start_time: '09:00:00', end_time: '18:00:00' })));
  fake.seed('blocked_slots', []);
  fake.seed('staff_time_off', []);
  fake.seed('availability_holds', []);
  fake.seed('bookings', [BOOKING]);
  fake.seed('rebooking_offers', []);
  fake.seed('booking_history', []);
}
function seedOffers(rows){ fake.seed('rebooking_offers', rows); }

function offerRow(overrides = {}){
  const target = new Date(COMPLETED_AT.getTime() + 42 * DAY);
  return {
    id: 'ro-1', tenant_id: T1, booking_id: 'bk-1', client_id: CLIENT.id, service_id: SERVICE.id,
    staff_id: STAFF.id, proposed_start: new Date(target.setHours(14, 0, 0, 0)).toISOString(),
    window_end: new Date(Date.now() + 2 * DAY).toISOString(), status: 'offered',
    advanced_count: 0, last_texted_at: null, created_at: COMPLETED_AT.toISOString(), ...overrides
  };
}

// Telnyx SMS stub — records every send.
function stubSMS(){
  const sms = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('/v2/messages')){
      sms.push(JSON.parse(opts.body || '{}'));
      return { ok: true, status: 200, json: async () => ({ data: { id: 'msg-1' } }) };
    }
    return realFetch(url, opts);
  };
  return { sms, restore: () => { globalThis.fetch = realFetch; } };
}

// ── policy resolution ──────────────────────────────────────────────
test('resolvePolicy is null when rebooking is off or junk', () => {
  assert.equal(rebooking.resolvePolicy(null), null);
  assert.equal(rebooking.resolvePolicy({ metadata: {} }), null);
  assert.equal(rebooking.resolvePolicy({ metadata: { rebooking: { enabled: false, interval_days: 10 } } }), null);
  assert.equal(rebooking.resolvePolicy({ metadata: { rebooking: 'on' } }), null);
});

test('resolvePolicy defaults and clamps bad values', () => {
  const p = rebooking.resolvePolicy({ metadata: { rebooking: { enabled: true, interval_days: -5, window_days: 400 } } });
  assert.equal(p.interval_days, rebooking.REBOOK_DEFAULTS.interval_days);
  assert.equal(p.window_days, 60); // hard clamp
  const d = rebooking.resolvePolicy({ metadata: { rebooking: { enabled: true } } });
  assert.equal(d.interval_days, rebooking.REBOOK_DEFAULTS.interval_days);
  assert.equal(d.window_days, rebooking.REBOOK_DEFAULTS.window_days);
});

// ── target math ────────────────────────────────────────────────────
test('computeTargetDate: interval days out, junk → null', () => {
  const t = rebooking.computeTargetDate('2026-01-01T15:00:00Z', 42);
  assert.equal(t.toISOString(), '2026-02-12T15:00:00.000Z');
  assert.equal(rebooking.computeTargetDate('not-a-date', 42), null);
  assert.ok(rebooking.computeTargetDate(new Date().toISOString(), 0)); // falls back to the default interval
});

// ── offerRebooking ─────────────────────────────────────────────────
test('offerRebooking proposes a real engine slot, writes the row, texts once', async () => {
  fresh();
  const v = stubSMS();
  try{
    const r = await rebooking.offerRebooking({ tenantId: T1, booking: BOOKING, policy: POLICY });
    assert.equal(r.ok, true);
    const rows = fake.tables.get('rebooking_offers') || [];
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.booking_id, BOOKING.id);
    assert.equal(row.client_id, CLIENT.id);
    assert.equal(row.service_id, SERVICE.id);
    assert.equal(row.status, 'offered');
    assert.ok(row.proposed_start, 'a concrete slot was proposed');
    assert.ok(new Date(row.proposed_start).toISOString().slice(0, 10) === TARGET_KEY, 'slot is on the interval target date');
    assert.ok(new Date(row.window_end) > new Date(row.proposed_start), 'window outlives the proposed slot');
    assert.equal(v.sms.length, 1);
    assert.equal(v.sms[0].to, CLIENT.phone);
    assert.ok(v.sms[0].text.includes('Balayage') && v.sms[0].text.includes('Gigi'), 'copy carries the service and the stylist');
  } finally { v.restore(); }
});

test('offerRebooking skip ladder: policy off, no completion, no client, no service, already offered, engine empty', async () => {
  fresh({ metadata: { rebooking: { enabled: false }, deposits: { enabled: false } } });
  let r = await rebooking.offerRebooking({ tenantId: T1, booking: BOOKING });
  assert.equal(r.reason, 'policy_off');

  fresh();
  r = await rebooking.offerRebooking({ tenantId: T1, booking: { ...BOOKING, completed_at: undefined } });
  assert.equal(r.reason, 'no_completion');

  r = await rebooking.offerRebooking({ tenantId: T1, booking: { ...BOOKING, client_id: null } });
  assert.equal(r.reason, 'no_client');

  r = await rebooking.offerRebooking({ tenantId: T1, booking: { ...BOOKING, service_id: null } });
  assert.equal(r.reason, 'no_service');

  // Exactly-once per completed booking.
  seedOffers([offerRow()]);
  r = await rebooking.offerRebooking({ tenantId: T1, booking: BOOKING, policy: POLICY });
  assert.equal(r.reason, 'already_offered');
  assert.equal((fake.tables.get('rebooking_offers') || []).length, 1);

  // No open slot that day → nothing proposed, nothing sent.
  fresh();
  fake.seed('staff_schedules', []); // nobody works the target date
  r = await rebooking.offerRebooking({ tenantId: T1, booking: BOOKING, policy: POLICY });
  assert.equal(r.reason, 'no_slots_in_window');
  assert.equal((fake.tables.get('rebooking_offers') || []).length, 0);
});

// ── the completion seam (real handler) ─────────────────────────────
function makeRes(){
  const res = { statusCode: 200, headers: {}, body: null };
  res.status = function(code){ this.statusCode = code; return this; };
  res.setHeader = function(){ return res; };
  res.json = function(data){ res.body = data; return res; };
  return res;
}

test('marking a booking completed via /api/salon fires exactly one offer', async () => {
  process.env.TELNYX_API_KEY = 'key123';
  fresh();
  const v = stubSMS();
  try{
    const res = makeRes();
    await salonHandler({ method: 'POST', headers: {}, query: { t: 'valet-suites' }, body: JSON.stringify({
      resource: 'booking', action: 'update', id: BOOKING.id, status: 'completed'
    }) }, res);
    assert.equal(res.statusCode, 200);
    await new Promise(r => setImmediate(r)); // the seam is fire-and-forget
    const rows = fake.tables.get('rebooking_offers') || [];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'offered');
    assert.equal(v.sms.length, 1);
  } finally { v.restore(); }
});

test('re-completing or rescheduling the same booking never re-offers', async () => {
  process.env.TELNYX_API_KEY = 'key123';
  fresh();
  const v = stubSMS();
  try{
    const res = makeRes();
    await salonHandler({ method: 'POST', headers: {}, query: { t: 'valet-suites' }, body: JSON.stringify({
      resource: 'booking', action: 'update', id: BOOKING.id, status: 'completed'
    }) }, res);
    await new Promise(r => setImmediate(r));
    // A second completion write of the same visit (owner toggles, double-click).
    const res2 = makeRes();
    await salonHandler({ method: 'POST', headers: {}, query: { t: 'valet-suites' }, body: JSON.stringify({
      resource: 'booking', action: 'update', id: BOOKING.id, status: 'completed'
    }) }, res2);
    await new Promise(r => setImmediate(r));
    // A plain reschedule (no status) must not offer either.
    const res3 = makeRes();
    await salonHandler({ method: 'POST', headers: {}, query: { t: 'valet-suites' }, body: JSON.stringify({
      resource: 'booking', action: 'reschedule', id: BOOKING.id, starts_at: new Date(Date.now() + DAY).toISOString()
    }) }, res3);
    await new Promise(r => setImmediate(r));
    const rows = fake.tables.get('rebooking_offers') || [];
    assert.equal(rows.length, 1);
    assert.equal(v.sms.length, 1);
  } finally { v.restore(); }
});

// ── acceptance through the booking path ────────────────────────────
test('the client booking the service again flips the open offer to booked', async () => {
  fresh();
  const v = stubSMS();
  try{
    const open = offerRow();
    seedOffers([open]);
    await repo.createCanonicalBooking({
      tenantId: T1, clientId: CLIENT.id, serviceId: SERVICE.id,
      startTime: new Date(Date.now() + 30 * DAY).toISOString(),
      endTime: new Date(Date.now() + 30 * DAY + 2 * HOUR).toISOString(),
      status: 'confirmed', totalAmount: 200, source: 'dashboard', sendConfirmation: true
    });
    await new Promise(r => setImmediate(r)); // acceptance is fire-and-forget
    const row = (fake.tables.get('rebooking_offers') || [])[0];
    assert.equal(row.status, 'booked');
  } finally { v.restore(); }
});

// ── the hourly sweep ───────────────────────────────────────────────
test('sweep: a filled slot advances to the next open day with one re-text', async () => {
  fresh();
  const v = stubSMS();
  try{
    // The offer proposed a slot for "now minus an hour" — it has since been
    // taken; the sweep runs one hour later, inside the offer window.
    const past = new Date(Date.now() - HOUR);
    const o = offerRow({ proposed_start: past.toISOString(), status: 'offered',
      window_end: new Date(Date.now() + 20 * DAY).toISOString() });
    seedOffers([o]);
    const r = await rebooking.runRebookingSweep(new Date());
    assert.equal(r.advanced, 1);
    assert.equal(r.retexted, 1);
    const row = (fake.tables.get('rebooking_offers') || [])[0];
    assert.equal(row.status, 'advanced');
    assert.equal(row.advanced_count, 1);
    assert.ok(new Date(row.proposed_start) > new Date(o.proposed_start), 'moved to a later slot');
    assert.equal(v.sms.length, 1);
    assert.ok(v.sms[0].text.includes('Balayage'));
  } finally { v.restore(); }
});

test('sweep: an out-of-window offer expires with exactly one nudge text', async () => {
  fresh();
  const v = stubSMS();
  try{
    seedOffers([offerRow({ window_end: new Date(Date.now() - HOUR).toISOString() })]);
    const r = await rebooking.runRebookingSweep(new Date());
    assert.equal(r.expired, 1);
    assert.equal(r.retexted, 1);
    const row = (fake.tables.get('rebooking_offers') || [])[0];
    assert.equal(row.status, 'expired');
    assert.equal(v.sms.length, 1);
    // Second pass: the nudge never repeats.
    const r2 = await rebooking.runRebookingSweep(new Date());
    assert.equal(r2.checked, 0);
    assert.equal(v.sms.length, 1);
  } finally { v.restore(); }
});

test('sweep: an offer on a since-cancelled booking expires quietly', async () => {
  fresh();
  const v = stubSMS();
  try{
    seedOffers([offerRow({ window_end: new Date(Date.now() - HOUR).toISOString() })]);
    fake.seed('bookings', [{ ...BOOKING, status: 'cancelled' }]);
    const r = await rebooking.runRebookingSweep(new Date());
    assert.equal(r.expired, 1);
    assert.equal(r.retexted, 0); // no nudge on a dead visit
    assert.equal(v.sms.length, 0);
  } finally { v.restore(); }
});

test('sweep is exactly-once and never double-texts across ticks', async () => {
  fresh();
  const v = stubSMS();
  try{
    const past = new Date(Date.now() - HOUR);
    seedOffers([offerRow({ proposed_start: past.toISOString(),
      window_end: new Date(Date.now() + 20 * DAY).toISOString() })]);
    await rebooking.runRebookingSweep(new Date());
    const first = (fake.tables.get('rebooking_offers') || [])[0];
    // Overlapping tick while the row is mid-flight ('advancing'): skipped.
    fake.seed('rebooking_offers', [{ ...first, status: 'advancing' }]);
    const r2 = await rebooking.runRebookingSweep(new Date());
    assert.equal(r2.advanced, 0);
    assert.equal(v.sms.length, 1); // still exactly one text total
  } finally { v.restore(); }
});

// ── persona owns the copy ──────────────────────────────────────────
test('rebooking copy speaks in the valet voice with the facts intact', () => {
  const offer = persona.rebookingOfferText({ firstName: 'Maya', salon: 'Valet Suites', serviceName: 'Balayage', when: 'Fri, Feb 13, 2:00 PM', staffName: 'Gigi' });
  assert.ok(offer.includes('Maya') && offer.includes('Balayage') && offer.includes('Fri, Feb 13, 2:00 PM') && offer.includes('Gigi'));
  assert.ok(offer.includes('STOP'));
  const exp = persona.rebookingExpiredText({ firstName: 'Maya', salon: 'Valet Suites', serviceName: 'Balayage' });
  assert.ok(exp.includes('Maya') && exp.includes('Balayage') && exp.includes('STOP'));
});
