-- ═══════════════════════════════════════════════════════════════════
-- LolaDesk Multi-Tenant Schema
-- Paste this into Supabase → SQL Editor → New query → Run
-- One-time setup. Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════

-- Extensions
create extension if not exists pgcrypto;

-- ── TENANTS ──
-- One row per salon using LolaDesk
create table if not exists tenants (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique not null,                 -- e.g. "mma-salon"
  name            text not null,                        -- "MMΛ Salon"
  owner_name      text,
  owner_email     text,
  location        text,
  hours           text,
  booking_url     text,
  phone_number    text unique,                          -- their Lola number, E.164
  plan            text default 'starter',               -- starter | pro | medspa | enterprise
  stripe_customer_id  text,
  trial_ends_at   timestamptz,
  services        jsonb default '[]'::jsonb,            -- [{name, price, duration}]
  team            jsonb default '[]'::jsonb,            -- [{name, role}]
  persona         text default 'warm',                  -- Lola's voice style
  voice_id        text,                                  -- per-tenant ElevenLabs voice (null = platform default)
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);
create index if not exists idx_tenants_phone on tenants(phone_number);

-- ── CLIENTS ──
-- People who call/text/visit a salon
-- CANONICAL shape: the API writes first_name/last_name/phone/status and
-- reads the legacy aliases (name, phone_number, is_vip, opted_out) as STORED
-- GENERATED columns (see 20260818_clients_schema_compat.sql for the same
-- reconciliation on legacy databases). schema.sql must create THIS shape so a
-- fresh DB matches production — the old shape (real phone_number/name/opted_out
-- columns) made every client write fail on a new database.
create table if not exists clients (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  first_name          text,
  last_name           text,
  phone               text,                          -- caller's number, E.164 (canonical)
  email               text,
  status              text not null default 'active',-- active | opted_out | vip
  preferred_service   text,
  preferred_staff_id  uuid,
  profile_picture_url text,
  lifetime_value      numeric default 0,
  last_visit          timestamptz,
  notes               text,
  tags                text[] default '{}',
  preferences         jsonb default '{}'::jsonb,
  whatsapp_enabled    boolean default false,
  opted_out_at        timestamptz,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now(),
  -- Legacy aliases (generated, immutable expressions — never writable)
  name text generated always as (
    nullif(btrim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')), '')
  ) stored,
  phone_number text generated always as (phone) stored,
  last_service text generated always as (preferred_service) stored,
  is_vip boolean generated always as (
    lower(coalesce(status, '')) = 'vip' or coalesce(lifetime_value, 0) >= 1000
  ) stored,
  opted_out boolean generated always as (
    lower(coalesce(status, '')) = 'opted_out'
  ) stored,
  unique(tenant_id, phone)
);
create index if not exists idx_clients_tenant on clients(tenant_id);
create index if not exists idx_clients_phone on clients(tenant_id, phone);

-- ── SERVICES ──
-- The salon's bookable menu. Referenced by every booking layer (calendar,
-- availability, operator voice, lola tools) — part of the canonical booking
-- contract. (Production predates this repo's schema snapshot; these tables
-- must exist here too or a fresh DB cannot run the booking stack.)
create table if not exists services (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  name             text not null,
  description      text,
  duration_minutes int not null default 60,
  price            numeric not null default 0,
  category         text,
  is_active        boolean not null default true,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);
create index if not exists idx_services_tenant on services(tenant_id);

-- ── STAFF ──
create table if not exists staff (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  name       text not null,
  role       text,
  email      text,
  phone      text,
  color      text,
  is_active  boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_staff_tenant on staff(tenant_id);

-- which staff can perform which service
create table if not exists staff_services (
  staff_id   uuid not null references staff(id) on delete cascade,
  service_id uuid not null references services(id) on delete cascade,
  primary key (staff_id, service_id)
);

-- weekly availability per staff member (day_of_week: 0 = Sunday)
create table if not exists staff_schedules (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  staff_id   uuid not null references staff(id) on delete cascade,
  day_of_week int not null check (day_of_week between 0 and 6),
  start_time time not null,
  end_time   time not null
);
create index if not exists idx_staff_schedules_tenant on staff_schedules(tenant_id, staff_id);

-- time off / blocked days per staff member
create table if not exists staff_time_off (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  staff_id   uuid references staff(id) on delete cascade,
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  reason     text,
  created_at timestamptz default now()
);

-- ── LOCATIONS ──
create table if not exists locations (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  name       text not null,
  address    text,
  created_at timestamptz default now()
);

-- ── CONVERSATIONS ──
-- A logical conversation thread (phone call, SMS thread, IG DM, WhatsApp)
create table if not exists conversations (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  client_id       uuid references clients(id) on delete set null,
  channel         text not null,                        -- voice | sms | whatsapp | instagram | email
  agent           text,                                 -- which Lola agent handled it
  intent          text,                                 -- detected intent
  outcome         text,                                 -- booked | quoted | escalated | no-action
  status          text default 'open',                  -- open | closed
  started_at      timestamptz default now(),
  ended_at        timestamptz,
  metadata        jsonb default '{}'::jsonb
);
create index if not exists idx_conv_tenant on conversations(tenant_id, started_at desc);
create index if not exists idx_conv_client on conversations(client_id);

-- ── MESSAGES ──
-- Every turn in every conversation (what the client said, what Lola said back)
create table if not exists messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  tenant_id       uuid not null references tenants(id) on delete cascade,
  role            text not null,                        -- user | assistant | system
  agent           text,                                 -- which agent (lola, booker, ...)
  content         text not null,
  created_at      timestamptz default now()
);
create index if not exists idx_msg_conv on messages(conversation_id, created_at);
create index if not exists idx_msg_tenant on messages(tenant_id, created_at desc);

