-- ============================================================================
-- Money fix (idempotent): billing lifecycle columns, one-trial-per-salon brake,
-- and indexes for the fee / cost ledgers. Every column is optional for the code:
-- api/stripe-webhook.js retries without the new tenant columns if they're missing,
-- and lib/service-gate.js falls back to current_period_end when past_due_since is absent.
-- ============================================================================

-- ── tenants: subscription lifecycle ─────────────────────────────────────────
alter table tenants add column if not exists past_due_since     timestamptz;  -- first failed payment (7-day grace)
alter table tenants add column if not exists billing_interval   text;         -- monthly | annual
alter table tenants add column if not exists canceled_at        timestamptz;
alter table tenants add column if not exists trial_denied_reason text;        -- salon_phone | owner_phone | google_place | website | ip_trial_limit
alter table tenants add column if not exists stripe_subscription_id text;
alter table tenants add column if not exists current_period_end timestamptz;

-- ── signup_attempts: persisted per-IP sign-up / trial brake (lib/trial-guard.js) ──
create table if not exists signup_attempts (
  id          uuid primary key default gen_random_uuid(),
  ip          text not null,
  email       text,
  tenant_id   uuid references tenants(id) on delete set null,
  trial       boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists idx_signup_attempts_ip on signup_attempts (ip, created_at desc);
alter table signup_attempts enable row level security;   -- service role only

-- ── ledgers ────────────────────────────────────────────────────────────────
create index if not exists idx_usage_events_kind_time on usage_events (kind, created_at desc);
do $$ begin
  if exists (select 1 from information_schema.tables where table_name = 'booking_fees') then
    execute 'create index if not exists idx_booking_fees_status_id on booking_fees (status, id)';
  end if;
end $$;

-- deposits.status now also takes: disputed (charge.dispute.created), expired / flagged / void / kept
-- (already used by lib/deposits.js) — the column has no check constraint, nothing to change.
