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
  telnyx_org_id   text,                                 -- Telnyx Managed Account (Sub-Org ID)
  telnyx_api_key  text,                                 -- Scoped API key for the tenant
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
-- Add billing status to tenants (run in Supabase SQL editor)
alter table tenants add column if not exists billing_status text default 'trial';
-- values: trial | active | past_due | cancelled
-- Migration: create orchestrator_audit and jobs tables
-- Run in Supabase SQL Editor or via migrations pipeline

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Audit table for raw LLM outputs and validation results
CREATE TABLE IF NOT EXISTS orchestrator_audit (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),
  prompt TEXT,
  llm_output JSONB,
  valid BOOLEAN DEFAULT FALSE,
  errors TEXT[],
  validated_at TIMESTAMPTZ
);

-- Jobs table for background processing (TTS, demo calls, connector writes)
CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  payload JSONB,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, processing, succeeded, failed
  attempts INT NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency_idx ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
-- Multi-tenant user mapping for secure tenant resolution.
create table if not exists tenant_users (
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null,
  role text not null default 'member',
  created_at timestamptz default now(),
  primary key (tenant_id, user_id)
);

create index if not exists idx_tenant_users_user on tenant_users(user_id);
-- ═══════════════════════════════════════════════════════════════
-- MIGRATION: 20260624_lola_photo_campaigns_schema.sql
-- LOLA™ Photo Analysis + Email Campaigns Database Schema
-- ═══════════════════════════════════════════════════════════════

