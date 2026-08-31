/**
 * tests/email-verify-gate.test.mjs — email confirmation gates tenant activation.
 * Covers the two pure pieces of the flow:
 *   • isEmailConfirmed — only a Supabase-confirmed address counts.
 *   • activateTenant — a `pending_email` tenant flips to `active` on first
 *     confirmed login; an already-active tenant (existing salons, Google/SSO)
 *     passes through untouched (idempotent, nothing clobbered).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSupabase } from './fake-supabase.js';
import { isEmailConfirmed } from '../api/lib/auth.js';
import { activateTenant } from '../api/lib/db.js';

test('isEmailConfirmed is true only for a Supabase-confirmed address', () => {
  assert.equal(isEmailConfirmed({ email_confirmed_at: '2026-01-01T00:00:00Z' }), true);
  assert.equal(isEmailConfirmed({ emailConfirmedAt: '2026-01-01T00:00:00Z' }), true);
  assert.equal(isEmailConfirmed({}), false, 'unconfirmed user is not confirmed');
  assert.equal(isEmailConfirmed(null), false);
});

test('activateTenant flips a pending_email tenant to active', async () => {
  const fake = new FakeSupabase();
  fake.seed('tenants', [{ id: 't-pending', activation_status: 'pending_email', phone_number: null }]);
  const r = await activateTenant(fake, { id: 't-pending', activation_status: 'pending_email' });
  assert.deepEqual({ ok: r.ok, activated: r.activated }, { ok: true, activated: true });
  const saved = fake.all('tenants').find(t => t.id === 't-pending');
  assert.equal(saved.activation_status, 'active');
});

test('activateTenant is idempotent for an already-active tenant (existing salons / SSO)', async () => {
  const fake = new FakeSupabase();
  fake.seed('tenants', [{ id: 't-live', activation_status: 'active', phone_number: '+15550000001' }]);
  const r = await activateTenant(fake, { id: 't-live', activation_status: 'active' });
  assert.equal(r.ok, true);
  assert.equal(r.already_active, true);
  assert.equal(r.activated, undefined, 'no write for an active tenant');
  const saved = fake.all('tenants').find(t => t.id === 't-live');
  assert.equal(saved.activation_status, 'active');
  assert.equal(saved.phone_number, '+15550000001'); // untouched
});

test('activateTenant is a no-op without a valid tenancy', async () => {
  const fake = new FakeSupabase();
  assert.equal((await activateTenant(fake, null)).ok, false);
  assert.equal((await activateTenant(null, { id: 'x' })).ok, false);
});