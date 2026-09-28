-- Lola Marketing — text campaigns with per-client delivery and results.
-- Safe to run more than once.
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

-- Server-only tables: the API uses the service key; browsers never read them directly.
alter table lola_campaigns enable row level security;
alter table lola_campaign_recipients enable row level security;
