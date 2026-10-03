-- Telecom setup: per-salon number porting + business texting (10DLC) registration.
-- Idempotent; same DDL as api/lib/migrate.js ensureTelecomSchema() (self-heals at runtime).
-- PINs, carrier account numbers and EINs are stored only encrypted (*_enc).

create table if not exists public.tenant_number_ports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
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
alter table public.tenant_number_ports
  add column if not exists entity_name text,
  add column if not exists account_number_enc text,
  add column if not exists pin_enc text,
  add column if not exists billing_street text,
  add column if not exists billing_city text,
  add column if not exists billing_state text,
  add column if not exists billing_zip text,
  add column if not exists billing_phone_number text,
  add column if not exists loa_document_id text,
  add column if not exists invoice_document_id text,
  add column if not exists telnyx_order_ids jsonb default '[]'::jsonb,
  add column if not exists telnyx_status text,
  add column if not exists requirements_met boolean,
  add column if not exists exceptions jsonb default '[]'::jsonb,
  add column if not exists last_error text,
  add column if not exists submitted_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists synced_at timestamptz;
create index if not exists idx_tenant_number_ports_tenant on public.tenant_number_ports(tenant_id, created_at desc);
create index if not exists idx_tenant_number_ports_order on public.tenant_number_ports(telnyx_order_id);

create table if not exists public.tenant_compliance (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  stage text not null default 'collecting',
  entity_type text,
  legal_name text,
  ein_enc text,
  details jsonb default '{}'::jsonb,
  brand_id text,
  brand_status text,
  brand_identity_status text,
  otp_reference text,
  campaign_id text,
  campaign_status text,
  usecase text,
  numbers jsonb default '[]'::jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  synced_at timestamptz
);
create index if not exists idx_tenant_compliance_brand on public.tenant_compliance(brand_id);
create index if not exists idx_tenant_compliance_campaign on public.tenant_compliance(campaign_id);
alter table public.tenant_compliance enable row level security;
