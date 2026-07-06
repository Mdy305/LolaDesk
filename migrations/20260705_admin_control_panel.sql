-- Admin control panel storage. Run in the Supabase SQL editor.

-- Per-tenant feature flags the admin can toggle (e.g. {"voice":true,"campaigns":false}).
alter table tenants add column if not exists features jsonb default '{}'::jsonb;

-- Optional short internal note the admin can leave on a customer.
alter table tenants add column if not exists admin_note text;

-- Single-row global platform config (default persona/prompt, plan prices,
-- announcement banner, connector toggles). Keyed 'global'.
create table if not exists platform_config (
  id          text primary key default 'global',
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz default now()
);
insert into platform_config (id, data) values ('global', '{}'::jsonb)
  on conflict (id) do nothing;

-- Server-only (service key). No public policies.
alter table platform_config enable row level security;

