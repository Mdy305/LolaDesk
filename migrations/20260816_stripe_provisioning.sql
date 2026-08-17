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
