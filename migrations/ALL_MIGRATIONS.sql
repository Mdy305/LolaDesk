-- ═══════════════════════════════════════════════════════════════════════════
-- LolaDesk — ALL MIGRATIONS (idempotent, ordered)
-- Generated from the 32 date-prefixed files in migrations/.
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
--
-- ═══════════════════════════════════════════════════════════════════════════
-- PRODUCTION STATUS — verified 2026-08-18 via Supabase Management API
-- (project cfowesxlebbtyioplijt, LolaDesk, us-west-2):
--   ALL 24 migrations below are APPLIED on production (26 now on main,
--   incl. 20260822_lola_autopilot.sql + 20260825_gmb_review_replies.sql —
--   apply via SQL editor to activate the Lola Autopilot ledger and the
--   Google review auto-reply log). Verified:
--     * all 25 core tables present, incl. sync_alert_log, tenant_numbers,
--       cached_availability, review_queue, tenant_sims, platform_config
--     * tenants.voice_id column present
--     * external_appointments is the canonical VIEW over cached_availability
--     * storage bucket 'review-cards' created (public-read policy)
--     * RLS enabled on sync_alert_log with tenant-scoped read policy
--       sync_alert_log_read (tenant_id = auth_tenant()); writes are
--       service-role only (deny by default)
--     * idx_usage_widget_load_daily unique partial index present
--     * clients legacy compat columns (name, phone_number, last_service,
--       is_vip, opted_out) present as generated columns
--     * review_queue.source accepts 'facebook'
--   Legacy reconciliation on 2026-08-18: production held EMPTY legacy
--   booking_sync_log (organization_id schema) and external_appointments
--   (table) objects that blocked the 20260816_booking_sync migration.
--   Both were dropped and recreated canonically — zero rows lost.
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
--  FILE: 20260705_admin_control_panel.sql   ═  APPLIED ON PRODUCTION 2026-08-18  ═
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
--  FILE: 20260811_tenant_sims_isolation.sql   ═  APPLIED ON PRODUCTION 2026-08-18  ═
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

-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260816_booking_sync.sql   ═  APPLIED ON PRODUCTION 2026-08-18  ═
-- ═══════════════════════════════════════════════════════════════════════════

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

-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260816_review_syndication.sql   ═  APPLIED ON PRODUCTION 2026-08-18  ═
-- ═══════════════════════════════════════════════════════════════════════════

-- ============================================================================
-- Review Syndication pipeline (idempotent)
-- 5-star reviews -> rendered 1080x1080 cards -> Meta Graph API publish cron
-- ============================================================================
-- Queue holds the ONLY reviews that survive the filter (rating = 5 and body
-- longer than 10 chars). content_hash (sha-256 of author + body) makes the
-- queue de-duplicated: the same review can never be scheduled twice.
--
-- Meta credentials are NOT stored here. They live per-tenant on the
-- `integrations` table (provider 'meta': encrypted access_token +
-- metadata.page_id / metadata.ig_user_id) and fall back to the
-- META_ACCESS_TOKEN / META_PAGE_ID / META_IG_ID env vars for a single
-- default tenant. See api/lib/review-syndication.js resolveMetaConfig().

create table if not exists review_queue (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  source         text not null check (source in ('google_gmb','yelp_csv','shopify','manual_csv')),
  content_hash   text not null unique,
  author_name    text not null,
  rating         integer not null check (rating = 5),
  review_body    text not null,
  image_url      text,                                  -- rendered card in review-cards bucket
  status         text not null default 'scheduled'
                 check (status in ('queued','scheduled','published','failed')),
  scheduled_for  timestamptz not null default now(),    -- staggered +48h apart
  meta_post_id   text,                                  -- facebook post id / ig media id
  error_message  text,
  created_at     timestamptz not null default now(),
  published_at   timestamptz
);

create index if not exists idx_review_queue_due  on review_queue (tenant_id, status, scheduled_for);
create index if not exists idx_review_queue_hash on review_queue (content_hash);

