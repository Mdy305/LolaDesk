-- ═══════════════════════════════════════════════════════════════════════════
-- LolaDesk — ALL MIGRATIONS (idempotent, ordered)
-- Generated from the 16 date-prefixed files in migrations/.
--
-- PREREQUISITES (already applied on production — do NOT re-run schema.sql;
-- its demo-tenant seed insert is not guarded):
--   * base tables: tenants, clients, bookings, conversations, messages, calls, ...
--   * helpers:     set_updated_at(), auth_tenant(), is_tenant_member(),
--                  update_updated_at_column()
--   * extensions:  pgcrypto, vector
--
-- SAFE TO RE-RUN: every statement is IF NOT EXISTS / ON CONFLICT guarded.
-- Paste the whole file into Supabase → SQL Editor → New query → Run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260623_orchestrator_audit.sql
-- ═══════════════════════════════════════════════════════════════════════════

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

-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260623_tenant_users.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- Multi-tenant user mapping for secure tenant resolution.
create table if not exists tenant_users (
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null,
  role text not null default 'member',
  created_at timestamptz default now(),
  primary key (tenant_id, user_id)
);

create index if not exists idx_tenant_users_user on tenant_users(user_id);

-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260624_lola_photo_campaigns_schema.sql
-- ═══════════════════════════════════════════════════════════════════════════

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

-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260624_tenant_number_ports.sql
-- ═══════════════════════════════════════════════════════════════════════════

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

-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260626_operator.sql
-- ═══════════════════════════════════════════════════════════════════════════

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

-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260701_complete_supabase_wiring.sql
-- ═══════════════════════════════════════════════════════════════════════════

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

-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260705_admin_control_panel.sql
-- ═══════════════════════════════════════════════════════════════════════════

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


-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260705_tenant_knowledge_documents.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- Per-tenant knowledge documents (menus, policies, FAQs, reviews) that Lola
-- uses on calls and texts. Contact lists are NOT stored here — they import
-- straight into the clients table. Run in the Supabase SQL editor.

create table if not exists tenant_documents (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  kind        text not null default 'document',   -- 'document' | 'reviews'
  filename    text,
  char_count  int  default 0,
  summary     text,                                -- distilled facts Lola should know
  raw_text    text,                                -- extracted text (capped server-side)
  created_at  timestamptz default now()
);

create index if not exists tenant_documents_tenant_idx
  on tenant_documents (tenant_id, created_at desc);

-- The server reads/writes with the Supabase service key (bypasses RLS). Enabling
-- RLS with no public policies means these rows are reachable ONLY through the
-- authenticated /api/knowledge endpoint — never directly from the browser.
alter table tenant_documents enable row level security;


-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260724_onboarding_state.sql
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.tenant_onboarding (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  stage text not null default 'business',
  status text not null default 'in_progress',
  progress integer not null default 10 check (progress between 0 and 100),
  business jsonb not null default '{}'::jsonb,
  channels jsonb not null default '{}'::jsonb,
  booking jsonb not null default '{}'::jsonb,
  persona jsonb not null default '{}'::jsonb,
  provisioning jsonb not null default '{}'::jsonb,
  last_error text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tenant_onboarding_status_idx on public.tenant_onboarding(status);

alter table public.tenant_onboarding enable row level security;

drop policy if exists tenant_onboarding_select on public.tenant_onboarding;
create policy tenant_onboarding_select on public.tenant_onboarding
for select using (
  exists (
    select 1 from public.tenant_users tu
    where tu.tenant_id = tenant_onboarding.tenant_id
      and tu.user_id = auth.uid()
  )
);

drop policy if exists tenant_onboarding_update on public.tenant_onboarding;
create policy tenant_onboarding_update on public.tenant_onboarding
for all using (
  exists (
    select 1 from public.tenant_users tu
    where tu.tenant_id = tenant_onboarding.tenant_id
      and tu.user_id = auth.uid()
  )
) with check (
  exists (
    select 1 from public.tenant_users tu
    where tu.tenant_id = tenant_onboarding.tenant_id
      and tu.user_id = auth.uid()
  )
);

-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260726_launch_contract_security.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- Harden public helper functions flagged by the Supabase security advisor.
-- Service-role-only tables intentionally keep RLS enabled with no browser policies.

-- Keep extension objects out of the API-exposed public schema before referencing
-- the vector type in function signatures below.
create schema if not exists extensions;
alter extension vector set schema extensions;

alter function public.set_updated_at() set search_path = '';
alter function public.update_updated_at_column() set search_path = '';
alter function public.auth_tenant() set search_path = '';
alter function public.current_tenant_id() set search_path = '';
alter function public.handle_new_tenant() set search_path = '';
alter function public.match_client_memories(extensions.vector, uuid, uuid, double precision, integer)
  set search_path = 'public, extensions';

revoke execute on function public.set_updated_at() from public, anon, authenticated;
revoke execute on function public.update_updated_at_column() from public, anon, authenticated;
revoke execute on function public.auth_tenant() from public, anon;
grant execute on function public.auth_tenant() to authenticated;
revoke execute on function public.handle_new_tenant() from public, anon, authenticated;
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
revoke execute on function public.match_client_memories(extensions.vector, uuid, uuid, double precision, integer)
  from public, anon, authenticated;

-- Public buckets serve object URLs without a broad object-listing policy.
drop policy if exists voice_audio_public_read on storage.objects;

-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260727_client_photo_storage.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- Private client profile photos. Files are written and signed only by
-- authenticated, tenant-scoped server endpoints using the service client.
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('client-photos','client-photos',false,2097152,array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set
  public=excluded.public,
  file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260810_booking_external_sync.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- External booking-platform sync tracking.
-- Lets LolaDesk record which connected platform (Square/Boulevard/Vagaro/
-- Mindbody/Fresha) a booking was also pushed to, and that platform's own
-- appointment ID, so a future reschedule/cancel can be synced out too.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS external_id text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS source text;

CREATE INDEX IF NOT EXISTS idx_bookings_external_id ON bookings(external_id) WHERE external_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260811_tenant_sims_isolation.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- Fixes a real cross-tenant data leak: api/telnyx-sims.js previously
-- returned Telnyx's entire, unfiltered sim_cards list to any
-- authenticated user, with no per-tenant tracking of SIM orders at all.
-- This table records which tenant each SIM order belongs to, the same
-- pattern already used for `integrations`.

CREATE TABLE IF NOT EXISTS tenant_sims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  telnyx_order_id text,
  telnyx_sim_id text,
  address_id text,
  quantity int DEFAULT 1,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenant_sims_tenant ON tenant_sims(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_sims_sim_id ON tenant_sims(telnyx_sim_id) WHERE telnyx_sim_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260812_calendar_core.sql
-- ═══════════════════════════════════════════════════════════════════════════

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

-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260815_tenant_number_routing.sql
-- ═══════════════════════════════════════════════════════════════════════════

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

-- On Supabase, only the service_role key may call it (anon/authenticated lost
-- it via the public revoke above). On a plain Postgres (local dev / e2e) that
-- role doesn't exist, so skip the grant quietly instead of failing the script.
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

-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260815_tenant_voice.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- 20260815_tenant_voice.sql
-- Per-tenant Lola voice. Each salon can pick its own ElevenLabs voice;
-- NULL means "use the platform default" (ELEVENLABS_VOICE_ID), so existing
-- tenants keep their current voice until the owner chooses one.
-- Idempotent: safe to re-run.

alter table tenants add column if not exists voice_id text;

comment on column tenants.voice_id is
  'Per-tenant ElevenLabs voice id. NULL = platform default ELEVENLABS_VOICE_ID.';