-- ── CALLS ──
-- Voice-specific call record (one per Telnyx call)
create table if not exists calls (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  conversation_id uuid references conversations(id),
  client_id       uuid references clients(id),
  from_number     text,
  to_number       text,
  direction       text,                                 -- inbound | outbound
  -- canonical contract (what the app reads/writes): status / duration_seconds /
  -- telnyx_call_control_id / recording_url (transcript rides in recording_url).
  duration_seconds int,
  status          text,
  booking_probability int,
  recording_url   text,
  telnyx_call_control_id text,
  created_at      timestamptz default now(),
  -- Legacy aliases (canonical real, legacy generated — same rule as bookings):
  telnyx_call_id  text generated always as (telnyx_call_control_id) stored,
  duration_sec    int generated always as (duration_seconds) stored,
  outcome         text generated always as (status) stored,
  transcript      text generated always as (recording_url) stored
);
create index if not exists idx_calls_tenant on calls(tenant_id, created_at desc);

-- ── BOOKINGS ──
-- Appointments Lola actually booked (will sync with Square/Vagaro/etc later)
create table if not exists bookings (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  client_id         uuid references clients(id) on delete set null,
  conversation_id   uuid references conversations(id),
  -- canonical booking contract (what the calendar/booking/operator layers
  -- read and write): service_id/staff_id/start_time/end_time/total_amount
  service_id        uuid references services(id) on delete set null,
  staff_id          uuid references staff(id) on delete set null,
  location_id       uuid references locations(id) on delete set null,
  service           text,
  stylist           text,
  start_time        timestamptz not null,
  end_time          timestamptz,
  duration_min      int,
  total_amount      numeric default 0,
  status            text default 'confirmed',           -- confirmed | cancelled | completed | no-show
  notes             text,
  source            text default 'lola',                -- 'lola' | 'dashboard' | 'square' | 'public_widget' | ...
  external_id       text,                               -- Square/Vagaro/etc booking id
  external_provider text,                               -- 'square' | 'vagaro' | etc
  external_source   text,                               -- legacy alias kept for older readers
  hold_id           uuid,
  deposit_status    text default 'none',
  confirmation_code text,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now(),
  -- Legacy aliases: canonical shape is start_time/end_time/total_amount.
  -- Mirrors 20260818_clients_schema_compat.sql (canonical real, legacy
  -- generated) so a fresh DB matches production and older readers keep
  -- working. starts_at/price are read-only.
  starts_at         timestamptz generated always as (start_time) stored,
  price             numeric generated always as (total_amount) stored
);
create index if not exists idx_bk_tenant on bookings(tenant_id, start_time);

-- ── USAGE EVENTS ──
-- What Lola did (for billing + analytics)
create table if not exists usage_events (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  kind            text not null,                        -- call_minute | sms_sent | sms_received | whatsapp | ai_token
  units           numeric default 1,
  metadata        jsonb default '{}'::jsonb,
  created_at      timestamptz default now()
);
create index if not exists idx_usage_tenant on usage_events(tenant_id, created_at desc);
create index if not exists idx_usage_kind on usage_events(tenant_id, kind, created_at desc);

-- ── INTEGRATIONS ──
-- OAuth tokens for Square / Vagaro / Boulevard / Mindbody / Shopify (encrypted at rest)
create table if not exists integrations (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  provider        text not null,                        -- 'square' | 'vagaro' | 'boulevard' | ...
  access_token    text,                                 -- encrypt at application layer
  refresh_token   text,
  expires_at      timestamptz,
  metadata        jsonb default '{}'::jsonb,
  status          text default 'connected',
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  unique(tenant_id, provider)
);

