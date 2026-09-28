-- LolaDesk launch pack — safe to run more than once (everything is IF NOT EXISTS).
-- Run in Supabase → SQL Editor → New query → paste → Run. Not in the terminal.

-- Stripe webhook: idempotency + audit log
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

-- Subscription lifecycle on the salon
alter table tenants add column if not exists subscription_status   text default 'trial';
alter table tenants add column if not exists stripe_customer_id    text;
alter table tenants add column if not exists stripe_subscription_id text;
alter table tenants add column if not exists current_period_end    timestamptz;
alter table tenants add column if not exists operator_phone        text;

-- Deposits are matched back from Stripe by the payment link id
create index if not exists idx_deposits_intent on deposits (stripe_payment_intent_id);

-- Fast availability: bookings by salon + stylist + time
create index if not exists idx_bookings_tenant_staff_start on bookings (tenant_id, staff_id, start_time);

-- Voice + SMS routing: the called number finds its salon
create index if not exists idx_tenants_phone_number on tenants (phone_number);
