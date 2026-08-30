-- ============================================================================
-- Sync alerting — dedup ledger for /api/cron/sync-alerts (idempotent).
--
-- The alert cron runs on a schedule and must NOT email/Slack the operator
-- every tick while a tenant's sync stays broken. This table records the last
-- time an alert of a given type was sent for a tenant, so the cron only fires
-- again after a cooldown (or when a NEW condition appears).
--
-- A row is deleted when the tenant recovers, so a future flip alerts fresh.
-- ============================================================================

create table if not exists sync_alert_log (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  alert_type    text not null check (alert_type in ('error', 'stale')),
  last_sent_at  timestamptz not null default now(),
  sent_count    integer not null default 1,
  last_error    text,
  created_at    timestamptz not null default now(),
  unique (tenant_id, alert_type)
);

create index if not exists idx_sync_alert_log_tenant on sync_alert_log (tenant_id);

-- Service-role only; tenant-scoped reads for the panel (deny by default).
alter table sync_alert_log enable row level security;
drop policy if exists sync_alert_log_read on sync_alert_log;
create policy sync_alert_log_read on sync_alert_log
  for select using (tenant_id = auth_tenant());
