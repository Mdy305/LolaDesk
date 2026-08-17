/**
 * tests/billing-gate.test.mjs — the trial-to-paid paywall.
 *
 * Run:
 *   node tests/billing-gate.test.mjs
 *   node --test tests/
 *
 * Exercises the REAL lib/billing-gate.js pure gate, then proves the gate is
 * enforced end-to-end through runBookingAction (booking-brain) and
 * executeSkill (the legacy lola-tools layer) against the in-memory fake DB.
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
  '// Generated test double — see tests/billing-gate.test.mjs',
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
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const { billingGate, bookingGateResponse } = await import('../api/lib/billing-gate.js');
const { runBookingAction } = await import('../api/lib/booking-brain.js');
const { executeSkill } = await import('../api/lib/orchestrator.js');

const past = new Date(Date.now() - 86400000).toISOString();      // 1 day ago
const future = new Date(Date.now() + 86400000).toISOString();    // 1 day ahead

// ── pure gate ──────────────────────────────────────────────────────
test('active subscription is never blocked, even with an expired trial', () => {
  const g = billingGate({ id: 't1', subscription_status: 'active', trial_ends_at: past });
  assert.equal(g.blocked, false);
});

test('canceling (paid through period end) is allowed', () => {
  const g = billingGate({ id: 't1', subscription_status: 'canceling' });
  assert.equal(g.blocked, false);
});

test('expired trial blocks with reason trial_expired and an upgrade prompt', () => {
  const g = billingGate({ id: 't1', subscription_status: 'trial', trial_ends_at: past });
  assert.equal(g.blocked, true);
  assert.equal(g.reason, 'trial_expired');
  assert.match(g.ownerSpeak, /trial has ended/);
  assert.match(g.callerSpeak, /isn't taking new bookings/i);
  // caller-facing line must never leak billing state
  assert.ok(!/trial|subscribe|payment/i.test(g.callerSpeak));
});

test('future trial end is allowed', () => {
  const g = billingGate({ id: 't1', subscription_status: 'trial', trial_ends_at: future });
  assert.equal(g.blocked, false);
});

test('null trial_ends_at (legacy tenant) is allowed — never blocks existing tenants', () => {
  assert.equal(billingGate({ id: 't1', subscription_status: 'trial', trial_ends_at: null }).blocked, false);
  assert.equal(billingGate({ id: 't1' }).blocked, false);
});

test('suspended and canceled and past_due all block', () => {
  assert.equal(billingGate({ id: 't1', billing_status: 'suspended' }).blocked, true);
  assert.equal(billingGate({ id: 't1', subscription_status: 'canceled' }).blocked, true);
  assert.equal(billingGate({ id: 't1', subscription_status: 'past_due' }).blocked, true);
});

test('bookingGateResponse picks owner vs caller message by channel', () => {
  const tenant = { id: 't1', subscription_status: 'trial', trial_ends_at: past };
  const gate = billingGate(tenant);
  const owner = bookingGateResponse(tenant, 'operator');
  const caller = bookingGateResponse(tenant, 'voice');
  assert.equal(owner.speak, gate.ownerSpeak);
  assert.equal(caller.speak, gate.callerSpeak);
  assert.equal(owner.needs, 'upgrade');
  assert.equal(owner.ok, false);
});

test('bookingGateResponse returns null when booking is allowed', () => {
  assert.equal(bookingGateResponse({ id: 't1', subscription_status: 'active' }, 'voice'), null);
});

// ── enforcement through booking-brain ──────────────────────────────
async function quietAsync(fn){
  const orig = console.error;
  console.error = () => {};
  try{ return await fn(); }finally{ console.error = orig; }
}

test('runBookingAction blocks book_appointment for an expired tenant', async () => {
  const tenant = { id: 't-expired', slug: 'salon', name: 'Salon', subscription_status: 'trial', trial_ends_at: past };
  const r = await runBookingAction('book_appointment', tenant, { service: 'Cut' }, { channel: 'voice' });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
  assert.equal(r.reason, 'trial_expired');
  assert.equal(r.needs, 'upgrade');
  // no booking written
  assert.equal(fake.all('bookings').length, 0);
});

test('runBookingAction blocks check_availability and reschedule, allows cancel', async () => {
  const tenant = { id: 't-expired', slug: 'salon', name: 'Salon', subscription_status: 'trial', trial_ends_at: past };
  const check = await runBookingAction('check_availability', tenant, { service: 'Cut' }, { channel: 'voice' });
  assert.equal(check.blocked, true);

  const resched = await runBookingAction('reschedule_appointment', tenant, { booking_id: 'b1', starts_at: future }, { channel: 'voice' });
  assert.equal(resched.blocked, true);

  // cancel is deliberately NOT gated (never strands a client)
  const cancel = await runBookingAction('cancel_appointment', tenant, { booking_id: 'b-missing' }, { channel: 'voice' });
  assert.equal(cancel.blocked, undefined);
});

test('runBookingAction lets an active tenant book', async () => {
  const tenant = { id: 't-active', slug: 'salon', name: 'Salon', subscription_status: 'active' };
  const r = await runBookingAction('book_appointment', tenant, { service: 'Cut' }, { channel: 'voice' });
  assert.notEqual(r.blocked, true);
});

test('owner channel gets the conversion message through runBookingAction', async () => {
  const tenant = { id: 't-expired', slug: 'salon', name: 'Salon', subscription_status: 'trial', trial_ends_at: past };
  const r = await runBookingAction('book_appointment', tenant, { service: 'Cut' }, { channel: 'operator' });
  assert.equal(r.blocked, true);
  assert.match(r.speak, /trial has ended/);
});

// ── enforcement through the legacy skill layer ─────────────────────
test('executeSkill blocks booking skills for an expired tenant', async () => {
  const tenant = { id: 't-expired', slug: 'salon', name: 'Salon', subscription_status: 'trial', trial_ends_at: past };
  const registry = {
    book_appointment: async () => { throw new Error('should not run'); },
    check_availability: async () => { throw new Error('should not run'); },
    list_services: async () => ({ speak: 'services', services: [] })
  };
  const booked = await executeSkill(tenant, null, 'book_appointment', {}, registry);
  assert.equal(booked.blocked, true);
  assert.equal(booked.reason, 'trial_expired');

  const checked = await executeSkill(tenant, null, 'check_availability', {}, registry);
  assert.equal(checked.blocked, true);

  // non-booking skills still run
  const listed = await executeSkill(tenant, null, 'list_services', {}, registry);
  assert.equal(listed.blocked, undefined);
  assert.equal(listed.speak, 'services');
});

test('executeSkill lets an active tenant use booking skills', async () => {
  const tenant = { id: 't-active', slug: 'salon', name: 'Salon', subscription_status: 'active' };
  let ran = false;
  const registry = {
    book_appointment: async () => { ran = true; return { speak: 'booked', booked: true }; }
  };
  const r = await quietAsync(() => executeSkill(tenant, null, 'book_appointment', {}, registry));
  assert.equal(ran, true);
  assert.equal(r.booked, true);
});
