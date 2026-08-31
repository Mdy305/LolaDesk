/**
 * tests/migrate-apply.test.mjs — the automated "apply pending migrations" step.
 *
 * Run:
 *   node tests/migrate-apply.test.mjs
 *   node --test tests/
 *
 * Exercises the REAL applier (api/lib/migrate-all.js) against the in-memory
 * fake Supabase. It proves the fence that keeps the health gate from ever
 * reporting missing tables without a migration behind it:
 *
 *   • an ESTABLISHED db (already has tenants) records the current migration
 *     set as baseline and never re-runs legacy data-bearing migrations;
 *   • migrations added AFTER baseline (the "pending" set) are applied in
 *     filename order and recorded in the ledger;
 *   • a FRESH db (no tenants) applies every migration;
 *   • verifyRequiredTables() fails loudly naming any schema-gate table that
 *     is still missing — the same shape /api/calendar-health reports.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSupabase } from './fake-supabase.js';
import {
  applyPendingMigrations,
  isEstablished,
  isForcedMigration,
  loadMigrations,
  verifyRequiredTables,
} from '../api/lib/migrate-all.js';
import { REQUIRED_TABLES } from '../api/lib/schema-gate.js';

// A stand-in migration set (order matters). Includes the inventory migration
// that adds the three tables the gate depends on.
const MIGRATIONS = [
  { filename: '20260812_calendar_core.sql', sql: '-- bookings', table: 'bookings' },
  { filename: '20260901_inventory_ops.sql', sql: '-- products', table: 'products' },
  { filename: '20260902_future_feature.sql', sql: '-- future', table: 'future_table' },
];

test('schema-gate manifest covers the gate tables it must own', () => {
  for (const t of ['products', 'blocked_slots', 'appointment_notes', 'mfa_registrations']) {
    assert.ok(REQUIRED_TABLES.includes(t), t + ' must be part of the gate');
  }
  assert.equal(REQUIRED_TABLES.length, 26, 'gate tracks exactly 26 required tables');
});

test('isEstablished reflects whether the base tenants table exists', async () => {
  const fake = new FakeSupabase();
  assert.equal(await isEstablished(fake), true, 'auto-created tenants => established');
  fake.failRead('tenants', 'relation "public.tenants" does not exist');
  assert.equal(await isEstablished(fake), false);
});

test('established db records baseline without re-running migrations', async () => {
  const fake = new FakeSupabase();
  const execCalls = [];
  const exec = async ({ filename }) => { execCalls.push(filename); };
  const res = await applyPendingMigrations({
    client: fake, migrations: MIGRATIONS, established: true, exec,
  });
  assert.deepEqual(res.pending, [], 'no migrations pending on a fresh baseline');
  assert.equal(res.ledger.length, MIGRATIONS.length, 'all current migrations recorded as baseline');
  // Only the ledger bootstrap was exec'd — no migration SQL was re-run.
  assert.deepEqual(execCalls, ['__ledger__']);
  const ledger = fake.all('migrations_ledger');
  assert.equal(ledger.length, MIGRATIONS.length);
});

test('migrations added AFTER baseline are applied as pending, in order', async () => {
  const fake = new FakeSupabase();
  fake.seed('migrations_ledger', [
    { filename: '20260812_calendar_core.sql' },
    { filename: '20260901_inventory_ops.sql' },
  ]);
  const execCalls = [];
  const exec = async ({ filename }) => { execCalls.push(filename); };
  const res = await applyPendingMigrations({
    client: fake, migrations: MIGRATIONS, established: true, exec,
  });
  assert.deepEqual(res.pending, ['20260902_future_feature.sql']);
  assert.ok(execCalls.includes('20260902_future_feature.sql'), 'new migration was applied');
  assert.ok(!execCalls.includes('20260812_calendar_core.sql'), 'baseline migrations not re-run');
  const ledger = fake.all('migrations_ledger').map((r) => r.filename);
  assert.ok(ledger.includes('20260902_future_feature.sql'));
});

test('fresh db (no tenants) applies every migration in order', async () => {
  const fake = new FakeSupabase();
  fake.failRead('tenants', 'relation "public.tenants" does not exist');
  const execCalls = [];
  const exec = async ({ filename }) => { execCalls.push(filename); };
  const res = await applyPendingMigrations({ client: fake, migrations: MIGRATIONS, established: false, exec });
  assert.equal(execCalls.length, MIGRATIONS.length + 1, 'ledger bootstrap + each migration');
  assert.equal(execCalls[1], MIGRATIONS[0].filename, 'migrations applied in filename order');
  assert.equal(res.ledger.length, MIGRATIONS.length);
});

test('verifyRequiredTables passes when every gate table exists', async () => {
  const fake = new FakeSupabase();
  // auto-created on from(), so every table reports present unless failRead.
  const gate = await verifyRequiredTables(fake, REQUIRED_TABLES);
  assert.equal(gate.ok, true);
  assert.deepEqual(gate.missing, []);
});

test('verifyRequiredTables fails loudly, naming the missing table', async () => {
  const fake = new FakeSupabase();
  fake.failRead('products', 'relation "public.products" does not exist');
  const gate = await verifyRequiredTables(fake, REQUIRED_TABLES);
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.missing, ['products']);
});

test('isForcedMigration detects the -- force: always header marker', () => {
  assert.equal(isForcedMigration('-- force: always -- idempotent repair\nalter table ...'), true);
  assert.equal(isForcedMigration('-- 20260901_force_tenant_activation_status.sql — repair'), false);
  assert.equal(loadMigrations('migrations').some((m) => m.force), true,
    'the shipped force migration carries the marker (loadMigrations sets force)');
});

test('established-db baseline NEVER swallows a force-marked migration', async () => {
  const fake = new FakeSupabase();
  const execCalls = [];
  const exec = async ({ filename }) => { execCalls.push(filename); };
  const MIGS = [
    { filename: '20260812_calendar_core.sql', sql: '-- legacy 1' },
    { filename: '20260901_inventory_ops.sql', sql: '-- legacy 2' },
    { filename: '20260901_force_tenant_activation_status.sql', sql: '-- force: always\nalter table tenants add column if not exists activation_status text;', force: true },
  ];
  const res = await applyPendingMigrations({ client: fake, migrations: MIGS, established: true, exec });

  // Legacy files are baselined (presumed applied, never re-run)…
  assert.deepEqual(res.baselined, ['20260812_calendar_core.sql', '20260901_inventory_ops.sql']);
  // …but the force-marked repair is NOT baselined and IS applied for real.
  assert.deepEqual(res.pending, ['20260901_force_tenant_activation_status.sql']);
  assert.ok(execCalls.includes('20260901_force_tenant_activation_status.sql'), 'force migration executed');
  assert.ok(!execCalls.includes('20260812_calendar_core.sql'), 'legacy migration not re-run');
  const ledger = fake.all('migrations_ledger');
  assert.ok(ledger.some((r) => r.filename === '20260901_force_tenant_activation_status.sql'), 'force migration recorded');
});

test('force-marked migration runs even when a STALE ledger entry names it (recorded-but-never-run swallow)', async () => {
  // Exact replay of the defect: a past baseline recorded the filename WITHOUT
  // executing it, so the ledger lies about it being applied. The force marker
  // must override the stale entry (the migration is idempotent by contract).
  const fake = new FakeSupabase();
  fake.seed('migrations_ledger', [
    { filename: '20260812_calendar_core.sql' },
    { filename: '20260901_force_tenant_activation_status.sql' }, // swallow entry, never executed
  ]);
  const execCalls = [];
  const exec = async ({ filename }) => { execCalls.push(filename); };
  const MIGS = [
    { filename: '20260812_calendar_core.sql', sql: '-- legacy 1' },
    { filename: '20260901_force_tenant_activation_status.sql', sql: '-- force: always\nalter table tenants add column if not exists activation_status text;', force: true },
    { filename: '20260902_future_feature.sql', sql: '-- future', force: false },
  ];
  const res = await applyPendingMigrations({ client: fake, migrations: MIGS, established: true, exec });
  assert.deepEqual(res.pending, ['20260901_force_tenant_activation_status.sql', '20260902_future_feature.sql'],
    'force file despite stale ledger + genuinely-new file both applied');
  assert.ok(execCalls.includes('20260901_force_tenant_activation_status.sql'), 'stale ledger cannot hide the repair');
  assert.ok(execCalls.includes('20260902_future_feature.sql'), 'absent migration is applied, never baselined');
  assert.ok(!execCalls.includes('20260812_calendar_core.sql'), 'real legacy migration never re-run');
});

test('a failing migration fails loudly (never silently skipped)', async () => {
  const fake = new FakeSupabase();
  const exec = async ({ filename }) => {
    if (filename === '20260901_inventory_ops.sql') throw new Error('column "stock" of relation "products" does not exist');
  };
  await assert.rejects(
    applyPendingMigrations({ client: fake, migrations: MIGRATIONS, established: false, exec }),
    /stock/
  );
});