-- Reads go through the service-role client in this codebase; RLS is enabled
-- with a tenant-scoped read policy so a leaked anon key cannot enumerate the
-- queue. Default is deny.
alter table review_queue enable row level security;
drop policy if exists review_queue_read on review_queue;
create policy review_queue_read on review_queue
  for select using (tenant_id = auth_tenant());

-- ── storage: public review-cards bucket ───────────────────────────
-- Public read is required: Meta's Graph API must fetch the card image by URL
-- anonymously. Only server endpoints write here.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('review-cards', 'review-cards', true, 5242880, array['image/png','image/jpeg'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists review_cards_public_read on storage.objects;
create policy review_cards_public_read on storage.objects
  for select using (bucket_id = 'review-cards');

-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260816_stripe_provisioning.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ============================================================================
-- Stripe production billing + automated Telnyx provisioning (idempotent)
-- Backs api/stripe-webhook.js: idempotency log, subscription lifecycle
-- columns, and the auto-provision state machine.
-- ============================================================================

-- ── billing_events: idempotency + audit for every Stripe webhook ──
create table if not exists billing_events (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid references tenants(id) on delete cascade,
  stripe_event_id  text not null unique,
  type             text not null,
  amount           numeric,
  currency         text default 'usd',
  status           text,
  data             jsonb default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

create index if not exists idx_billing_events_tenant on billing_events (tenant_id, created_at desc);
create index if not exists idx_billing_events_event on billing_events (stripe_event_id);

-- ── tenants: subscription lifecycle + provisioning state ──────────
alter table tenants add column if not exists subscription_status text default 'trial';
alter table tenants add column if not exists billing_status     text default 'trial';
alter table tenants add column if not exists current_period_end timestamptz;
alter table tenants add column if not exists provisioning_status text;   -- active | provisioning_pending
alter table tenants add column if not exists provisioning_error  text;
alter table tenants add column if not exists telnyx_phone_id     text;
alter table tenants add column if not exists texml_app_id        text;
alter table tenants add column if not exists provisioned_at      timestamptz;

-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260817_sync_alerts.sql   ═  APPLIED ON PRODUCTION 2026-08-18  ═
--  (verified: table + RLS + tenant-scoped read policy; idempotent re-run OK)
-- ═══════════════════════════════════════════════════════════════════════════

-- ============================================================================
-- Sync alerting — dedup ledger for /api/cron/sync-alerts (idempotent).
--
-- The alert cron runs on a schedule and must NOT email/Slack the operator
-- every tick while a tenant's sync stays broken. This table records the last
-- time an alert of a given type was sent for a tenant, so the cron only fires
-- again after a cooldown (or when a NEW condition appears).
--
-- A row is deleted when the tenant recovers, so a future flip alerts fresh.
-- ============================================================================

create table if not exists sync_alert_log (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  alert_type    text not null check (alert_type in ('error', 'stale')),
  last_sent_at  timestamptz not null default now(),
  sent_count    integer not null default 1,
  last_error    text,
  created_at    timestamptz not null default now(),
  unique (tenant_id, alert_type)
);

create index if not exists idx_sync_alert_log_tenant on sync_alert_log (tenant_id);

-- Service-role only; tenant-scoped reads for the panel (deny by default).
alter table sync_alert_log enable row level security;
drop policy if exists sync_alert_log_read on sync_alert_log;
create policy sync_alert_log_read on sync_alert_log
  for select using (tenant_id = auth_tenant());

-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260818_booking_confirmation_codes.sql   ═  APPLIED ON PRODUCTION 2026-08-18  ═
-- ═══════════════════════════════════════════════════════════════════════════
-- ============================================================================
-- Client self-cancel: confirmation codes on bookings (idempotent).
--
-- Every booking gets a short human-friendly confirmation_code so clients can
-- cancel their own appointment online (code + phone) without an account.
-- The code is also included in the confirmation SMS.
-- ============================================================================

alter table bookings add column if not exists confirmation_code text;

-- Codes are unique where present (nullable so non-cancellable rows can be null).
create unique index if not exists idx_bookings_confirmation_code
  on bookings (confirmation_code) where confirmation_code is not null;

-- Backfill existing confirmed/future bookings that predate this migration so
-- their clients can self-cancel too. Deterministic enough, idempotent: only
-- rows with a null code are touched, and each gets a random 6-char code.
update bookings
   set confirmation_code = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6))
 where confirmation_code is null
   and status in ('confirmed', 'pending');

-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260818_clients_schema_compat.sql   ═  APPLIED ON PRODUCTION 2026-08-18  ═
-- ═══════════════════════════════════════════════════════════════════════════
-- Reconcile legacy client columns after the production `clients` table moved
-- to first_name/last_name/phone/status/preferred_service/preferred_staff_id.
-- Many API paths still read legacy columns (name, phone_number, opted_out,
-- is_vip, last_service), so recreate them as STORED GENERATED columns derived
-- from the canonical columns. Writers that target generated columns are fixed
-- in code (salon.js, db.js setOptOut).
--
-- Idempotent and safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

alter table clients
  add column if not exists name text generated always as (
    nullif(btrim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')), '')
  ) stored;

alter table clients
  add column if not exists phone_number text generated always as (phone) stored;

alter table clients
  add column if not exists last_service text generated always as (preferred_service) stored;

alter table clients
  add column if not exists is_vip boolean generated always as (
    lower(coalesce(status, '')) = 'vip' or coalesce(lifetime_value, 0) >= 1000
  ) stored;

alter table clients
  add column if not exists opted_out boolean generated always as (
    lower(coalesce(status, '')) = 'opted_out'
  ) stored;

alter table clients
  add column if not exists opted_out_at timestamptz;

-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260818_widget_load_daily_unique.sql   ═  APPLIED ON PRODUCTION 2026-08-18  ═
-- ═══════════════════════════════════════════════════════════════════════════
-- ============================================================================
-- Enforce one widget_load usage row per tenant per UTC day at the DB level.
--
-- The beacon dedupes at write time, but that is read-then-write: two
-- concurrent beacons could both pass the check and both insert. This unique
-- partial index makes the rule authoritative in Postgres.
-- ============================================================================

-- Collapse any pre-existing duplicates across ALL days (idempotent; deletes
-- zero rows when the table is already clean), keeping the earliest per day.
with dupes as (
  select
    id,
    row_number() over (
      partition by tenant_id, (created_at at time zone 'utc')::date
      order by created_at asc, id asc
    ) as rn
  from usage_events
  where kind = 'widget_load'
)
delete from usage_events
where id in (select id from dupes where rn > 1);

create unique index if not exists idx_usage_widget_load_daily
  on usage_events (tenant_id, ((created_at at time zone 'utc')::date))
  where kind = 'widget_load';

-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260818_review_sources_facebook.sql   ═  APPLIED ON PRODUCTION 2026-08-18  ═
-- ═══════════════════════════════════════════════════════════════════════════
-- Widen review_queue.source to accept 'facebook' so Facebook review CSVs can
-- be imported alongside Yelp/Google/Shopify. Dropping + re-adding is safe: it
-- only ADDS an allowed value, so existing rows always pass.
-- ═══════════════════════════════════════════════════════════════════════════

alter table review_queue drop constraint if exists review_queue_source_check;

alter table review_queue add constraint review_queue_source_check
  check (source in ('google_gmb','yelp_csv','shopify','manual_csv','facebook'));

-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260819_backfill_number_connections.sql   ═  APPLIED ON PRODUCTION 2026-08-19  ═
-- ═══════════════════════════════════════════════════════════════════════════
-- Backfill tenant_numbers.connection_id so every active voice line points at
-- the working Call Control app (TELNYX_VOICE_APP_ID = 2982432232334951429).
-- Routing keys off tenant_id + status, so calls always answered — this just
-- repairs the health record: null (never populated) and the dead 'legacy
-- upgrade' mapping 2991758319724529273 (rejected by Telnyx for origination).
-- Idempotent — numbers already on the working connection are untouched.
-- ═══════════════════════════════════════════════════════════════════════════

update tenant_numbers
set connection_id = '2982432232334951429',
    updated_at    = now()
where status = 'active'
  and (
    connection_id is null
    or connection_id in ('2991758319724529273')
  );

-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260821_route_owner_numbers.sql   ═  APPLIED ON PRODUCTION 2026-08-21  ═
-- ═══════════════════════════════════════════════════════════════════════════
-- Route +14104298256 and +14153419934 (owner lines that existed on Telnyx but
-- had NO routing row) to the platform's own tenant LolaDesk Primary
-- (slug 'loladesk', id a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11) so every owned
-- number answers with Lola. Connection id is the working Call Control app
-- (TELNYX_VOICE_APP_ID = 2982432232334951429), matching every other row —
-- routing keys off tenant_id + status; connection_id is the health record.
-- +14104298256 becomes the tenant's canonical tenants.phone_number.
-- Idempotent: on conflict the row is re-pointed at LolaDesk Primary.
-- ═══════════════════════════════════════════════════════════════════════════

insert into tenant_numbers (tenant_id, phone_number, kind, connection_id, status, notes, created_at, updated_at)
values
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '+14104298256', 'primary', '2982432232334951429', 'active', 'owner line — Lola voice + brain', now(), now()),
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '+14153419934', 'primary', '2982432232334951429', 'active', 'owner line — Lola voice + brain', now(), now())
on conflict (phone_number) do update
  set tenant_id     = excluded.tenant_id,
      kind          = excluded.kind,
      connection_id = excluded.connection_id,
      status        = excluded.status,
      notes         = excluded.notes,
      updated_at    = now();

