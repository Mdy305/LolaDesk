/**
 * api/lib/migrate.js — startup migration runner (self-healing schema)
 * ════════════════════════════════════════════════════════════════════
 * Vercel functions are serverless: there is no persistent process and no
 * single "boot". So migrations run lazily, on cold start, at the exact moment
 * the code first needs the schema to exist — which for the inbound resolver is
 * the first call/text that hits lookupByNumber().
 *
 * Why an exec_sql RPC instead of raw SQL?
 *   @supabase/supabase-js speaks PostgREST, and PostgREST cannot run DDL
 *   (no CREATE TABLE). The one-time bootstrap is a tiny security-definer
 *   function `public.exec_sql(text)` — shipped in schema.sql (fresh DBs) and
 *   at the top of migrations/20260815_tenant_number_routing.sql (existing
 *   DBs). Once it exists, THIS module self-applies any pending migration on
 *   boot, so a fresh deployment can never silently skip the tenant_numbers
 *   table.
 *
 * Design constraints:
 *   • Idempotent — every embedded migration uses IF NOT EXISTS / ON CONFLICT,
 *     so re-running (or two cold starts racing) is harmless.
 *   • Non-fatal — if exec_sql is missing, this logs ONE clear warning and
 *     returns 'unavailable'; the resolver already degrades to the legacy
 *     tenants.phone_number column instead of dropping calls.
 *   • Bundled — the DDL lives as an inline string, not a file on disk, because
 *     Vercel only bundles api/** files a function imports; migrations/*.sql at
 *     the repo root is NOT guaranteed to exist inside a function's bundle.
 */

import { db } from './db.js';

// Keep in sync with migrations/20260815_tenant_number_routing.sql. Idempotent
// by construction so the boot path and the manual SQL-editor path agree.
const TENANT_NUMBERS_DDL = `create table if not exists tenant_numbers (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  phone_number  text not null,
  kind          text not null default 'primary',
  connection_id text,
  status        text not null default 'active',
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (phone_number)
);

create index if not exists idx_tenant_numbers_tenant on tenant_numbers (tenant_id);
create index if not exists idx_tenant_numbers_phone  on tenant_numbers (phone_number);

insert into tenant_numbers (tenant_id, phone_number, kind, status)
select t.id, t.phone_number, 'primary', 'active'
from tenants t
where t.phone_number is not null and t.phone_number <> ''
on conflict (phone_number) do nothing;

alter table tenant_numbers enable row level security;`;

// Memoized per cold start: run the probe (and any DDL) at most once per
// function instance, then every later call is a no-op promise resolution.
let _ensured = null;

/** Forget the memoized result (tests, or after a manual re-migration). */
export function resetMigrations() {
  _ensured = null;
}

/**
 * Ensure required schema exists. Returns a string status:
 *   'no-db'       — Supabase env vars not configured (db() is null)
 *   'up-to-date'  — tenant_numbers already exists, nothing to do
 *   'applied'     — the table was missing and was just created
 *   'unavailable' — table missing but exec_sql isn't there to fix it
 *   'error'       — unexpected failure (logged; degrades gracefully)
 */
export function ensureMigrations() {
  if (_ensured) return _ensured;
  _ensured = runMigrations().catch((err) => {
    console.warn('[migrate] unexpected migration error:', String(err?.message || err).slice(0, 200));
    _ensured = null; // allow a retry on the next call / cold start
    return 'error';
  });
  return _ensured;
}

async function runMigrations() {
  const c = db();
  if (!c) return 'no-db';

  // Cheap probe: if the table exists this returns rows (or an empty array)
  // with error:null. If it's missing, PostgREST returns a non-null error.
  const probe = await c.from('tenant_numbers').select('id').limit(1);
  if (!probe.error) return 'up-to-date';

  try {
    const res = await c.rpc('exec_sql', { p_sql: TENANT_NUMBERS_DDL });
    if (res?.error) throw new Error(res.error?.message || 'exec_sql returned an error');
    console.log('[migrate] applied tenant_numbers (routing table was missing)');
    return 'applied';
  } catch (e) {
    const msg = String(e?.message || e);
    const missingFn = /could not find the function|function .*exec_sql.* does not exist|PGRST202/i.test(msg);
    console.warn(
      '[migrate] tenant_numbers missing; auto-apply unavailable' +
        (missingFn ? ' — run migrations/20260815_tenant_number_routing.sql once to bootstrap exec_sql' : '') +
        ': ' + msg.slice(0, 160)
    );
    return 'unavailable';
  }
}
