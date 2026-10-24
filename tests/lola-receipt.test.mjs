/**
 * tests/lola-receipt.test.mjs — Lola's receipt, the Monday text, and the
 * Starter → Pro stylist gate.
 *
 * Run:
 *   node --test tests/lola-receipt.test.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSupabase } from './fake-supabase.js';

// ── @supabase/supabase-js test double (same as the other suites) ──
const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STUB_DIR = join(API_ROOT, 'node_modules', '@supabase', 'supabase-js');
mkdirSync(STUB_DIR, { recursive: true });
writeFileSync(join(STUB_DIR, 'package.json'), JSON.stringify({ name: '@supabase/supabase-js', version: '0.0.0-test', type: 'module', main: 'index.js', exports: { '.': './index.js' } }, null, 2));
writeFileSync(join(STUB_DIR, 'index.js'), "export function createClient(){const f=globalThis.__LOLA_FAKE_SUPABASE__;if(!f)throw new Error('No fake Supabase registered');return f;}\n");

const fake = new FakeSupabase();
globalThis.__LOLA_FAKE_SUPABASE__ = fake;
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'fake-service-key';
const sent = [];
globalThis.fetch = async (url, init = {}) => {
  try { const b = JSON.parse(init.body || '{}'); if (b && (b.text || b.body)) sent.push(b); } catch {}
  return { ok: true, status: 200, json: async () => ({ data: { id: 'msg_1' } }), text: async () => '{}' };
};

const { summarizeReceipt, lolaReceipt, receiptText } = await import('../api/lib/lola-receipt.js');
const { onPaidPlan, stylistLimit, canAddStylist, isPlaceholderStaff } = await import('../api/lib/plan-gate.js');
const { runLolaReceipts } = await import('../api/cron/lola-receipt.js');

// ── receipt math ──────────────────────────────────────────────────
test('counts only calls Lola actually held', () => {
  const r = summarizeReceipt({ calls: [
    { id: 1, direction: 'inbound', status: 'completed' },
    { id: 2, direction: 'inbound', status: 'missed' },
    { id: 3, direction: 'outbound', status: 'completed' },
    { id: 4, direction: 'inbound', status: 'voicemail' },
    { id: 5, status: 'answered' },
  ] });
  assert.equal(r.answered, 2);
});

test('booked by Lola = her own bookings, not cancelled, not synced, not typed in by the owner', () => {
  const r = summarizeReceipt({ bookings: [
    { id: 'a', source: 'lola', status: 'confirmed', total_amount: 180 },
    { id: 'b', source: 'voice', status: 'completed', total_amount: 220 },
    { id: 'c', source: 'public_widget', status: 'confirmed', total_amount: 100 },
    { id: 'd', source: 'lola', status: 'cancelled', total_amount: 500 },
    { id: 'e', source: 'lola', status: 'no-show', total_amount: 500 },
    { id: 'f', source: 'dashboard', status: 'confirmed', total_amount: 900 },
    { id: 'g', source: 'lola', status: 'confirmed', total_amount: 300, external_id: 'sq_1' },
  ] });
  assert.equal(r.booked, 3);
  assert.equal(r.value, 500);
  assert.equal(r.valueMoney, '$500');
});

test('the Monday text says it in one sentence, and stays silent on an empty week', () => {
  assert.equal(receiptText({ answered: 0, booked: 0, value: 0 }), '');
  assert.equal(
    receiptText({ answered: 41, booked: 12, value: 2340 }, { salon: 'MMA Salon', link: 'https://www.loladesk.com/dashboard' }),
    "Lola's week at MMA Salon: I answered 41 calls and booked 12 appointments worth $2,340. https://www.loladesk.com/dashboard"
  );
  assert.equal(receiptText({ answered: 1, booked: 0, value: 0 }), "Lola's week: I answered 1 call.");
});

test('lolaReceipt reads one salon only, inside the window', async () => {
  fake.reset();
  const inside = new Date(Date.now() - 2 * 864e5).toISOString();
  const outside = new Date(Date.now() - 40 * 864e5).toISOString();
  fake.seed('calls', [
    { id: 'c1', tenant_id: 't1', direction: 'inbound', status: 'completed', created_at: inside },
    { id: 'c2', tenant_id: 't1', direction: 'inbound', status: 'completed', created_at: outside },
    { id: 'c3', tenant_id: 't2', direction: 'inbound', status: 'completed', created_at: inside },
  ]);
  fake.seed('bookings', [
    { id: 'b1', tenant_id: 't1', source: 'lola', status: 'confirmed', total_amount: 150, created_at: inside },
    { id: 'b2', tenant_id: 't2', source: 'lola', status: 'confirmed', total_amount: 999, created_at: inside },
  ]);
  const r = await lolaReceipt(fake, 't1', { since: new Date(Date.now() - 30 * 864e5).toISOString() });
  assert.deepEqual([r.answered, r.booked, r.value], [1, 1, 150]);
});

// ── Monday text ───────────────────────────────────────────────────
test('sends once, Monday 9am salon time, only to salons with an owner mobile', async () => {
  fake.reset(); sent.length = 0;
  const mon9 = new Date('2026-10-26T13:05:00Z'); // Monday 9:05am New York
  const recent = new Date(mon9 - 864e5).toISOString();
  fake.seed('tenants', [
    { id: 't1', name: 'MMA Salon', phone_number: '+17865550100', owner_phone: '+13055550111' },
    { id: 't2', name: 'No Owner Phone', phone_number: '+17865550200' },
  ]);
  fake.seed('calls', [{ id: 'c1', tenant_id: 't1', direction: 'inbound', status: 'completed', created_at: recent }]);
  fake.seed('bookings', [{ id: 'b1', tenant_id: 't1', source: 'lola', status: 'confirmed', total_amount: 180, created_at: recent }]);

  const first = await runLolaReceipts(fake, { now: mon9 });
  const t1 = first.find((r) => r.tenant === 't1');
  assert.equal(t1.sent, true, JSON.stringify(t1));
  assert.equal(first.find((r) => r.tenant === 't2').skipped, 'no_owner_phone');

  const again = await runLolaReceipts(fake, { now: new Date(mon9.getTime() + 60e3) });
  assert.equal(again.find((r) => r.tenant === 't1').skipped, 'sent');

  const tuesday = await runLolaReceipts(fake, { now: new Date('2026-10-27T13:05:00Z') });
  assert.equal(tuesday.find((r) => r.tenant === 't1').skipped, 'not_monday_9am');
});

test('respects "Lola, stop alerts"', async () => {
  fake.reset();
  const mon9 = new Date('2026-10-26T13:05:00Z');
  fake.seed('tenants', [{ id: 't1', name: 'S', phone_number: '+17865550100', owner_phone: '+13055550111' }]);
  fake.seed('client_memories', [{ tenant_id: 't1', client_phone: 'owner_alerts', key: 'enabled', value: { on: false } }]);
  const r = await runLolaReceipts(fake, { now: mon9 });
  assert.equal(r[0].skipped, 'off');
});

// ── Starter → Pro ─────────────────────────────────────────────────
test('free trial has no stylist limit; paid Starter is two; Pro has none', () => {
  assert.equal(stylistLimit({ plan: 'starter', subscription_status: 'trial' }), null);
  assert.equal(stylistLimit({ plan: 'starter' }), null);
  assert.equal(stylistLimit({ plan: 'starter', subscription_status: 'trialing' }), null);
  assert.equal(stylistLimit({ plan: 'starter', subscription_status: 'trialing', stripe_subscription_id: 'sub_1' }), 2);
  assert.equal(stylistLimit({ plan: 'starter', subscription_status: 'active' }), 2);
  assert.equal(stylistLimit({ plan: 'pro', subscription_status: 'active' }), null);
  assert.equal(stylistLimit({ plan: 'scale', subscription_status: 'active' }), null);
  assert.equal(onPaidPlan({ subscription_status: 'canceled' }), false);
});

test('the seeded "Any available team member" is not a person', () => {
  assert.equal(isPlaceholderStaff({ name: 'Any available team member' }), true);
  assert.equal(isPlaceholderStaff({ name: 'Ana' }), false);
});

test('a third stylist on paid Starter asks for Pro; trial and Pro go straight through', async () => {
  fake.reset();
  fake.seed('staff', [
    { id: 's0', tenant_id: 't1', name: 'Any available team member', is_active: true },
    { id: 's1', tenant_id: 't1', name: 'Ana', is_active: true },
    { id: 's2', tenant_id: 't1', name: 'Bo', is_active: true },
    { id: 's3', tenant_id: 't1', name: 'Cy', is_active: false },
  ]);
  const starter = await canAddStylist(fake, { id: 't1', plan: 'starter', subscription_status: 'active' });
  assert.equal(starter.ok, false);
  assert.equal(starter.error, 'upgrade_required');
  assert.match(starter.upgrade_url, /subscription\?upgrade=pro/);
  assert.equal((await canAddStylist(fake, { id: 't1', plan: 'starter', subscription_status: 'trial' })).ok, true);
  assert.equal((await canAddStylist(fake, { id: 't1', plan: 'pro', subscription_status: 'active' })).ok, true);

  fake.seed('staff', [{ id: 's1', tenant_id: 't1', name: 'Ana', is_active: true }]);
  assert.equal((await canAddStylist(fake, { id: 't1', plan: 'starter', subscription_status: 'active' })).ok, true);
});