-- Campaign sends tracking table
CREATE TABLE IF NOT EXISTS campaign_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  campaign_type VARCHAR(50) NOT NULL,
  email_subject VARCHAR(255),
  email_from VARCHAR(255),
  email_html TEXT,
  provider VARCHAR(50),
  message_id VARCHAR(255),
  success BOOLEAN DEFAULT FALSE,
  opened_at TIMESTAMP,
  clicked_at TIMESTAMP,
  bounced BOOLEAN DEFAULT FALSE,
  unsubscribed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT fk_campaign_sends_client FOREIGN KEY (client_id) REFERENCES clients(id),
  CONSTRAINT fk_campaign_sends_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_sends_client ON campaign_sends(client_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_campaign_sends_created ON campaign_sends(created_at);
CREATE INDEX IF NOT EXISTS idx_campaign_sends_type ON campaign_sends(campaign_type);

-- Follow-up queue for scheduled campaigns
CREATE TABLE IF NOT EXISTS follow_up_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  campaign_type VARCHAR(50) NOT NULL,
  context JSONB,
  scheduled_for TIMESTAMP NOT NULL,
  processed_at TIMESTAMP,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT fk_followup_client FOREIGN KEY (client_id) REFERENCES clients(id),
  CONSTRAINT fk_followup_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_followup_scheduled ON follow_up_queue(scheduled_for) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_followup_client ON follow_up_queue(client_id, tenant_id);

-- Photo analysis results
CREATE TABLE IF NOT EXISTS photo_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  analysis_data JSONB NOT NULL,
  photo_url VARCHAR(2000),
  image_hash VARCHAR(64),
  condition VARCHAR(50),
  risk_level VARCHAR(20),
  requires_consultation BOOLEAN,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT fk_photo_client FOREIGN KEY (client_id) REFERENCES clients(id),
  CONSTRAINT fk_photo_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_photo_client ON photo_analyses(client_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_photo_risk ON photo_analyses(risk_level);
CREATE INDEX IF NOT EXISTS idx_photo_created ON photo_analyses(created_at);
CREATE INDEX IF NOT EXISTS idx_photo_hash ON photo_analyses(image_hash) WHERE image_hash IS NOT NULL;

-- Email unsubscribe tracking
CREATE TABLE IF NOT EXISTS email_unsubscribes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  unsubscribe_token VARCHAR(255) UNIQUE,
  reason TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT fk_unsub_client FOREIGN KEY (client_id) REFERENCES clients(id),
  CONSTRAINT fk_unsub_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_unsub_token ON email_unsubscribes(unsubscribe_token);
CREATE INDEX IF NOT EXISTS idx_unsub_client ON email_unsubscribes(client_id, tenant_id);

-- Client mood history for sentiment tracking
CREATE TABLE IF NOT EXISTS client_mood_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  mood VARCHAR(50),
  context JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT fk_mood_client FOREIGN KEY (client_id) REFERENCES clients(id),
  CONSTRAINT fk_mood_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_mood_client ON client_mood_history(client_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_mood_created ON client_mood_history(created_at);

-- Error logging for troubleshooting
CREATE TABLE IF NOT EXISTS error_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID,
  client_id UUID,
  error_type VARCHAR(100),
  error_message TEXT,
  stack_trace TEXT,
  context JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT fk_error_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_error_client FOREIGN KEY (client_id) REFERENCES clients(id)
);

CREATE INDEX IF NOT EXISTS idx_error_tenant ON error_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_error_created ON error_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_error_type ON error_logs(error_type);

-- Add columns to existing clients table if they don't exist
ALTER TABLE clients 
  ADD COLUMN IF NOT EXISTS vip_status BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS last_contact TIMESTAMP,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

-- RLS policies for campaign tables
ALTER TABLE campaign_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_up_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE photo_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_unsubscribes ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_mood_history ENABLE ROW LEVEL SECURITY;

-- Tenant isolation policies
DROP POLICY IF EXISTS campaign_sends_tenant_isolation ON campaign_sends;
CREATE POLICY campaign_sends_tenant_isolation
  ON campaign_sends FOR SELECT 
  USING (tenant_id = auth_tenant());  -- was auth.jwt()->'tenant_id'::UUID — a precedence bug that cast the literal string to UUID and errored at query time; auth_tenant() (schema.sql) is the standard helper

DROP POLICY IF EXISTS follow_up_queue_tenant_isolation ON follow_up_queue;
CREATE POLICY follow_up_queue_tenant_isolation
  ON follow_up_queue FOR SELECT 
  USING (tenant_id = auth_tenant());  -- was auth.jwt()->'tenant_id'::UUID — a precedence bug that cast the literal string to UUID and errored at query time; auth_tenant() (schema.sql) is the standard helper

DROP POLICY IF EXISTS photo_analyses_tenant_isolation ON photo_analyses;
CREATE POLICY photo_analyses_tenant_isolation
  ON photo_analyses FOR SELECT 
  USING (tenant_id = auth_tenant());  -- was auth.jwt()->'tenant_id'::UUID — a precedence bug that cast the literal string to UUID and errored at query time; auth_tenant() (schema.sql) is the standard helper

-- Triggers for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_campaign_sends_updated_at ON campaign_sends;
CREATE TRIGGER update_campaign_sends_updated_at
  BEFORE UPDATE ON campaign_sends
  FOR EACH ROW 
  EXECUTE FUNCTION update_updated_at_column();

-- Grant permissions
GRANT SELECT, INSERT, UPDATE ON campaign_sends TO authenticated;
GRANT SELECT, INSERT, UPDATE ON follow_up_queue TO authenticated;
GRANT SELECT, INSERT ON photo_analyses TO authenticated;
GRANT SELECT, INSERT ON email_unsubscribes TO authenticated;
GRANT SELECT, INSERT ON client_mood_history TO authenticated;
GRANT SELECT, INSERT ON error_logs TO authenticated;
create table if not exists tenant_number_ports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  requested_phone_number text not null,
  status text not null default 'draft',
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

drop trigger if exists trg_tenant_number_ports_updated on tenant_number_ports;
create trigger trg_tenant_number_ports_updated
before update on tenant_number_ports
for each row execute function set_updated_at();
-- ════════════════════════════════════════════════════════════════
-- Operator ("Jarvis") additions — owner-facing voice control
-- ════════════════════════════════════════════════════════════════
-- The owner-facing assistant can do privileged, destructive things
-- (move/cancel appointments, text every client). We gate those on a
-- spoken PIN. Caller ID is stored as a soft signal only (it's spoofable),
-- so the PIN — stored hashed — is the real authorization for changes.
--
-- Safe to re-run (idempotent).

alter table tenants add column if not exists operator_phone   text;  -- owner's caller ID (soft signal)
alter table tenants add column if not exists operator_pin_hash text;  -- sha256 of the spoken PIN

comment on column tenants.operator_phone   is 'Owner caller ID for the private operator line. Soft signal only — not sufficient for destructive actions.';
comment on column tenants.operator_pin_hash is 'sha256 of the spoken operator PIN. Required to confirm move/cancel/broadcast actions.';
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
