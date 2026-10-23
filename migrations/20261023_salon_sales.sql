-- square-sales.sql — the salon's sales (Square) for LolaBrain's business analysis.
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
