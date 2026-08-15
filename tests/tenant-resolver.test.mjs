/**
 * tests/tenant-resolver.test.mjs — inbound routing round-trip tests.
 *
 * Exercises the REAL lib/tenant-resolver.js (resolveInboundTenant +
 * verifyTenantRouting) against an in-memory Supabase stand-in seeded with the
 * exact shape of migrations/20260815_tenant_number_routing.sql. This is the
 * "does the dialed number round-trip back to the right tenant?" gate — run it
 * before/after applying the migration to production.
 *
 * Run:
 *   node tests/tenant-resolver.test.mjs
 *   node --test tests/
 *
 * No network, no real DB. Same test-double injection as booking-brain.test.mjs.
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
  '// Generated test double — see tests/tenant-resolver.test.mjs',
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

const resolver = await import('../api/lib/tenant-resolver.js');
const { invalidateRouting } = resolver;

const A = { id: 'tenant-a', slug: 'salon-a', name: 'Salon A', phone_number: '+13055550100' };
const B = { id: 'tenant-b', slug: 'salon-b', name: 'Salon B', phone_number: '+13055550200' };
const DISABLED_NUM = '+13055550300';
const LEGACY_ONLY = { id: 'tenant-c', slug: 'salon-c', name: 'Salon C', phone_number: '+13055550400' };

function seedRouting() {
  fake.reset();
  invalidateRouting(); // clear resolver cache between tests
  fake.seed('tenants', [A, B, LEGACY_ONLY]);
  fake.seed('tenant_numbers', [
    { tenant_id: A.id, phone_number: A.phone_number, kind: 'primary', status: 'active' },
    { tenant_id: B.id, phone_number: B.phone_number, kind: 'primary', status: 'active' },
    { tenant_id: A.id, phone_number: DISABLED_NUM, kind: 'forwarded', status: 'disabled' }
  ]);
}

test('number in tenant_numbers resolves to the owning tenant', async () => {
  seedRouting();
  const r = await resolver.resolveInboundTenant({ to: A.phone_number });
  assert.equal(r.status, 'resolved');
  assert.equal(r.tenant.id, A.id);
  assert.equal(r.source, 'tenant_numbers');
  assert.equal(r.number, A.phone_number);
});

test('dialed-number round-trip: verifyTenantRouting is ready for the owner', async () => {
  seedRouting();
  const gate = await resolver.verifyTenantRouting(A);
  assert.equal(gate.ready, true);
  assert.equal(gate.status, 'resolved');
  assert.equal(gate.source, 'tenant_numbers');
  assert.equal(gate.reason, null);
});

test('number routed to another tenant fails the round-trip gate', async () => {
  seedRouting();
  // B's canonical number actually belongs to B; ask the gate for A against B's number.
  const gate = await resolver.verifyTenantRouting({ ...A, phone_number: B.phone_number });
  assert.equal(gate.ready, false);
  assert.equal(gate.status, 'resolved');       // it resolves…
  assert.equal(gate.reason, 'number-resolves-elsewhere'); // …to someone else
});

test('disabled routing row makes the number inert', async () => {
  seedRouting();
  const r = await resolver.resolveInboundTenant({ to: DISABLED_NUM });
  assert.equal(r.status, 'disabled');
  assert.equal(r.tenant, null);
});

test('unknown number is a hard refuse, never another tenant', async () => {
  seedRouting();
  const r = await resolver.resolveInboundTenant({ to: '+13055559999' });
  assert.equal(r.status, 'not_found');
  assert.equal(r.tenant, null);
  assert.equal(r.reason, 'no-tenant-for-number');
});

test('pre-migration fallback: tenants.phone_number still resolves', async () => {
  // Only the legacy column is populated — no tenant_numbers row for C.
  fake.reset();
  invalidateRouting();
  fake.seed('tenants', [LEGACY_ONLY]);
  fake.seed('tenant_numbers', []);
  const r = await resolver.resolveInboundTenant({ to: LEGACY_ONLY.phone_number });
  assert.equal(r.status, 'resolved');
  assert.equal(r.tenant.id, LEGACY_ONLY.id);
  assert.equal(r.source, 'tenants.phone_number');
});

test('two rows sharing one number is ambiguous, never a guess', async () => {
  fake.reset();
  invalidateRouting();
  fake.seed('tenants', [A, B]);
  fake.seed('tenant_numbers', [
    { tenant_id: A.id, phone_number: A.phone_number, kind: 'primary', status: 'active' },
    { tenant_id: B.id, phone_number: A.phone_number, kind: 'forwarded', status: 'active' }
  ]);
  const r = await resolver.resolveInboundTenant({ to: A.phone_number });
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.tenant, null);
});

test('tenant with no number fails the round-trip gate cleanly', async () => {
  seedRouting();
  const gate = await resolver.verifyTenantRouting({ id: 'tenant-x', name: 'No Number' });
  assert.equal(gate.ready, false);
  assert.equal(gate.reason, 'no-number-assigned');
});
