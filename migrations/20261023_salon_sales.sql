-- square-sales.sql — the salon's sales and bank deposits (Square) for LolaBrain.
-- Safe to run more than once. LolaDesk also creates these itself when exec_sql is installed.

create table if not exists public.salon_sales (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  provider       text not null default 'square',
  external_id    text not null,
  occurred_at    timestamptz not null,
  day            date not null,
  hour           smallint,
  dow            smallint,
  net_cents      bigint not null default 0,
  tip_cents      bigint not null default 0,
  refunded_cents bigint not null default 0,
  customer_ref   text,
  client_id      uuid references public.clients(id) on delete set null,
  order_ref      text,
  team_ref       text,
  staff_id       uuid,
  location_ref   text,
  synced_at      timestamptz not null default now(),
  unique (tenant_id, provider, external_id)
);
create index if not exists idx_salon_sales_day on public.salon_sales (tenant_id, day desc);
create index if not exists idx_salon_sales_client on public.salon_sales (tenant_id, client_id);
create index if not exists idx_salon_sales_customer on public.salon_sales (tenant_id, customer_ref);
alter table public.salon_sales enable row level security;

create table if not exists public.salon_sale_items (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  provider     text not null default 'square',
  order_ref    text not null,
  line_no      int not null default 0,
  day          date not null,
  customer_ref text,
  client_id    uuid references public.clients(id) on delete set null,
  name         text not null,
  quantity     numeric not null default 1,
  total_cents  bigint not null default 0,
  catalog_ref  text,
  synced_at    timestamptz not null default now(),
  unique (tenant_id, provider, order_ref, line_no)
);
create index if not exists idx_salon_sale_items_day on public.salon_sale_items (tenant_id, day desc);
create index if not exists idx_salon_sale_items_name on public.salon_sale_items (tenant_id, name);
alter table public.salon_sale_items enable row level security;

alter table public.salon_sales add column if not exists source text;
alter table public.salon_sales add column if not exists fee_cents bigint not null default 0;
alter table public.salon_sales add column if not exists refunded_cents bigint not null default 0;

create table if not exists public.salon_payouts (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  provider         text not null default 'square',
  external_id      text not null,
  status           text,
  amount_cents     bigint not null default 0,
  fee_cents        bigint not null default 0,
  currency         text,
  arrival_date     date,
  created_ext      timestamptz,
  destination_type text,
  destination_ref  text,
  payout_type      text,
  entries          int,
  entries_loaded   boolean not null default false,
  entries_net_cents bigint,
  location_ref     text,
  synced_at        timestamptz not null default now(),
  unique (tenant_id, provider, external_id)
);
create index if not exists idx_salon_payouts_arrival on public.salon_payouts (tenant_id, arrival_date desc);
alter table public.salon_payouts enable row level security;

create table if not exists public.salon_payout_entries (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  provider      text not null default 'square',
  payout_ref    text not null,
  external_id   text not null,
  entry_type    text,
  effective_at  timestamptz,
  gross_cents   bigint not null default 0,
  fee_cents     bigint not null default 0,
  net_cents     bigint not null default 0,
  payment_ref   text,
  refund_ref    text,
  synced_at     timestamptz not null default now(),
  unique (tenant_id, provider, external_id)
);
create index if not exists idx_salon_payout_entries_payout on public.salon_payout_entries (tenant_id, payout_ref);
create index if not exists idx_salon_payout_entries_payment on public.salon_payout_entries (tenant_id, payment_ref);
alter table public.salon_payout_entries enable row level security;
