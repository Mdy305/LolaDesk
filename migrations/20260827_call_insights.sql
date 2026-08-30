-- LolaDesk post-call insights (call.conversation_insights.generated)
-- Every LolaBrain conversation ends with Telnyx generating insights (summary,
-- outcome, transcript) delivered to the insight group's webhook. This migration
-- gives the Calls page real transcript + outcome columns and a session map so
-- the webhook can resolve which tenant a conversation belonged to.
--
-- Idempotent, non-destructive.

-- ── calls: insight landing columns ─────────────────────────────────────────
alter table public.calls add column if not exists summary       text;
alter table public.calls add column if not exists outcome       text;
alter table public.calls add column if not exists transcript    jsonb;
alter table public.calls add column if not exists call_session_id text;
alter table public.calls add column if not exists call_leg_id   text;
alter table public.calls add column if not exists insight_id    text;
alter table public.calls add column if not exists insight_at    timestamptz;

-- Exactly-once: one insight event id may only be applied to one call row.
create unique index if not exists calls_insight_id_unique
  on public.calls(insight_id) where insight_id is not null;

-- Webhooks correlate by session id when the control id isn't stored.
create index if not exists idx_calls_call_session
  on public.calls(call_session_id) where call_session_id is not null;

-- ── call_sessions: session → tenant map captured at conversation start ─────
-- The dynamic-variables webhook (/api/agent-variables) fires before Lola speaks
-- and knows the dialed number, so it records which tenant owns this call
-- session. The insights webhook arrives later with only call ids and resolves
-- the tenant through this table.
create table if not exists public.call_sessions (
  call_control_id text primary key,
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  from_number     text,
  to_number       text,
  created_at      timestamptz not null default now()
);

alter table public.call_sessions enable row level security;
create index if not exists idx_call_sessions_tenant on public.call_sessions(tenant_id);
