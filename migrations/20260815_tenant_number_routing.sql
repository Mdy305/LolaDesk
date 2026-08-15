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
