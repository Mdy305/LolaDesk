-- LolaDesk — everything the launch needs, in one script.
-- Covers: Lola Marketing, Call Center, Launch Pack, Revenue Engine.
-- Safe to run more than once. Skips anything your database doesn't have
-- instead of failing. Supabase → SQL Editor → New query → paste → Run.

-- ── 1. Lola Marketing: text campaigns ───────────────────────────
create table if not exists lola_campaigns (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  name         text not null,
  segment      text not null,
  segment_days int,
  message      text not null,
  status       text not null default 'draft' check (status in ('draft','sending','paused','sent','cancelled')),
  created_by   text,
  total        int not null default 0,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz
);
create index if not exists lola_campaigns_tenant_idx on lola_campaigns (tenant_id, created_at desc);
create index if not exists lola_campaigns_status_idx on lola_campaigns (status);

create table if not exists lola_campaign_recipients (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references lola_campaigns(id) on delete cascade,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  client_id   uuid references clients(id) on delete set null,
  phone       text not null,
  first_name  text,
  status      text not null default 'pending' check (status in ('pending','sent','failed','skipped')),
  error       text,
  sent_at     timestamptz,
  unique (campaign_id, phone)
);
create index if not exists lola_campaign_recipients_campaign_idx on lola_campaign_recipients (campaign_id, status);
create index if not exists lola_campaign_recipients_tenant_idx on lola_campaign_recipients (tenant_id, status, sent_at);

-- ── 2. Billing: Stripe webhook log + subscription state ─────────
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

alter table tenants add column if not exists subscription_status    text default 'trial';
alter table tenants add column if not exists stripe_customer_id     text;
alter table tenants add column if not exists stripe_subscription_id text;
alter table tenants add column if not exists current_period_end     timestamptz;
alter table tenants add column if not exists operator_phone         text;

-- ── 3. Revenue engine: per-appointment fees + Lola's 30-day plan ─
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

-- ── 4. Only where your tables have them (never fails) ───────────
do $$
begin
  -- Deposits: Stripe marks a deposit paid by matching this column
  if to_regclass('public.deposits') is not null then
    alter table public.deposits add column if not exists stripe_payment_intent_id text;
    create index if not exists idx_deposits_intent on public.deposits (stripe_payment_intent_id);
  end if;

  -- Call Center: handled flag + recording link
  if to_regclass('public.calls') is not null then
    alter table public.calls add column if not exists handled_at          timestamptz;
    alter table public.calls add column if not exists recording_audio_url text;
    create index if not exists idx_calls_tenant_created on public.calls (tenant_id, created_at desc);
  end if;

  -- Fast availability (salon + stylist + time)
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='bookings' and column_name='staff_id') then
    create index if not exists idx_bookings_tenant_staff_start on public.bookings (tenant_id, staff_id, start_time);
  end if;

  -- Fast "who is due back" audiences
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='bookings' and column_name='client_id') then
    create index if not exists idx_bookings_tenant_client_start on public.bookings (tenant_id, client_id, start_time);
  end if;

  -- Voice + SMS routing: the number that was called finds its salon
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='tenants' and column_name='phone_number') then
    create index if not exists idx_tenants_phone_number on public.tenants (phone_number);
  end if;
end $$;

-- ── 5. Lock the new tables to the server ────────────────────────
-- Without this, anyone holding your public Supabase key could read
-- billing and fee rows. LolaDesk's API uses the service key, which
-- is not affected.
alter table lola_campaigns           enable row level security;
alter table lola_campaign_recipients enable row level security;
alter table billing_events           enable row level security;
alter table booking_fees             enable row level security;
alter table lola_fill_plans          enable row level security;

-- ── 6. October fixes (same as sql/fixall-2026-10.sql) ─────────
-- (Booking integrity — atomic holds — is in sql/fixall-2026-10.sql and also applies itself when the app starts.)

-- ════ 20261006_money_fix.sql ════
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

-- ════ 20261006_client_notes.sql ════
-- ============================================================================
-- Client notes + color formulas (idempotent).
--
-- The client profile (client.html → /api/crm-notes) keeps a running history
-- per client: free-text notes ("prefers Saturday mornings", "allergic to PPD")
-- and color formulas ({date, formula, developer, processing, notes, stylist}).
-- One table, two kinds, always scoped to the salon (tenant_id).
--
-- Until this runs, /api/crm-notes degrades gracefully: notes and formulas are
-- appended to clients.notes as dated lines, so nothing an owner types is lost.
--
-- RLS: tenants read their own rows; writes are service-role only (the API
-- resolves the salon from the signed-in user, never from the request).
-- ============================================================================

-- The fallback store (and the "On file" card) — present on every install, made sure here.
alter table clients add column if not exists notes text;

create table if not exists client_notes (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  client_id   uuid not null references clients(id) on delete cascade,
  kind        text not null default 'note' check (kind in ('note', 'formula')),
  body        text,                              -- the note, or the formula itself
  data        jsonb not null default '{}'::jsonb, -- formula: {date, formula, developer, processing, notes, stylist}
  author      text,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_client_notes_client on client_notes (tenant_id, client_id, kind, created_at desc);

alter table client_notes enable row level security;
drop policy if exists client_notes_read on client_notes;
create policy client_notes_read on client_notes
  for select using (tenant_id = auth_tenant());

-- ════ 20261006_calls_one_row.sql ════
-- ============================================================================
-- One calls row per phone call (idempotent). lib/call-row.js finds-or-creates by
-- telnyx_call_control_id; this index makes a race between two webhooks for the
-- same call impossible. If old duplicate rows exist, the index is skipped (with a
-- notice) instead of failing the script — everything else still applies.
-- ============================================================================
alter table calls add column if not exists telnyx_call_control_id text;
do $$ begin
  begin
    execute 'create unique index if not exists calls_one_row_per_call on calls (telnyx_call_control_id) where telnyx_call_control_id is not null';
  exception when unique_violation then
    raise notice 'calls: older duplicate rows share a call id — one-row index skipped (new calls are still de-duplicated in code)';
  end;
end $$;


-- ── Check: every line below should say "ready" ──────────────────
select t as "table", case when to_regclass('public.' || t) is not null then 'ready' else 'MISSING' end as status
from unnest(array['lola_campaigns','lola_campaign_recipients','billing_events','booking_fees','lola_fill_plans']) as t;
