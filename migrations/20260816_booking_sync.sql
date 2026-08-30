-- ============================================================================
-- Booking sync pipeline (idempotent)
-- Vercel cron polls the connected booking providers (Square / Boulevard /
-- Vagaro / Mindbody / Fresha / Google Calendar) and refreshes the cached
-- availability table that the voice/web booking engine fast-reads.
-- ============================================================================

-- ── cached_availability: provider snapshot, normalized ─────────────
-- One row per appointment the provider reports for this tenant's calendar.
-- The availability engine treats rows with status 'booked' as busy time.
-- external_booking_id is the provider's appointment id (or a synthetic key
-- when the provider exposes none), so re-syncs upsert instead of duplicating.
create table if not exists cached_availability (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  provider             text not null,
  external_booking_id  text not null,
  starts_at            timestamptz not null,
  ends_at              timestamptz not null,
  duration_min         integer not null default 60,
  staff_id             text,                 -- provider-side staff id/name (unmapped)
  service              text,
  client_name          text,
  status               text not null default 'booked',  -- booked | cancelled | completed
  last_synced_at       timestamptz not null default now(),
  unique (tenant_id, provider, external_booking_id)
);

create index if not exists idx_cached_availability_tenant on cached_availability (tenant_id, starts_at);
create index if not exists idx_cached_availability_status on cached_availability (tenant_id, status, starts_at);

-- ── booking_sync_log: audit trail for every cron run ───────────────
create table if not exists booking_sync_log (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid references tenants(id) on delete cascade,
  provider       text,
  kind           text not null default 'availability',
  fetched        integer not null default 0,
  upserted       integer not null default 0,
  stale_removed  integer not null default 0,
  error_message  text,
  duration_ms    integer,
  created_at     timestamptz not null default now()
);

create index if not exists idx_booking_sync_log_tenant on booking_sync_log (tenant_id, created_at desc);

-- ── external_appointments: view over the cache (health check + read path) ──
create or replace view external_appointments as
select id, tenant_id, provider, external_booking_id as external_id,
       starts_at, ends_at, duration_min, service, client_name, status, last_synced_at
from cached_availability;

-- ── RLS: service-role only (deny by default); tenant-scoped reads ──
alter table cached_availability enable row level security;
drop policy if exists cached_availability_read on cached_availability;
create policy cached_availability_read on cached_availability
  for select using (tenant_id = auth_tenant());

alter table booking_sync_log enable row level security;
drop policy if exists booking_sync_log_read on booking_sync_log;
create policy booking_sync_log_read on booking_sync_log
  for select using (tenant_id = auth_tenant());
