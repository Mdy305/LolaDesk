#!/usr/bin/env node
/**
 * scripts/apply-migrations.mjs — apply pending migrations to the deployed
 * Supabase database and verify the health gate stays green.
 * ═══════════════════════════════════════════════════════════════════
 * The automated "apply pending migrations" step each deploy runs: it applies
 * ONLY migrations that are new since this database's baseline (see
 * api/lib/migrate-all.js), then verifies every schema-gate table AND the
 * critical columns the product WRITES exist — so /api/calendar-health can
 * never report 'ready' about a missing table or a swallowed migration that
 * left a column absent (the tenants.activation_status incident of 20260901).
 *
 * Env vars:  SUPABASE_URL, SUPABASE_SERVICE_KEY (service key so exec_sql is
 * callable — the same path api/lib/migrate.js already uses in production).
 *            (SUPABASE_SERVICE_ROLE_KEY accepted as an alias.)
 *
 * Usage:
 *   node scripts/apply-migrations.mjs            # apply pending + verify gate
 *   node scripts/apply-migrations.mjs --verify   # verify only, never apply
 *
 * Exit codes:
 *   0   applied/clean, or credentials absent (SKIP — safe no-op for CI)
 *   1   a migration failed OR the health gate reports missing tables/columns
 * Never logs, echoes, or commits the key.
 */
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadMigrations, applyPendingMigrations, verifyRequiredTables, verifyRequiredColumns, isEstablished } from '../api/lib/migrate-all.js';
import { REQUIRED_TABLES } from '../api/lib/schema-gate.js';

/**
 * Apply pending migrations (unless verifyOnly) and verify the full health
 * gate — required tables AND required columns. Exported so tests can drive
 * it with a fake client; returns { established, pending, ready, missing,
 * exitCode, tables, columns } instead of calling process.exit itself.
 *
 * `columns` follows the tolerant classification shipped in
 * migrate-all.js: only a genuine "column … does not exist" miss counts —
 * RLS denial on a policy-gated table, a missing table, or a transient read
 * problem is treated as present and can never false-red the gate.
 */
export async function runApplyMigrations({ client, exec, verifyOnly = false, established: establishedArg, migrations = loadMigrations() } = {}) {
  const established = establishedArg ?? (await isEstablished(client));
  if (!established) console.log(`[apply-migrations] fresh database detected — applying full baseline (${migrations.length})`);

  let pending = [];
  if (verifyOnly) {
    console.log(`[apply-migrations] verify-only: ${established ? 'established' : 'fresh'} DB, checking ${REQUIRED_TABLES.length} required tables + critical columns`);
  } else {
    const applied = await applyPendingMigrations({ client, migrations, established, exec });
    pending = applied.pending;
    console.log(
      pending.length
        ? `[apply-migrations] applied ${pending.length} pending migration(s): ${pending.join(', ')}`
        : '[apply-migrations] no pending migrations to apply'
    );
  }

  const tables = await verifyRequiredTables(client, REQUIRED_TABLES);
  const columns = await verifyRequiredColumns(client);
  const missing = [...tables.missing, ...columns.missing];
  const ready = tables.ok && columns.ok;
  console.log(`[apply-migrations] health gate: ${ready ? 'READY' : 'MISSING'} — tables ${tables.required - tables.missing.length}/${tables.required}, columns ${columns.required - columns.missing.length}/${columns.required}`);
  if (tables.missing.length) {
    console.log(`[apply-migrations] MISSING required tables: ${tables.missing.join(', ')}`);
  }
  if (columns.missing.length) {
    console.log(`[apply-migrations] MISSING required columns: ${columns.missing.join(', ')}`);
  }
  return { established, pending, ready, missing, exitCode: missing.length ? 1 : 0, tables, columns };
}

// ── CLI entry (only when run directly, so tests can import runApplyMigrations) ──
const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes('--verify') || args.includes('--verify-only');

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log('[apply-migrations] SKIP: SUPABASE_URL/SUPABASE_SERVICE_KEY not set — nothing applied.');
    process.exit(0);
  }

  const client = createClient(url, key, { auth: { persistSession: false } });
  const exec = async ({ filename, sql }) => {
    const r = await client.rpc('exec_sql', { p_sql: sql });
    if (r?.error) throw new Error(`exec_sql failed for ${filename}: ${r.error.message || String(r.error)}`);
  };

  let result;
  try {
    result = await runApplyMigrations({ client, exec, verifyOnly });
  } catch (e) {
    console.error('[apply-migrations] FAILED:', String(e?.message || e).slice(0, 500));
    result = { exitCode: 1 };
  }
  process.exit(result.exitCode);
}