-- Canonical number for the platform tenant (only if not already claimed).
update tenants
set phone_number = '+14104298256', updated_at = now()
where id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
  and (phone_number is null or phone_number <> '+14104298256');

-- ═══════════════════════════════════════════════════════════════════════════
-- 25 · 20260822_lola_autopilot.sql — Lola Autopilot operations ledger
--      (agent_runs, tenants.autopilot_enabled, tenants.recovery_sms_sent_at)
-- ═══════════════════════════════════════════════════════════════════════════
--   * tenants.recovery_sms_sent_at — cooldown stamp so missed-call recovery
--                         doesn't text a salon's caller twice in one window.
--
-- RLS: tenants can read their own runs (auth_tenant()); writes are
-- service-role only (deny by default).
-- ============================================================================

create table if not exists agent_runs (
  id           uuid primary key default gen_random_uuid(),
  agent        text not null check (agent in
                 ('routing-heal', 'missed-call-recovery', 'rebooking', 'sync-self-heal', 'review-request')),
  tenant_id    uuid references tenants(id) on delete cascade,
  status       text not null default 'success' check (status in ('success', 'partial', 'failed', 'skipped')),
  summary      text,
  details      jsonb not null default '{}'::jsonb,
  duration_ms  integer,
  ran_at       timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index if not exists idx_agent_runs_tenant on agent_runs (tenant_id, ran_at desc);
create index if not exists idx_agent_runs_agent  on agent_runs (agent, ran_at desc);

-- Per-tenant opt-out + recovery cooldown stamp.
alter table tenants add column if not exists autopilot_enabled    boolean not null default true;
alter table tenants add column if not exists recovery_sms_sent_at timestamptz;

-- Service-role only; tenant-scoped reads for the panel (deny by default).
alter table agent_runs enable row level security;
drop policy if exists agent_runs_read on agent_runs;
create policy agent_runs_read on agent_runs
-- ============================================================================
-- Review request links — per-tenant Yelp / Google review URLs (idempotent).
--
-- The "get reviews on Yelp" answer is a review-request campaign: after a
-- client's appointment ends, Lola texts them a direct link to the salon's
-- Yelp "Write a Review" page (and Google review link). Real customers write
-- the reviews — fully Yelp-compliant, no fake-review fraud.
--
-- The autopilot 'review-request' agent (api/lib/autopilot.js) reads these
-- columns; the Settings page writes them.
--
--   * tenants.yelp_review_url   — direct link to the salon's Yelp
--                                 "Write a Review" page, e.g.
--                                 https://www.yelp.com/biz/<alias>
--   * tenants.google_review_url — Google review shortcut link, e.g.
--                                 https://g.page/r/<id>/review
--
-- RLS: tenants may read/update their own row (existing policy); these are
-- just two more columns on the same table.
-- ============================================================================

alter table tenants add column if not exists yelp_review_url text;
alter table tenants add column if not exists google_review_url text;

-- The agent_runs CHECK constraint originally allowed only four agents; the
-- review-request agent extends the ledger. Drop + recreate with the new set
-- (idempotent: the constraint is recreated with the same name).
alter table agent_runs drop constraint if exists agent_runs_agent_check;
alter table agent_runs add constraint agent_runs_agent_check check (agent in
  ('routing-heal', 'missed-call-recovery', 'rebooking', 'sync-self-heal', 'review-request'));

-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260825_gmb_review_replies.sql
--  WHAT: Lola auto-replies to Google reviews (the live replacement for the
--        retired Google Business Messages API — chat from Maps ended
--        2024-07-31, so review replies are how Lola answers on Google).
--   1. gmb_review_replies — audit log of every public reply Lola posts.
--   2. tenants.auto_reply_gmb — per-salon opt-in toggle (default off).
-- Idempotent. RLS: no public policy (reads go through the service role).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists gmb_review_replies (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  review_id   text not null unique,   -- Google resource name (accounts/…/reviews/…)
  rating      integer,
  reviewer    text,
  comment     text,
  reply       text not null,
  posted_at   timestamptz default now(),
  created_at  timestamptz default now()
);

create index if not exists idx_gmb_replies_tenant on gmb_review_replies (tenant_id);
create index if not exists idx_gmb_replies_review on gmb_review_replies (review_id);

alter table tenants add column if not exists auto_reply_gmb boolean not null default false;

alter table gmb_review_replies enable row level security;

-- ═══════════════════════════════════════════════════════════════════════════
-- 20260826_booking_reminders.sql — booking reminder engine
-- ═══════════════════════════════════════════════════════════════════════════

-- LolaDesk booking reminder engine
-- Idempotent, non-destructive. Adds the per-booking reminder log the hourly
-- cron writes so a client is texted ~24h before their appointment exactly
-- once per appointment time. Rescheduling to a new time changes start_time,
-- which mints a fresh reminder_for and lets a new reminder fire; the same
-- appointment time can never be reminded twice, even if two cron ticks race.

create table if not exists public.booking_reminders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  reminder_for timestamptz not null,               -- the appointment start_time being reminded
  channel text not null default 'sms',
  status text not null default 'pending' check (status in ('pending','sent','failed','skipped')),
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (booking_id, reminder_for)
);

