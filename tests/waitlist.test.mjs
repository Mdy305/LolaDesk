/**
 * tests/waitlist.test.mjs — the booking waitlist, end to end.
 *
 * Run:
 *   node tests/waitlist.test.mjs
 *   node --test tests/
 *
 * Exercises the REAL repository functions and the REAL booking-brain
 * waitlist_add action against the in-memory fake DB: add/list/remove,
 * match-on-cancel (the revenue-recovery moment), the voice promise now
 * fulfilling ("I'll add you to the priority waitlist"), and the billing
 * gate never blocking a waitlist entry (a waitlist is not a booking).
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
  '// Generated test double — see tests/waitlist.test.mjs',
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
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const repo = await import('../api/lib/booking-repository.js');
const { runBookingAction } = await import('../api/lib/booking-brain.js');
const { offerFreedSlot } = await import('../api/lib/booking-reminders.js');

const T1 = 'tenant-one', T2 = 'tenant-two';
const TENANT = { id: T1, name: 'Salon One', phone_number: '+15551234567', subscription_status: 'trial', trial_ends_at: new Date(Date.now() - 86400000).toISOString() };
const SERVICE = { id: 'svc-1', tenant_id: T1, name: 'Balayage', price: 180, duration_minutes: 120, is_active: true };

function fresh(){
  fake.seed('booking_waitlist', []);
  fake.seed('tenants', [TENANT, { id: T2, name: 'Salon Two', subscription_status: 'trial', trial_ends_at: null }]);
  fake.seed('services', [SERVICE, { id: 'svc-2', tenant_id: T1, name: 'Cut', price: 60, duration_minutes: 45, is_active: true }]);
  fake.seed('clients', []);
  fake.seed('bookings', []);
  fake.seed('booking_status_history', []);
}

// Intercept the Telnyx /v2/messages POST (what sendSMS uses) and record it.
function telnyxSpy(overrides = {}){
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('/v2/messages')){
      calls.push({ url: String(url), body: JSON.parse(opts.body || '{}') });
      return { ok: true, status: 200, json: async () => ({ data: { id: 'msg-1' } }) };
    }
    return realFetch(url, opts);
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

// ── repository ─────────────────────────────────────────────────────
test('addToWaitlist lands a row with status active, tenant-scoped', async () => {
  fresh();
  const e = await repo.addToWaitlist({ tenantId: T1, clientName: 'Maya', clientPhone: '5551234', serviceId: SERVICE.id, serviceName: 'Balayage', source: 'voice' });
  assert.ok(e && e.id);
  assert.equal(e.status, 'active');
  assert.equal(e.tenant_id, T1);
  assert.equal(e.service_name, 'Balayage');
  assert.equal(e.source, 'voice');
  const rows = fake.tables.get('booking_waitlist') || [];
  assert.equal(rows.length, 1);
});

test('listWaitlist is scoped per tenant and newest first', async () => {
  fresh();
  await repo.addToWaitlist({ tenantId: T1, clientName: 'A', serviceName: 'Balayage', source: 'voice' });
  await repo.addToWaitlist({ tenantId: T1, clientName: 'B', serviceName: 'Cut', source: 'widget' });
  await repo.addToWaitlist({ tenantId: T2, clientName: 'Other', serviceName: 'Cut', source: 'voice' });
  const t1 = await repo.listWaitlist(T1);
  assert.equal(t1.length, 2);
  assert.ok(t1.every(r => r.tenant_id === T1));
  const t2 = await repo.listWaitlist(T2);
  assert.equal(t2.length, 1);
  assert.equal(t2[0].client_name, 'Other');
});

test('removeFromWaitlist flips the status and drops it from the active list', async () => {
  fresh();
  const e = await repo.addToWaitlist({ tenantId: T1, clientName: 'Maya', serviceName: 'Balayage' });
  const removed = await repo.removeFromWaitlist(T1, e.id, 'removed');
  assert.equal(removed.status, 'removed');
  assert.equal((await repo.listWaitlist(T1)).length, 0);
});

test('findWaitlistMatches matches the freed service, plus general standbys', async () => {
  fresh();
  const balayage = await repo.addToWaitlist({ tenantId: T1, clientName: 'Maya', serviceId: SERVICE.id, serviceName: 'Balayage' });
  await repo.addToWaitlist({ tenantId: T1, clientName: 'CutPerson', serviceId: 'svc-2', serviceName: 'Cut' });
  await repo.addToWaitlist({ tenantId: T1, clientName: 'Flexible', serviceName: null, notes: 'any time' });
  await repo.addToWaitlist({ tenantId: T2, clientName: 'OtherTenant', serviceId: SERVICE.id, serviceName: 'Balayage' });
  const m = await repo.findWaitlistMatches(T1, { serviceId: SERVICE.id, serviceName: 'Balayage' });
  assert.equal(m.count, 2); // Maya + general standby; Cut and other-tenant excluded
  assert.ok(m.entries.some(e => e.id === balayage.id));
});

// ── booking-brain (the voice fulfillment) ──────────────────────────
test('waitlist_add through runBookingAction writes a real row and confirms by voice', async () => {
  fresh();
  const r = await runBookingAction('waitlist_add', TENANT, { client_name: 'Maya', client_phone: '5551234', service: 'Balayage' }, { channel: 'voice' });
  assert.equal(r.ok, true);
  assert.equal(r.waitlisted, true);
  assert.ok(r.entry && r.entry.id);
  assert.match(r.speak, /priority waitlist/i);
  const rows = fake.tables.get('booking_waitlist') || [];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].client_name, 'Maya');
  assert.equal(rows[0].tenant_id, T1);
  assert.equal(rows[0].source, 'voice');
});

test('waitlist_add is NOT blocked by the billing gate — a waitlist is not a booking', async () => {
  fresh();
  // TENANT has an EXPIRED trial; booking would be blocked, waitlist must not be.
  const r = await runBookingAction('waitlist_add', TENANT, { client_name: 'Maya', client_phone: '5551234', service_name: 'Balayage' }, { channel: 'voice' });
  assert.equal(r.ok, true);
  assert.equal(r.waitlisted, true);
  assert.notEqual(r.reason, 'trial_expired');
});

test('cancelAppointment surfaces matching waitlist entries (revenue recovery)', async () => {
  fresh();
  fake.seed('bookings', [{ id: 'bk-1', tenant_id: T1, client_id: 'cl-1', service_id: SERVICE.id, service_name: 'Balayage', service: 'Balayage', start_time: new Date(Date.now() + 86400000).toISOString(), starts_at: new Date(Date.now() + 86400000).toISOString(), status: 'confirmed', confirmation_code: 'ABC123' }]);
  fake.seed('clients', [{ id: 'cl-1', tenant_id: T1, name: 'Maya', phone: '5551234' }]);
  await repo.addToWaitlist({ tenantId: T1, clientName: 'Maya', clientPhone: '5551234', serviceId: SERVICE.id, serviceName: 'Balayage', source: 'voice' });
  const r = await runBookingAction('cancel_appointment', TENANT, { booking_id: 'bk-1', reason: 'client_request' }, { channel: 'voice' });
  assert.equal(r.ok, true);
  assert.equal(r.cancelled, true);
  assert.ok(r.waitlist_matches);
  assert.equal(r.waitlist_matches.count, 1);
  assert.match(r.speak, /waitlist/i);
  // the cancelled booking is no longer confirmed
  const row = (fake.tables.get('bookings') || []).find(b => b.id === 'bk-1');
  assert.equal(row.status, 'cancelled');
});

test('cancel with nobody waiting returns zero matches and no waitlist chatter', async () => {
  fresh();
  fake.seed('bookings', [{ id: 'bk-2', tenant_id: T1, client_id: 'cl-1', service_id: SERVICE.id, service_name: 'Balayage', service: 'Balayage', start_time: new Date(Date.now() + 86400000).toISOString(), starts_at: new Date(Date.now() + 86400000).toISOString(), status: 'confirmed' }]);
  fake.seed('clients', [{ id: 'cl-1', tenant_id: T1, name: 'Maya', phone: '5551234' }]);
  const r = await runBookingAction('cancel_appointment', TENANT, { booking_id: 'bk-2' }, { channel: 'voice' });
  assert.equal(r.ok, true);
  assert.equal(r.waitlist_matches.count, 0);
  assert.doesNotMatch(r.speak, /waitlist/i);
});

// ── the demand-conversion SMS (offerFreedSlot) ─────────────────────
test('waitlist_add records explicit sms_consent and confirms the text promise', async () => {
  fresh();
  const r = await runBookingAction('waitlist_add', TENANT, { client_name: 'Maya', client_phone: '5551234', service: 'Balayage', sms_consent: true }, { channel: 'voice' });
  assert.equal(r.ok, true);
  assert.equal(r.sms_consent, true);
  assert.match(r.speak, /text you the moment a slot opens/i);
  const rows = fake.tables.get('booking_waitlist') || [];
  assert.equal(rows[0].sms_consent, true);
});

test('waitlist_add without consent never promises a text', async () => {
  fresh();
  const r = await runBookingAction('waitlist_add', TENANT, { client_name: 'Maya', client_phone: '5551234', service: 'Balayage' }, { channel: 'voice' });
  assert.equal(r.ok, true);
  assert.equal(r.sms_consent, false);
  assert.doesNotMatch(r.speak, /text you the moment/i);
  assert.match(r.speak, /check back/i);
});

test('offerFreedSlot texts the first consenting client and marks them offered', async () => {
  fresh();
  await repo.addToWaitlist({ tenantId: T1, clientName: 'NoConsent', clientPhone: '5550000', serviceId: SERVICE.id, serviceName: 'Balayage', source: 'voice', smsConsent: false });
  await repo.addToWaitlist({ tenantId: T1, clientName: 'Maya', clientPhone: '5551234', serviceId: SERVICE.id, serviceName: 'Balayage', source: 'voice', smsConsent: true });
  const spy = telnyxSpy();
  try{
    const r = await offerFreedSlot({ tenantId: T1, serviceId: SERVICE.id, serviceName: 'Balayage', freedAt: new Date(Date.now() + 86400000).toISOString() });
    assert.equal(r.ok, true);
    assert.equal(r.sent, true);
    assert.equal(r.entry.client_name, 'Maya'); // first CONSENTING client, not the first entry
    assert.equal(spy.calls.length, 1);
    const body = spy.calls[0].body;
    assert.equal(body.to, '5551234');
    assert.equal(body.from, '+15551234567');
    assert.match(body.text, /Balayage spot just opened/i);
    assert.match(body.text, /STOP to opt out/i);
    const rows = fake.tables.get('booking_waitlist') || [];
    const maya = rows.find(x => x.client_name === 'Maya');
    assert.equal(maya.status, 'offered');
    const noConsent = rows.find(x => x.client_name === 'NoConsent');
    assert.equal(noConsent.status, 'active'); // untouched
  }finally{ spy.restore(); }
});

test('offerFreedSlot never sends without consent — skipped, no Telnyx call', async () => {
  fresh();
  await repo.addToWaitlist({ tenantId: T1, clientName: 'Maya', clientPhone: '5551234', serviceId: SERVICE.id, serviceName: 'Balayage', source: 'voice', smsConsent: false });
  const spy = telnyxSpy();
  try{
    const r = await offerFreedSlot({ tenantId: T1, serviceId: SERVICE.id, serviceName: 'Balayage', freedAt: new Date(Date.now() + 86400000).toISOString() });
    assert.equal(r.ok, undefined);
    assert.equal(r.skipped, true);
    assert.equal(r.reason, 'no_consent');
    assert.equal(spy.calls.length, 0);
    const rows = fake.tables.get('booking_waitlist') || [];
    assert.equal(rows[0].status, 'active');
  }finally{ spy.restore(); }
});

test('offerFreedSlot no-ops when the tenant has no from-number (SMS unconfigured)', async () => {
  fresh();
  fake.seed('tenants', [{ id: T2, name: 'No Phone Salon', phone_number: null }]);
  await repo.addToWaitlist({ tenantId: T2, clientName: 'Maya', clientPhone: '5551234', serviceId: SERVICE.id, serviceName: 'Balayage', source: 'voice', smsConsent: true });
  const spy = telnyxSpy();
  try{
    const r = await offerFreedSlot({ tenantId: T2, serviceId: SERVICE.id, serviceName: 'Balayage', freedAt: new Date(Date.now() + 86400000).toISOString() });
    assert.equal(r.skipped, true);
    assert.equal(r.reason, 'no_from_number');
    assert.equal(spy.calls.length, 0);
    // entry stays active so it can be offered once a number is attached
    const rows = fake.tables.get('booking_waitlist') || [];
    assert.equal(rows[0].status, 'active');
  }finally{ spy.restore(); }
});

test('offerFreedSlot no-ops on a slot that already passed and on no matches', async () => {
  fresh();
  await repo.addToWaitlist({ tenantId: T1, clientName: 'Maya', clientPhone: '5551234', serviceId: SERVICE.id, serviceName: 'Balayage', source: 'voice', smsConsent: true });
  const spy = telnyxSpy();
  try{
    const past = await offerFreedSlot({ tenantId: T1, serviceId: SERVICE.id, serviceName: 'Balayage', freedAt: new Date(Date.now() - 86400000).toISOString() });
    assert.equal(past.skipped, true);
    assert.equal(past.reason, 'slot_passed');
    const none = await offerFreedSlot({ tenantId: T1, serviceId: 'svc-999', serviceName: 'Nope', freedAt: new Date(Date.now() + 86400000).toISOString() });
    assert.equal(none.skipped, true);
    assert.equal(none.reason, 'no_matches');
    assert.equal(spy.calls.length, 0);
  }finally{ spy.restore(); }
});

test('cancelAppointment sends the offer SMS to a consenting waitlisted client', async () => {
  fresh();
  fake.seed('bookings', [{ id: 'bk-3', tenant_id: T1, client_id: 'cl-1', service_id: SERVICE.id, service_name: 'Balayage', service: 'Balayage', start_time: new Date(Date.now() + 86400000).toISOString(), starts_at: new Date(Date.now() + 86400000).toISOString(), status: 'confirmed', confirmation_code: 'ABC124' }]);
  fake.seed('clients', [{ id: 'cl-1', tenant_id: T1, name: 'Maya', phone: '5551234' }]);
  await repo.addToWaitlist({ tenantId: T1, clientName: 'Maya', clientPhone: '5551234', serviceId: SERVICE.id, serviceName: 'Balayage', source: 'voice', smsConsent: true });
  const spy = telnyxSpy();
  try{
    const r = await runBookingAction('cancel_appointment', TENANT, { booking_id: 'bk-3', reason: 'client_request' }, { channel: 'voice' });
    assert.equal(r.ok, true);
    assert.equal(r.waitlist_matches.count, 1);
    assert.equal(r.waitlist_offer.ok, true);
    assert.equal(spy.calls.length, 1);
    assert.match(spy.calls[0].body.text, /Balayage spot just opened/i);
    assert.match(r.speak, /texted the first person/i);
    const rows = fake.tables.get('booking_waitlist') || [];
    assert.equal(rows[0].status, 'offered');
  }finally{ spy.restore(); }
});
