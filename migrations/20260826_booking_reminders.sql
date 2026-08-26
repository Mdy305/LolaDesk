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