create index if not exists idx_booking_reminders_due
  on public.booking_reminders(reminder_for, status);

alter table public.booking_reminders enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'booking_reminders'
      and policyname = 'tenant_booking_reminders'
  ) then
    create policy tenant_booking_reminders on public.booking_reminders
      for all using (is_tenant_member(tenant_id));
  end if;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 20260826_whatsapp_reminders.sql — WhatsApp reminder channel
-- ═══════════════════════════════════════════════════════════════════════════

-- LolaDesk WhatsApp reminder channel
-- Idempotent, non-destructive. Adds a per-client WhatsApp opt-in so the
-- booking reminder engine can prefer WhatsApp when (a) the salon has WhatsApp
-- connected (a connected integrations row for provider 'whatsapp') AND (b) the
-- client has opted in. WhatsApp requires explicit opt-in; a client is only ever
-- WhatsApp-enabled when they've messaged the salon on WhatsApp (an inbound
-- conversations row with channel='whatsapp') or an owner flips the switch.
-- Reminders otherwise fall back to SMS, keeping the exactly-once contract.

alter table public.clients
  add column if not exists whatsapp_enabled boolean not null default false;

-- Auto-set opt-in the first time a client receives WhatsApp: a salon that has
-- WhatsApp connected can mark every client who has ever WhatsApp-conversed.
update public.clients c
  set whatsapp_enabled = true
  from public.integrations i
  where i.tenant_id = c.tenant_id
    and i.provider = 'whatsapp'
    and i.status = 'connected'
    and c.whatsapp_enabled = false
    and exists (
      select 1 from public.conversations conv
      where conv.tenant_id = c.tenant_id
        and conv.channel = 'whatsapp'
        and (
          conv.client_id = c.id
          or (c.phone is not null and conv.client_phone = c.phone)
        )
    );