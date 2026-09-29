-- LolaDesk revenue engine — safe to run more than once.
-- Supabase → SQL Editor → New query → paste → Run. (Not in the terminal.)

-- 1. LolaDesk earns on every appointment Lola books (lib/booking-fees.js)
create table if not exists booking_fees (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references tenants(id) on delete cascade,
  booking_id             uuid not null unique,
  source                 text,
  service_amount         numeric default 0,
  fee_cents              integer not null default 0,
  status                 text not null default 'pending',   -- pending · earned · billed · void · waived
  reason                 text,
  period                 text,                               -- YYYY-MM of the appointment
  appointment_at         timestamptz,
  earned_at              timestamptz,
  billed_at              timestamptz,
  voided_at              timestamptz,
  stripe_invoice_item_id text,
  created_at             timestamptz not null default now()
);
create index if not exists idx_booking_fees_tenant_period on booking_fees (tenant_id, period);
create index if not exists idx_booking_fees_status_time on booking_fees (status, appointment_at);

-- 2. Lola's 30-day plan to keep the chairs full (lib/fill-plan.js)
create table if not exists lola_fill_plans (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  status        text not null default 'proposed',            -- proposed · active · paused · replaced
  autopilot     boolean not null default false,
  reason        text,
  horizon_start date,
  horizon_end   date,
  forecast      jsonb default '{}'::jsonb,
  strategy      jsonb default '{}'::jsonb,
  items         jsonb default '[]'::jsonb,
  approved_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists idx_fill_plans_tenant on lola_fill_plans (tenant_id, created_at desc);
create index if not exists idx_fill_plans_status on lola_fill_plans (status);

-- Faster audiences (who is due back)
create index if not exists idx_bookings_tenant_client_start on bookings (tenant_id, client_id, start_time);
