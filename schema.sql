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
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);
create index if not exists idx_tenants_phone on tenants(phone_number);

-- ── CLIENTS ──
-- People who call/text/visit a salon
create table if not exists clients (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  phone_number    text,                                 -- caller's number, E.164
  name            text,
  email           text,
  is_vip          boolean default false,
  last_service    text,
  last_visit      date,
  preferred_stylist text,
  lifetime_value  numeric default 0,
  notes           text,
  tags            text[] default '{}',
  opted_out       boolean default false,        -- STOP keyword received; never text again
  opted_out_at    timestamptz,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  unique(tenant_id, phone_number)
);
create index if not exists idx_clients_tenant on clients(tenant_id);
create index if not exists idx_clients_phone on clients(tenant_id, phone_number);

-- Migration safety net: add opted_out columns if this schema was already
-- run before SMS compliance was added (idempotent — safe to re-run).
alter table clients add column if not exists opted_out boolean default false;
alter table clients add column if not exists opted_out_at timestamptz;

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
  telnyx_call_id  text,
  from_number     text,
  to_number       text,
  direction       text,                                 -- inbound | outbound
  duration_sec    int,
  outcome         text,
  booking_probability int,
  recording_url   text,
  transcript      text,
  created_at      timestamptz default now()
);
create index if not exists idx_calls_tenant on calls(tenant_id, created_at desc);

-- ── BOOKINGS ──
-- Appointments Lola actually booked (will sync with Square/Vagaro/etc later)
create table if not exists bookings (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  client_id       uuid references clients(id) on delete set null,
  conversation_id uuid references conversations(id),
  service         text not null,
  stylist         text,
  starts_at       timestamptz not null,
  duration_min    int,
  price           numeric,
  status          text default 'confirmed',             -- confirmed | cancelled | completed | no-show
  external_id     text,                                 -- Square/Vagaro/etc booking id
  external_source text,                                 -- 'square' | 'vagaro' | etc
  created_at      timestamptz default now()
);
create index if not exists idx_bk_tenant on bookings(tenant_id, starts_at);

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

-- Helper: read tenant_id from JWT (works once Supabase Auth is wired)
create or replace function auth_tenant() returns uuid as $$
  select nullif(current_setting('request.jwt.claims', true)::json->>'tenant_id','')::uuid;
$$ language sql stable;

-- Tenant-scoped read policies (one per table)
drop policy if exists tenant_read_own on tenants;
create policy tenant_read_own on tenants for select
  using (id = auth_tenant());

do $$ declare t text; begin
  for t in select unnest(array['clients','conversations','messages','calls','bookings','usage_events','integrations'])
  loop
    execute format('drop policy if exists %I_read on %I', t, t);
    execute format('create policy %I_read on %I for select using (tenant_id = auth_tenant())', t, t);
  end loop;
end $$;

-- ─── SEED: MMA Salon (so the live app immediately has a tenant) ───
insert into tenants (slug, name, owner_name, owner_email, location, hours, booking_url, phone_number, plan, services, team)
values (
  'mma-salon', 'MMΛ Salon', 'Meddy', 'meddy@mmasalon.com',
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
