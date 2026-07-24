create table if not exists public.tenant_onboarding (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  stage text not null default 'business',
  status text not null default 'in_progress',
  progress integer not null default 10 check (progress between 0 and 100),
  business jsonb not null default '{}'::jsonb,
  channels jsonb not null default '{}'::jsonb,
  booking jsonb not null default '{}'::jsonb,
  persona jsonb not null default '{}'::jsonb,
  provisioning jsonb not null default '{}'::jsonb,
  last_error text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tenant_onboarding_status_idx on public.tenant_onboarding(status);

alter table public.tenant_onboarding enable row level security;

drop policy if exists tenant_onboarding_select on public.tenant_onboarding;
create policy tenant_onboarding_select on public.tenant_onboarding
for select using (
  exists (
    select 1 from public.tenant_users tu
    where tu.tenant_id = tenant_onboarding.tenant_id
      and tu.user_id = auth.uid()
  )
);

drop policy if exists tenant_onboarding_update on public.tenant_onboarding;
create policy tenant_onboarding_update on public.tenant_onboarding
for all using (
  exists (
    select 1 from public.tenant_users tu
    where tu.tenant_id = tenant_onboarding.tenant_id
      and tu.user_id = auth.uid()
  )
) with check (
  exists (
    select 1 from public.tenant_users tu
    where tu.tenant_id = tenant_onboarding.tenant_id
      and tu.user_id = auth.uid()
  )
);
