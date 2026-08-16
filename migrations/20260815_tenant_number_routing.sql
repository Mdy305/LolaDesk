-- ============================================================================
-- exec_sql bootstrap — lets the app self-apply idempotent migrations at boot
-- ============================================================================
-- PostgREST (what @supabase/supabase-js talks to) cannot run DDL. This single
-- security-definer function is the one-time bootstrap that api/lib/migrate.js
-- calls via supabase.rpc('exec_sql', …) to create tenant_numbers (and future
-- migrations) automatically on cold start. Executable ONLY with the service
-- key; anon/authenticated are revoked so a browser token can never run SQL.
create or replace function public.exec_sql(p_sql text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  execute p_sql;
end;
$$;

revoke all on function public.exec_sql(text) from public;

-- Supabase grants EXECUTE on functions to anon + authenticated DIRECTLY (not
-- via PUBLIC), so the revoke above alone does NOT stop a browser token there.
-- Revoke from each role explicitly; skip roles that don't exist so this stays
-- portable to plain Postgres / local e2e.
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke execute on function public.exec_sql(text) from %I', r);
    end if;
  end loop;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.exec_sql(text) to service_role';
  end if;
end $$;

-- ============================================================================
-- Multi-Tenant Inbound Call Routing table
-- ============================================================================
-- This is the AUTHORITATIVE number -> tenant map used by lib/tenant-resolver.js
-- BEFORE Lola speaks her first syllable. It exists so a tenant can own MORE
-- than one number (forwarded lines, sub-brands, an owner line) and so routing
-- metadata (connection id, status) lives next to the mapping instead of being
-- crammed into the single tenants.phone_number column.
--
-- Invariants this table enforces for the resolver:
--   1. phone_number is UNIQUE  -> one number routes to exactly ONE tenant.
--      A duplicate is a hard failure ("ambiguous"), never a guess.
--   2. status != 'active'      -> the number is inert ("disabled").
--   3. on delete cascade       -> deleting a tenant deletes its routing rows,
--      so a recycled number can never leak a previous tenant's data.
-- ============================================================================

create table if not exists tenant_numbers (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  phone_number  text not null,                    -- E.164, e.g. +13055550100
  kind          text not null default 'primary',  -- primary | forwarded | sub_brand | owner_line
  connection_id text,                             -- Telnyx connection / TeXML app id (metadata)
  status        text not null default 'active',   -- active | pending | disabled
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (phone_number)
);

create index if not exists idx_tenant_numbers_tenant on tenant_numbers (tenant_id);
create index if not exists idx_tenant_numbers_phone  on tenant_numbers (phone_number);

-- Backfill every tenant that already provisioned a number. The resolver
-- prefers this table and falls back to tenants.phone_number, so the backfill
-- keeps existing tenants routable without re-provisioning.
insert into tenant_numbers (tenant_id, phone_number, kind, status)
select t.id, t.phone_number, 'primary', 'active'
from tenants t
where t.phone_number is not null and t.phone_number <> ''
on conflict (phone_number) do nothing;

-- All reads in this codebase go through the service-role client, but enable
-- RLS with NO public policy anyway so a leaked anon key cannot enumerate the
-- number->tenant map. Safe default is deny.
alter table tenant_numbers enable row level security;
