-- Multi-tenant user mapping for secure tenant resolution.
create table if not exists tenant_users (
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null,
  role text not null default 'member',
  created_at timestamptz default now(),
  primary key (tenant_id, user_id)
);

create index if not exists idx_tenant_users_user on tenant_users(user_id);
