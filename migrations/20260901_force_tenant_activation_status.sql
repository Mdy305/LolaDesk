-- 20260901_force_tenant_activation_status.sql — repair: activation_status must exist.
-- =============================================================================
-- ROOT CAUSE FOUND LIVE: on an established database the migration applier
-- (api/lib/migrate-all.js) records the whole current migration set as its
-- baseline WITHOUT executing it. Production's tenants table therefore never
-- received `activation_status` from 20260831_email_verify.sql, so real signups
-- wrote a tenants row containing an unknown column and the swallowed insert
-- error made the API answer "Could not create workspace" — while the auth user
-- had already been created (an orphaned, locked-out account). The ORIGINAL
-- migration filename is already in migrations_ledger and will never re-run, so
-- this file carries a NEW filename to force the column into existence on the
-- next apply. Idempotent — safe on fresh and established databases alike.
-- =============================================================================
alter table public.tenants add column if not exists activation_status text not null default 'active';

create index if not exists idx_tenants_activation_status on public.tenants(activation_status) where activation_status is not null;