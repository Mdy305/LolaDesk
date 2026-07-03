-- ════════════════════════════════════════════════════════════════
-- 20260701 — COMPLETE THE SUPABASE WIRING
-- ════════════════════════════════════════════════════════════════
-- Result of a full audit of every `.from('...')` and every tenant
-- column the code reads/writes, compared against schema.sql +
-- migrations. This migration closes every gap found. Idempotent —
-- safe to re-run. Run AFTER schema.sql and the earlier migrations.
--
-- Gaps closed here:
--   1. tenants columns the code WRITES but schema never defined —
--      without these, /api/auth/signup's tenant insert FAILS OUTRIGHT
--      (website_url, business_mode) and Settings saves fail (knowledge).
--   2. tenants columns Lola's skills READ as optional salon config
--      (loyalty, payment link, packages, discounts).
--   3. Six tables used by live code but defined nowhere:
--      client_memories (EVERY sms/voice memory write was silently
--      failing), demo_requests, deposits, waitlist_entries,
--      satisfaction_surveys, callback_requests.
--   4. RLS on all new tables + on jobs/orchestrator_audit (the
--      20260623 migration created them without RLS).
--   5. The 'voice-audio' Storage bucket that speak-demo.js uploads to.
-- ════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ── 1+2. TENANT COLUMNS ─────────────────────────────────────────
-- Write-path breakers (signup + settings):
alter table tenants add column if not exists website_url    text;
alter table tenants add column if not exists business_mode  text default 'salon';  -- salon | spa | medspa
alter table tenants add column if not exists knowledge      text;                  -- freeform "teach Lola" notes
alter table tenants add column if not exists billing_status text default 'trial';  -- folded from billing-migration.sql

-- Optional salon config Lola's skills read (null = feature not configured):
alter table tenants add column if not exists loyalty_program           jsonb;   -- {enabled, description, ...}
alter table tenants add column if not exists payment_link              text;    -- deposit / prepay link
alter table tenants add column if not exists stylists                  jsonb;   -- richer than team: [{name, specialties, ...}]
alter table tenants add column if not exists referral_reward           text;    -- e.g. "$25 credit"
alter table tenants add column if not exists first_time_discount       text;    -- e.g. "15% off first visit"
alter table tenants add column if not exists event_package_base_price  numeric;
alter table tenants add column if not exists event_package_per_person  numeric;

-- ── 3. MISSING TABLES ───────────────────────────────────────────

-- client_memories — Lola's per-caller memory (preferences, feedback,
-- profile). Two writers with two natural keys, both supported:
--   api/lib/db.js          → (tenant_id, client_phone, key)
--   api/lib/advanced-skills → (client_id, key)
create table if not exists client_memories (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  client_id     uuid references clients(id) on delete cascade,
  client_phone  text,                                   -- E.164
  key           text not null,                          -- 'profile' | 'preferences' | 'last_feedback' | ...
  value         jsonb default '{}'::jsonb,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
-- Both upsert conflict targets need a full (non-partial) unique index
-- so PostgREST's ON CONFLICT inference works:
create unique index if not exists uq_client_memories_phone
  on client_memories(tenant_id, client_phone, key);
create unique index if not exists uq_client_memories_client
  on client_memories(client_id, key);
create index if not exists idx_client_memories_tenant
  on client_memories(tenant_id, created_at desc);

-- demo_requests — "call me" demos from the marketing site (pre-signup,
-- so no tenant_id; rate-limited per phone in api/lib/db.js).
create table if not exists demo_requests (
  id            uuid primary key default gen_random_uuid(),
  phone_number  text not null,                          -- E.164
  ip            text,
  processed     boolean default false,
  metadata      jsonb default '{}'::jsonb,
  created_at    timestamptz default now()
);
create index if not exists idx_demo_requests_phone
  on demo_requests(phone_number, created_at desc);

-- deposits — booking deposits taken through Stripe.
create table if not exists deposits (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references tenants(id) on delete cascade,
  booking_id                uuid references bookings(id) on delete set null,
  amount                    numeric not null default 0,
  status                    text default 'pending',     -- pending | paid | refunded | failed
  stripe_payment_intent_id  text,
  created_at                timestamptz default now()
);
create index if not exists idx_deposits_tenant on deposits(tenant_id, created_at desc);

-- waitlist_entries — "that slot is taken, want the waitlist?" capture.
create table if not exists waitlist_entries (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  service_name   text,
  preferred_date text,
  client_phone   text,
  client_name    text,
  status         text default 'active',                 -- active | fulfilled | expired
  created_at     timestamptz default now()
);
create index if not exists idx_waitlist_tenant on waitlist_entries(tenant_id, created_at desc);

-- satisfaction_surveys — post-visit scores Lola collects.
create table if not exists satisfaction_surveys (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  client_id   uuid references clients(id) on delete set null,
  score       int default 0,
  feedback    text default '',
  created_at  timestamptz default now()
);
create index if not exists idx_surveys_tenant on satisfaction_surveys(tenant_id, created_at desc);

-- callback_requests — "have a human call me back" escalations.
create table if not exists callback_requests (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  client_phone   text,
  client_name    text,
  preferred_time text,
  issue          text default '',
  status         text default 'pending',                -- pending | called | closed
  created_at     timestamptz default now()
);
create index if not exists idx_callbacks_tenant on callback_requests(tenant_id, created_at desc);

-- updated_at trigger for client_memories (matches the other tables)
drop trigger if exists trg_client_memories_updated on client_memories;
create trigger trg_client_memories_updated before update on client_memories
  for each row execute function set_updated_at();

-- ── 4. ROW LEVEL SECURITY ───────────────────────────────────────
-- Service role (used by all api/*) bypasses RLS; these policies are
-- the safety net for any anon/browser-key access. Tenant-scoped
-- tables get the same tenant read policy as the rest of the schema;
-- demo_requests / jobs / orchestrator_audit get RLS with NO policies
-- (service-role only — nothing browser-facing should touch them).
alter table client_memories       enable row level security;
alter table deposits              enable row level security;
alter table waitlist_entries      enable row level security;
alter table satisfaction_surveys  enable row level security;
alter table callback_requests     enable row level security;
alter table demo_requests         enable row level security;
alter table jobs                  enable row level security;
alter table orchestrator_audit    enable row level security;

do $$ declare t text; begin
  for t in select unnest(array['client_memories','deposits','waitlist_entries','satisfaction_surveys','callback_requests'])
  loop
    execute format('drop policy if exists %I_read on %I', t, t);
    execute format('create policy %I_read on %I for select using (tenant_id = auth_tenant())', t, t);
  end loop;
end $$;

-- ── 5. STORAGE: voice-audio bucket ──────────────────────────────
-- api/speak-demo.js uploads Lola's demo audio here and serves the
-- public URL; api/lib/tts-cache.js documents this bucket as the
-- cross-instance upgrade path for call audio. Public read is
-- intentional: Telnyx <Play> and the demo player fetch anonymously.
insert into storage.buckets (id, name, public)
values ('voice-audio', 'voice-audio', true)
on conflict (id) do nothing;

drop policy if exists voice_audio_public_read on storage.objects;
create policy voice_audio_public_read on storage.objects
  for select using (bucket_id = 'voice-audio');
