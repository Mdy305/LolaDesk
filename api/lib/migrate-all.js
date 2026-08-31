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
import { REQUIRED_TABLES, REQUIRED_COLUMNS } from './schema-gate.js';

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

/**
 * A migration can opt out of the legacy established-db baseline: files that
 * carry the header marker `-- force: always` declare themselves IDEMPOTENT
 * repairs that MUST run on every apply. They are never recorded by the
 * baseline, and even a stale ledger entry (e.g. one written by the buggy
 * baseline that recorded migrations WITHOUT executing them) cannot suppress
 * them. Ship a force migration under a NEW filename so a swallowed filename
 * can never hide it again.
 */
export function isForcedMigration(sql) {
  return /--\s*force:\s*always/i.test(sql || '');
}

/** Load migrations as [{ filename, sql, force }] in apply order. */
export function loadMigrations(dir = 'migrations') {
  return migrationFiles(dir).map((filename) => {
    const sql = fs.readFileSync(path.join(dir, filename), 'utf8');
    return { filename, sql, force: isForcedMigration(sql) };
  });
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

  // Baseline: an established DB records the CURRENT NON-FORCED set as applied
  // so legacy data-bearing migrations are never re-run. This is the safety the
  // baseline was designed for — but it MUST NEVER swallow a force-marked
  // migration: those run for real below, and the baseline itself is logged so
  // a presumed-applied migration can never hide silently again (the exact way
  // 20260831_email_verify.sql once vanished and signups 500'd while CI stayed
  // green).
  let baselined = [];
  if (established && done.size === 0) {
    baselined = migrations.filter((m) => !m.force).map((m) => m.filename);
    for (const filename of baselined) {
      const ins = await client.from('migrations_ledger').insert({ filename });
      if (ins?.error) {
        throw new Error('baseline record failed for ' + filename + ': ' + (ins.error?.message || String(ins.error)));
      }
      done.add(filename);
    }
    if (baselined.length || migrations.some((m) => m.force)) {
      console.log(
        '[apply-pending] established DB: baselined ' + baselined.length + ' legacy migration(s) as already-applied (not re-run); ' +
        migrations.filter((m) => m.force).length + ' force-marked migration(s) will be APPLIED.'
      );
    }
  }

  // Determinism rules:
  //   1. Absent from the ledger ⇒ MUST be applied (a baseline can never swallow
  //      a migration that appeared after it — and force files are excluded from
  //      the baseline entirely).
  //   2. Force-marked ⇒ MUST run even if a stale ledger entry already names the
  //      file (idempotent by contract; a recorded-but-never-run swallow must
  //      not be able to hide the repair).
  const pending = migrations.filter((m) => (m.force ? true : !done.has(m.filename)));

  for (const m of pending) {
    // A failure here throws and fails the apply job loudly — never a silent skip.
    await exec({ filename: m.filename, sql: m.sql });
    if (!done.has(m.filename)) {
      const ins = await client.from('migrations_ledger').insert({ filename: m.filename });
      if (ins?.error) {
        throw new Error('applied ' + m.filename + ' but its ledger record failed: ' + (ins.error?.message || String(ins.error)));
      }
      done.add(m.filename);
    }
  }
  return { pending: pending.map((m) => m.filename), ledger: [...done], baselined };
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

/**
 * Probe one critical column with the SAME head-query pattern the table gate
 * uses. Returns { ok, missing, error }:
 *   • missing=true  — PostgREST clearly says the column does not exist
 *                     (400 "column <table>.<col> does not exist", or the
 *                     PGRST204 schema-cache phrasing). The health surface
 *                     reports it exactly like a missing table.
 *   • missing=false — the probe succeeded, or the error is NOT a column miss
 *                     (RLS denial on a policy-gated table, missing table, or
 *                     a transient) — tolerant by design so the gate never
 *                     false-reds an environment it cannot fully see.
 */
export async function probeColumnPresence(client, table, column) {
  let res;
  try {
    res = await client.from(table).select(column, { count: 'exact', head: true });
  } catch (e) {
    res = { error: { message: String(e?.message || e) } };
  }
  if (!res?.error) return { ok: true, missing: false, error: null };
  const msg = String(res.error?.message || res.error || '');
  const missing =
    new RegExp('column[\\s\\S]{0,60}' + column + '[\\s\\S]{0,40}does not exist', 'i').test(msg) ||
    /could not find the ['"][^'"]+['"] column of ['"][^'"]+['"] in the schema cache/i.test(msg);
  return { ok: !missing, missing, error: missing ? msg : null };
}

/**
 * Verify every critical column in the manifest exists. Mirrors
 * verifyRequiredTables: { required, missing, ok }. `missing` entries use the
 * "table.column" form the health endpoints surface as red rows.
 */
export async function verifyRequiredColumns(client, columns = REQUIRED_COLUMNS) {
  const missing = [];
  let required = 0;
  for (const [table, cols] of Object.entries(columns)) {
    for (const column of cols) {
      required += 1;
      const r = await probeColumnPresence(client, table, column);
      if (r.missing) missing.push(table + '.' + column);
    }
  }
  return { required, missing, ok: missing.length === 0 };
}

/** Convenience: apply pending migrations, then verify the health gate. */
export async function migrateAndVerify({ client, migrations, established, ...opts }) {
  const isEst = established ?? (await isEstablished(client));
  const applied = await applyPendingMigrations({ client, migrations, established: isEst, ...opts });
  const gate = await verifyRequiredTables(client, opts.required || REQUIRED_TABLES);
  return { established: isEst, ...applied, gate };
}