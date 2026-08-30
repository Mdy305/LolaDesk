-- 20260901_inventory_ops.sql — products + blocked slots + appointment notes
-- ===========================================================================
-- The OpenSalon-ported salon.js has full CRUD for products (with stock /
-- low_stock_alert / sku / brand / cost), blocked_slots (breaks, lunch, days
-- off per staff), and appointment_notes (activity notes on bookings) — but
-- none of the three tables existed anywhere in the canonical schema, so
-- every one of those endpoints failed against production and the products
-- read hardcoded low_stock: []. Land the missing tables (idempotent, RLS on,
-- tenant-scoped like every other LolaDesk table).
-- ===========================================================================

create table if not exists public.products (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  name            text not null,
  brand           text not null default '',
  category        text not null default '',
  sku             text not null default '',
  price           numeric not null default 0,
  cost            numeric not null default 0,
  stock           integer not null default 0,
  low_stock_alert integer not null default 5,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_products_tenant on public.products(tenant_id, is_active);

create table if not exists public.blocked_slots (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  staff_id     uuid references public.staff(id) on delete cascade,
  blocked_date date not null,
  start_time   time,
  end_time     time,
  reason       text not null default '',
  created_at   timestamptz not null default now(),
  check (end_time is null or start_time is null or end_time > start_time)
);
create index if not exists idx_blocked_slots_tenant_date on public.blocked_slots(tenant_id, blocked_date);

create table if not exists public.appointment_notes (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  booking_id uuid references public.bookings(id) on delete cascade,
  content    text not null,
  author     text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_appointment_notes_booking on public.appointment_notes(booking_id, created_at);

-- RLS: same tenant-membership helpers used throughout LolaDesk.
alter table public.products         enable row level security;
alter table public.blocked_slots    enable row level security;
alter table public.appointment_notes enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='products' and policyname='tenant_products') then
    create policy tenant_products on public.products for all using (is_tenant_member(tenant_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='blocked_slots' and policyname='tenant_blocked_slots') then
    create policy tenant_blocked_slots on public.blocked_slots for all using (is_tenant_member(tenant_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='appointment_notes' and policyname='tenant_appointment_notes') then
    create policy tenant_appointment_notes on public.appointment_notes for all using (is_tenant_member(tenant_id));
  end if;
end $$;
