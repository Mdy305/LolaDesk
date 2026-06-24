create table if not exists tenant_number_ports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  requested_phone_number text not null,
  status text not null default 'draft',
  current_carrier text,
  account_number text,
  account_pin text,
  billing_name text,
  billing_address text,
  authorized_contact_name text,
  authorized_contact_email text,
  telnyx_order_id text,
  foc_date timestamptz,
  temporary_phone_number text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_tenant_number_ports_tenant on tenant_number_ports(tenant_id, created_at desc);
create index if not exists idx_tenant_number_ports_order on tenant_number_ports(telnyx_order_id);

drop trigger if exists trg_tenant_number_ports_updated on tenant_number_ports;
create trigger trg_tenant_number_ports_updated
before update on tenant_number_ports
for each row execute function set_updated_at();
