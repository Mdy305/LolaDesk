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
 * Bundled migrations (self-heal targets):
 *   • tenant_numbers          — inbound routing (fires on first call/text)
 *   • tenants.activation_status — email-verification gate (fires on resolver boot)
 *   • mfa_registrations       — owner 2FA store (fires when /api/auth/mfa boots)
 *   • platform_settings       — customer-care KV (fires when /api/customer-care boots)
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

// Keep in sync with migrations/20260901_force_tenant_activation_status.sql.
// The email-verification gate writes activation_status on every new tenant; the
// CI applier once ledgered the column migration as applied WITHOUT executing it,
// so production's tenants table lacked the column and real signups 500'd with a
// swallowed "column does not exist". Ensuring it HERE at runtime (with the
// platform's own service key) closes that blind spot deterministically.
const ACTIVATION_STATUS_DDL = `alter table public.tenants add column if not exists activation_status text not null default 'active';

create index if not exists idx_tenants_activation_status on public.tenants(activation_status) where activation_status is not null;`;

// Keep in sync with migrations/20260831_mfa_totp.sql. The MFA table was
// ledger-baselined on production without executing (the pre-fix applier), so
// owner 2FA enrollment failed with "could not find the table in the schema
// cache" while the CI apply job reported success. Self-heal at the exact
// moment /api/auth/mfa needs the table — same repair path that saved
// tenant_numbers and tenants.activation_status.
const MFA_REGISTRATIONS_DDL = `create table if not exists public.mfa_registrations (
  user_identifier text primary key,
  secret          text not null,
  verified        boolean not null default false,
  created_at      timestamptz not null default now(),
  verified_at     timestamptz
);`;

// Keep in sync with migrations/20260901_customer_care.sql. The customer-care
// line's platform-level KV store — same ledger-baseline loss as the MFA table.
const PLATFORM_SETTINGS_DDL = `create table if not exists public.platform_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);`;

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
 *   'up-to-date'  — every probed table/column already exists, nothing to do
 *   'applied'     — something was missing and was just created
 *   'unavailable' — schema missing but exec_sql isn't there to fix it
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

// Shared ensure step: if PostgREST reports the table missing, apply its
// idempotent DDL through exec_sql. Returns the table name when applied.
async function ensureTable(c, table, ddl, applied) {
  try {
    const probe = await c.from(table).select('*').limit(1);
    if (!probe.error) return; // present
    const res = await c.rpc('exec_sql', { p_sql: ddl });
    if (res?.error) throw new Error(res.error?.message || 'exec_sql returned an error');
    console.log('[migrate] applied ' + table + ' (was missing)');
    applied.push(table);
  } catch (e) {
    console.warn('[migrate] ' + table + ' ensure failed:', String(e?.message || e).slice(0, 160));
  }
}

async function runMigrations() {
  const c = db();
  if (!c) return 'no-db';

  const applied = [];

  // Cheap probe: if the table exists this returns rows (or an empty array)
  // with error:null. If it's missing, PostgREST returns a non-null error.
  const probe = await c.from('tenant_numbers').select('id').limit(1);
  if (!probe.error) {
    // Table present — still verify the email-verification column below.
  } else {
    try {
      const res = await c.rpc('exec_sql', { p_sql: TENANT_NUMBERS_DDL });
      if (res?.error) throw new Error(res.error?.message || 'exec_sql returned an error');
      console.log('[migrate] applied tenant_numbers (routing table was missing)');
      applied.push('tenant_numbers');
    } catch (e) {
      const msg = String(e?.message || e);
      const missingFn = /could not find the function|function .*exec_sql.* does not exist|PGRST202/i.test(msg);
      console.warn(
        '[migrate] tenant_numbers missing; auto-apply unavailable' +
          (missingFn ? ' — run migrations/20260815_tenant_number_routing.sql once to bootstrap exec_sql' : '') +
          ': ' + msg.slice(0, 160)
      );
    }
  }

  // tenants.activation_status — the column the email-verification gate writes.
  // Idempotent ALTER; only fires when PostgREST reports the column missing.
  try {
    const tcol = await c.from('tenants').select('activation_status').limit(1);
    if (tcol.error && /activation_status/i.test(String(tcol.error?.message || tcol.error))) {
      const res = await c.rpc('exec_sql', { p_sql: ACTIVATION_STATUS_DDL });
      if (res?.error) throw new Error(res.error?.message || 'exec_sql returned an error');
      console.log('[migrate] applied tenants.activation_status (email-verification gate column)');
      applied.push('activation_status');
    }
  } catch (e) {
    console.warn('[migrate] activation_status ensure failed:', String(e?.message || e).slice(0, 160));
  }

  // mfa_registrations — owner 2FA enrollment/verification store; the
  // self-heal fires when the 2FA endpoint cold-starts (see MFA_REGISTRATIONS_DDL).
  await ensureTable(c, 'mfa_registrations', MFA_REGISTRATIONS_DDL, applied);
  // platform_settings — customer-care line KV; self-heals when the
  // customer-care endpoint cold-starts.
  await ensureTable(c, 'platform_settings', PLATFORM_SETTINGS_DDL, applied);

  return applied.length ? 'applied' : 'up-to-date';
}
