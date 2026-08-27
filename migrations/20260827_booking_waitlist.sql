-- LolaDesk booking waitlist
-- Makes Lola's "I'll add you to the priority waitlist" promise real:
-- voice callers, web widget visitors, and dashboard staff all land in the
-- same tenant-scoped table, and a cancelled slot surfaces matching entries
-- so the salon can recover the revenue instead of letting it walk.
-- Idempotent, non-destructive. Safe to re-run.

create table if not exists public.booking_waitlist (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  client_name text,
  client_phone text,
  service_id uuid references public.services(id) on delete set null,
  service_name text,
  staff_id uuid references public.staff(id) on delete set null,
  preferred_date text,                 -- 'YYYY-MM-DD' or null = any day
  preferred_time text,                 -- 'HH:MM' 24h or null = any time
  notes text,
  status text not null default 'active'
    check (status in ('active','offered','fulfilled','expired','removed')),
  source text not null default 'voice', -- voice | widget | dashboard | public_web
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_booking_waitlist_tenant_status
  on public.booking_waitlist(tenant_id, status, created_at desc);
create index if not exists idx_booking_waitlist_service
  on public.booking_waitlist(tenant_id, status, service_id)
  where status = 'active';

-- RLS: same tenant membership helper used throughout LolaDesk.
alter table public.booking_waitlist enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'booking_waitlist' and policyname = 'tenant_booking_waitlist') then
    create policy tenant_booking_waitlist on public.booking_waitlist
      for all using (is_tenant_member(tenant_id));
  end if;
end $$;
