-- LolaDesk canonical calendar core
-- Idempotent, non-destructive migration. Adds the missing scheduling integrity layer
-- without removing legacy tables (appointments / stylists / salons / organizations).

create extension if not exists pgcrypto;

-- Canonical booking settings per tenant
create table if not exists public.booking_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  timezone text not null default 'America/New_York',
  slot_interval_minutes integer not null default 15 check (slot_interval_minutes between 5 and 120),
  minimum_notice_minutes integer not null default 120 check (minimum_notice_minutes >= 0),
  booking_horizon_days integer not null default 90 check (booking_horizon_days between 1 and 730),
  cancellation_window_hours integer not null default 24 check (cancellation_window_hours >= 0),
  default_buffer_before_min integer not null default 0 check (default_buffer_before_min >= 0),
  default_buffer_after_min integer not null default 0 check (default_buffer_after_min >= 0),
  allow_staff_choice boolean not null default true,
  allow_any_staff boolean not null default true,
  allow_processing_overlap boolean not null default true,
  public_booking_enabled boolean not null default true,
  voice_booking_enabled boolean not null default true,
  sms_booking_enabled boolean not null default true,
  require_phone boolean not null default true,
  require_email boolean not null default false,
  confirmation_sms boolean not null default true,
  reminder_sms boolean not null default true,
  deposit_policy jsonb not null default '{}'::jsonb,
  cancellation_policy jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Temporary slot holds prevent a voice caller and web user from taking the same slot.
create table if not exists public.availability_holds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  staff_id uuid references public.staff(id) on delete cascade,
  service_id uuid references public.services(id) on delete set null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  channel text not null default 'voice',
  conversation_id uuid,
  hold_token text not null unique default encode(gen_random_bytes(18), 'hex'),
  expires_at timestamptz not null default (now() + interval '5 minutes'),
  status text not null default 'active' check (status in ('active','released','converted','expired')),
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists idx_availability_holds_tenant_staff_time
  on public.availability_holds(tenant_id, staff_id, starts_at, ends_at)
  where status = 'active';
create index if not exists idx_availability_holds_expiry
  on public.availability_holds(expires_at)
  where status = 'active';

-- Cross-provider IDs: one canonical Lola service/staff/location -> provider object IDs.
create table if not exists public.provider_mappings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider text not null,
  entity_type text not null check (entity_type in ('service','staff','location','client','resource')),
  local_id uuid not null,
  external_id text not null,
  external_parent_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, provider, entity_type, local_id),
  unique (tenant_id, provider, entity_type, external_id)
);
create index if not exists idx_provider_mappings_lookup
  on public.provider_mappings(tenant_id, provider, entity_type, local_id);

-- Rooms, chairs, machines, assistants-as-resources, etc.
create table if not exists public.resources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  location_id uuid references public.locations(id) on delete cascade,
  name text not null,
  resource_type text not null default 'chair',
  capacity integer not null default 1 check (capacity > 0),
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table if not exists public.service_resources (
  service_id uuid not null references public.services(id) on delete cascade,
  resource_id uuid not null references public.resources(id) on delete cascade,
  quantity integer not null default 1 check (quantity > 0),
  required boolean not null default true,
  primary key(service_id, resource_id)
);

-- Multi-service booking support.
create table if not exists public.booking_services (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  service_id uuid references public.services(id) on delete set null,
  staff_id uuid references public.staff(id) on delete set null,
  sequence_no integer not null default 1,
  active_duration_1_min integer not null default 0,
  processing_duration_min integer not null default 0,
  active_duration_2_min integer not null default 0,
  buffer_before_min integer not null default 0,
  buffer_after_min integer not null default 0,
  price numeric not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(booking_id, sequence_no)
);
create index if not exists idx_booking_services_booking on public.booking_services(booking_id);

create table if not exists public.booking_resources (
  booking_id uuid not null references public.bookings(id) on delete cascade,
  resource_id uuid not null references public.resources(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  quantity integer not null default 1,
  primary key(booking_id, resource_id, starts_at),
  check (ends_at > starts_at)
);

-- Immutable booking lifecycle history for AI, dashboard and provider webhooks.
create table if not exists public.booking_status_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  from_status text,
  to_status text not null,
  source text not null default 'lola',
  actor_id uuid,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_booking_history_booking
  on public.booking_status_history(booking_id, created_at);

-- Bring the canonical bookings table up to the contract used by the new calendar layer.
alter table public.bookings add column if not exists location_id uuid references public.locations(id) on delete set null;
alter table public.bookings add column if not exists source text not null default 'lola';
alter table public.bookings add column if not exists conversation_id uuid;
alter table public.bookings add column if not exists external_id text;
alter table public.bookings add column if not exists external_provider text;
alter table public.bookings add column if not exists hold_id uuid references public.availability_holds(id) on delete set null;
alter table public.bookings add column if not exists deposit_status text default 'none';

create index if not exists idx_bookings_tenant_staff_time
  on public.bookings(tenant_id, staff_id, start_time, end_time)
  where status not in ('cancelled','canceled');
create index if not exists idx_bookings_tenant_client
  on public.bookings(tenant_id, client_id, start_time desc);

-- Convenience trigger to maintain updated_at where present.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname='trg_booking_settings_touch') then
    create trigger trg_booking_settings_touch before update on public.booking_settings
    for each row execute function public.touch_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname='trg_provider_mappings_touch') then
    create trigger trg_provider_mappings_touch before update on public.provider_mappings
    for each row execute function public.touch_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname='trg_resources_touch') then
    create trigger trg_resources_touch before update on public.resources
    for each row execute function public.touch_updated_at();
  end if;
end $$;

-- RLS: same tenant membership helpers already used throughout LolaDesk.
alter table public.booking_settings enable row level security;
alter table public.availability_holds enable row level security;
alter table public.provider_mappings enable row level security;
alter table public.resources enable row level security;
alter table public.service_resources enable row level security;
alter table public.booking_services enable row level security;
alter table public.booking_resources enable row level security;
alter table public.booking_status_history enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='booking_settings' and policyname='tenant_booking_settings') then
    create policy tenant_booking_settings on public.booking_settings for all using (is_tenant_member(tenant_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='availability_holds' and policyname='tenant_availability_holds') then
    create policy tenant_availability_holds on public.availability_holds for all using (is_tenant_member(tenant_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='provider_mappings' and policyname='tenant_provider_mappings') then
    create policy tenant_provider_mappings on public.provider_mappings for all using (is_tenant_member(tenant_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='resources' and policyname='tenant_resources') then
    create policy tenant_resources on public.resources for all using (is_tenant_member(tenant_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='booking_status_history' and policyname='tenant_booking_history') then
    create policy tenant_booking_history on public.booking_status_history for all using (is_tenant_member(tenant_id));
  end if;
end $$;
