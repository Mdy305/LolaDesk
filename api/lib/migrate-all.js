/**
 * api/lib/migrate-all.js — apply PENDING migrations to a Supabase database
 * and verify the health gate.
 * ═══════════════════════════════════════════════════════════════════
 * The migrations under migrations/ are Supabase-flavored SQL (auth/storage/
 * roles/RLS helpers) — they cannot run on a bare Postgres container. Instead
 * this applies each file through the SAME security-definer `exec_sql` RPC
 * that the app's own self-healer (api/lib/migrate.js) already uses in
 * production, tracked by a `migrations_ledger` table so only NEW files run.
 *
 *   • established DB (already has `tenants`) — the CURRENT migration set is
 *     recorded as the baseline (they were applied over time by hand / prior
 *     deploys), so a legacy data-bearing migration is never re-run. Only
 *     files added AFTER baseline are applied.
 *   • fresh DB — every migration is applied in filename order.
 *
 * After applying, verifyRequiredTables() checks the schema-gate manifest so
 * CI fails loudly if the schema ever drifts from what the product needs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REQUIRED_TABLES } from './schema-gate.js';

const LEDGER_DDL = `create table if not exists migrations_ledger (
  filename   text primary key,
  applied_at timestamptz not null default now()
);`;

/** Migration filenames in apply order (migrations/*.sql, sorted). */
export function migrationFiles(dir = 'migrations') {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/** Load migrations as [{ filename, sql }] in apply order. */
export function loadMigrations(dir = 'migrations') {
  return migrationFiles(dir).map((filename) => ({
    filename,
    sql: fs.readFileSync(path.join(dir, filename), 'utf8'),
  }));
}

/** True when the base `tenants` table exists → the DB is already established. */
export async function isEstablished(client) {
  const { error } = await client.from('tenants').select('id', { head: true, count: 'exact' });
  return !error;
}

/**
 * Apply pending migrations idempotently.
 * @param {object} opts
 * @param {object} opts.client supabase-js-like client (service key).
 * @param {Array<{filename:string,sql:string}>} opts.migrations
 * @param {boolean} opts.established skip baseline re-run for established DBs.
 * @param {Function} opts.exec injectable `async ({filename, sql}) => void`;
 *   defaults to the `exec_sql` RPC. Throws on failure (fail loud).
 * @returns {Promise<{pending:string[],ledger:string[]}>}
 */
export async function applyPendingMigrations({
  client,
  migrations,
  established = false,
  exec = async ({ filename, sql }) => {
    const r = await client.rpc('exec_sql', { p_sql: sql });
    if (r?.error) throw new Error(`exec_sql failed for ${filename}: ${r.error.message || String(r.error)}`);
  },
}) {
  // Ensure the ledger table exists (idempotent).
  await exec({ filename: '__ledger__', sql: LEDGER_DDL });

  const { data: rows, error: readErr } = await client.from('migrations_ledger').select('filename');
  if (readErr) throw new Error('migrations_ledger unreadable: ' + (readErr.message || String(readErr)));
  const done = new Set((rows || []).map((r) => r.filename));

  // Baseline: an established DB records the CURRENT set as applied so legacy
  // data-bearing migrations are never re-run.
  if (established && done.size === 0) {
    for (const m of migrations) done.add(m.filename);
    for (const filename of done) {
      await client.from('migrations_ledger').insert({ filename });
    }
  }

  const pending = migrations.filter((m) => !done.has(m.filename));
  for (const m of pending) {
    await exec({ filename: m.filename, sql: m.sql });
    await client.from('migrations_ledger').insert({ filename: m.filename });
    done.add(m.filename);
  }
  return { pending: pending.map((m) => m.filename), ledger: [...done] };
}

/**
 * Verify every schema-gate table exists. Returns { required, missing, ok }.
 * A `select` that errors ⇒ the table is missing (or the DB is down) ⇒ present
 * in `missing`, exactly how /api/calendar-health reports it.
 */
export async function verifyRequiredTables(client, required = REQUIRED_TABLES) {
  const missing = [];
  for (const table of required) {
    let error = null;
    try {
      const r = await client.from(table).select('id', { head: true, count: 'exact' });
      error = r?.error || null;
    } catch (e) {
      error = String(e?.message || e);
    }
    if (error) missing.push(table);
  }
  return { required: required.length, missing, ok: missing.length === 0 };
}

/** Convenience: apply pending migrations, then verify the health gate. */
export async function migrateAndVerify({ client, migrations, established, ...opts }) {
  const isEst = established ?? (await isEstablished(client));
  const applied = await applyPendingMigrations({ client, migrations, established: isEst, ...opts });
  const gate = await verifyRequiredTables(client, opts.required || REQUIRED_TABLES);
  return { established: isEst, ...applied, gate };
}