-- ============================================================================
-- Lola Autopilot — autonomous operations ledger (idempotent).
--
-- The agentic OS layer (api/lib/autopilot.js) runs four scheduled agents that
-- automate LolaDesk itself — routing-heal, missed-call-recovery, rebooking,
-- and sync-self-heal. Every agent run is recorded here so operators can see
-- what Lola did, when, and with what result, and so tenants can audit the
-- actions taken on their behalf.
--
--   * agent_runs        — one row per agent execution (per tenant when the
--                         agent acts on a specific salon, NULL tenant_id for
--                         platform-wide runs like routing-heal).
--   * tenants.autopilot_enabled — per-tenant opt-out; an owner can pause
--                         autonomous actions from Settings without touching
--                         the code.
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
  for select using (tenant_id = auth_tenant());
