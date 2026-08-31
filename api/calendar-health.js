import { db } from './lib/db.js';
import { REQUIRED_TABLES, REQUIRED_COLUMNS } from './lib/schema-gate.js';
import { probeColumnPresence } from './lib/migrate-all.js';

export default async function handler(req, res) {
  const c = db();
  if (!c) return res.status(503).json({ ok: false, error: 'database_not_configured' });
  const checks = [];
  for (const table of REQUIRED_TABLES) {
    try {
      const { error } = await c.from(table).select('*', { count: 'exact', head: true });
      checks.push({ table, ok: !error, error: error?.message || null });
    } catch (e) {
      checks.push({ table, ok: false, error: String(e?.message || e) });
    }
  }
  const missing = checks.filter((x) => !x.ok);

  // Column gate: a table can exist while the columns the product WRITES are
  // missing (the tenants.activation_status incident of 20260901 — swallowed
  // migration, green table gate, signups 500ing). Same head-query pattern,
  // same "missing list" treatment: a missing column turns this endpoint red.
  const columnChecks = [];
  for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
    for (const column of cols) {
      const r = await probeColumnPresence(c, table, column);
      columnChecks.push({ table, column, ok: r.ok, missing: r.missing, error: r.error });
    }
  }
  const missingColumns = columnChecks.filter((x) => x.missing);
  const columnRequired = Object.values(REQUIRED_COLUMNS).reduce((n, cols) => n + cols.length, 0);

  const unhealthy = missing.length > 0 || missingColumns.length > 0;
  return res.status(unhealthy ? 503 : 200).json({
    ok: !unhealthy,
    ready: !unhealthy,
    required: REQUIRED_TABLES.length,
    passed: checks.length - missing.length,
    missing: missing.map((x) => x.table),
    checks,
    required_columns: columnRequired,
    passed_columns: columnRequired - missingColumns.length,
    missing_columns: missingColumns.map((x) => x.table + '.' + x.column),
    column_checks: columnChecks,
  });
}