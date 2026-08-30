#!/usr/bin/env node
/**
 * scripts/apply-migrations.mjs — apply pending migrations to the deployed
 * Supabase database and verify the health gate stays green.
 * ═══════════════════════════════════════════════════════════════════
 * The automated "apply pending migrations" step each deploy runs: it applies
 * ONLY migrations that are new since this database's baseline (see
 * api/lib/migrate-all.js), then verifies every schema-gate table exists — so
 * /api/calendar-health can never report 'ready' about a missing table.
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
 *   1   a migration failed OR the health gate reports missing tables
 * Never logs, echoes, or commits the key.
 */
import { createClient } from '@supabase/supabase-js';
import { loadMigrations, applyPendingMigrations, verifyRequiredTables, isEstablished } from '../api/lib/migrate-all.js';
import { REQUIRED_TABLES } from '../api/lib/schema-gate.js';

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

let exitCode = 0;
try {
  const migrations = loadMigrations();
  const established = await isEstablished(client);
  if (!established) console.log(`[apply-migrations] fresh database detected — applying full baseline (${migrations.length})`);

  let pending = [];
  if (verifyOnly) {
    console.log(`[apply-migrations] verify-only: ${established ? 'established' : 'fresh'} DB, checking ${REQUIRED_TABLES.length} required tables`);
  } else {
    const applied = await applyPendingMigrations({ client, migrations, established, exec });
    pending = applied.pending;
    console.log(
      pending.length
        ? `[apply-migrations] applied ${pending.length} pending migration(s): ${pending.join(', ')}`
        : '[apply-migrations] no pending migrations to apply'
    );
  }

  const gate = await verifyRequiredTables(client, REQUIRED_TABLES);
  console.log(`[apply-migrations] health gate: ${gate.ok ? 'READY' : 'MISSING'} (${gate.required - gate.missing.length}/${gate.required})`);
  if (gate.missing.length) {
    console.log(`[apply-migrations] MISSING required tables: ${gate.missing.join(', ')}`);
    exitCode = 1;
  }
} catch (e) {
  console.error('[apply-migrations] FAILED:', String(e?.message || e).slice(0, 500));
  exitCode = 1;
}
process.exit(exitCode);