-- ── NUMBER PORT REQUESTS ──
-- Tracks "keep my number" onboarding and Telnyx transfer status.
create table if not exists tenant_number_ports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  requested_phone_number text not null,
  status text not null default 'draft',                 -- draft | submitted | in_progress | completed | rejected
  current_carrier text,
  account_number text,
  account_pin text,
  billing_name text,
  billing_address text,
  authorized_contact_name text,
  authorized_contact_email text,
  telnyx_order_id text,
  foc_date timestamptz,
  temporary_phone_number text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_tenant_number_ports_tenant on tenant_number_ports(tenant_id, created_at desc);
create index if not exists idx_tenant_number_ports_order on tenant_number_ports(telnyx_order_id);

-- ─── updated_at trigger ───
create or replace function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists trg_tenants_updated on tenants;
create trigger trg_tenants_updated before update on tenants
  for each row execute function set_updated_at();
drop trigger if exists trg_clients_updated on clients;
create trigger trg_clients_updated before update on clients
  for each row execute function set_updated_at();
drop trigger if exists trg_integrations_updated on integrations;
create trigger trg_integrations_updated before update on integrations
  for each row execute function set_updated_at();
drop trigger if exists trg_tenant_number_ports_updated on tenant_number_ports;
create trigger trg_tenant_number_ports_updated before update on tenant_number_ports
  for each row execute function set_updated_at();

-- ─── ROW LEVEL SECURITY ───
-- Service role bypasses RLS. Browser-side reads go through these policies.
-- Each policy assumes the user's JWT contains their tenant_id (set via Supabase Auth).
alter table tenants        enable row level security;
alter table clients        enable row level security;
alter table conversations  enable row level security;
alter table messages       enable row level security;
alter table calls          enable row level security;
alter table bookings       enable row level security;
alter table usage_events   enable row level security;
alter table integrations   enable row level security;
alter table tenant_number_ports enable row level security;

-- Helper: read tenant_id from JWT (works once Supabase Auth is wired)
create or replace function auth_tenant() returns uuid as $$
  select nullif(current_setting('request.jwt.claims', true)::json->>'tenant_id','')::uuid;
$$ language sql stable;

-- Tenant-scoped read policies (one per table)
drop policy if exists tenant_read_own on tenants;
create policy tenant_read_own on tenants for select
  using (id = auth_tenant());

do $$ declare t text; begin
  for t in select unnest(array['clients','conversations','messages','calls','bookings','usage_events','integrations','tenant_number_ports'])
  loop
    execute format('drop policy if exists %I_read on %I', t, t);
    execute format('create policy %I_read on %I for select using (tenant_id = auth_tenant())', t, t);
  end loop;
end $$;

-- ─── SEED: MMA Salon (so the live app immediately has a tenant) ───
-- NOTE: slug is 'mma' (not 'mma-salon') because api/data.js and
-- api/notifications.js both default to getTenantBySlug('mma') when
-- there's no auth token and no explicit ?tenant= param. Keep these in
-- sync if either ever changes.
insert into tenants (slug, name, owner_name, owner_email, location, hours, booking_url, phone_number, plan, services, team)
values (
  'mma', 'MMΛ Salon', 'Meddy', 'meddy@mmasalon.com',
  '1500 Alton Road, 2nd Floor, Miami Beach FL 33139',
  'Tuesday to Saturday, noon to 8pm',
  'https://www.mmasalon.com/book',
  '+19294568227',
  'pro',
  '[
    {"name":"Balayage","price":395,"duration":"2h30"},
    {"name":"Extensions","price":800,"duration":"consult"},
    {"name":"Hair Botox","price":325,"duration":"2h"},
    {"name":"Keratin","price":450,"duration":"2h30"},
    {"name":"Cut & Gloss","price":225,"duration":"1h15"},
    {"name":"Blowout","price":95,"duration":"1h"}
  ]'::jsonb,
  '[
    {"name":"Meddy","role":"Owner · Master Colorist"},
    {"name":"Michelle","role":"Senior Stylist"},
    {"name":"Alice","role":"Senior Stylist"},
    {"name":"Samantha","role":"Stylist"}
  ]'::jsonb
)
on conflict (slug) do update set
  phone_number = excluded.phone_number,
  services = excluded.services,
  team = excluded.team,
  updated_at = now();

-- ─── exec_sql bootstrap: lets the app self-apply idempotent migrations ───
-- PostgREST cannot run DDL, so api/lib/migrate.js calls this security-definer
-- function (via supabase.rpc) to create the tenant_numbers table on cold start
-- when it's missing. Revoked from anon/authenticated so a browser token can
-- never execute arbitrary SQL; only the service_role key may call it.
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
