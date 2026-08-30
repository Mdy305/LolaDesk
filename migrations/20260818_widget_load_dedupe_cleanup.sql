-- ═══════════════════════════════════════════════════════════════════════════
-- 20260818_widget_load_dedupe_cleanup.sql — one-time data cleanup (NOT schema)
-- ═══════════════════════════════════════════════════════════════════════════
-- The pre-dedupe widget beacon wrote one usage_events row on EVERY widget
-- boot. The fix in commit 2b018a8 caps widget_load at one row per tenant per
-- UTC day going forward, but the rows already written today remain.
--
-- This deletes the extras, keeping the EARLIEST widget_load row per tenant
-- for the current UTC day (the same rule the beacon's alreadyLoggedToday()
-- check enforces). Safe to re-run: once collapsed, the second pass deletes
-- zero rows.
--
-- Scope: kind = 'widget_load' only, current UTC day only. embed_copied and
-- embed_preview are intentionally untouched (every copy/preview is a real
-- action), and past days are preserved as-is.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Preview: how many duplicates exist right now (report only — zero rows
--    deleted). Run this alone if you want a dry-run before the delete.
select
  tenant_id,
  count(*)              as total_rows,
  count(*) - 1          as duplicate_rows_to_delete
from usage_events
where kind = 'widget_load'
  and created_at >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc')
  and created_at <  (date_trunc('day', now() at time zone 'utc') at time zone 'utc') + interval '1 day'
group by tenant_id
having count(*) > 1
order by duplicate_rows_to_delete desc;

-- 2. Delete the extras. Keeps the earliest row per tenant (tie-break: lowest
--    uuid), removes the rest. RETURNING lists each removed row so the exact
--    rows are auditable in the execution output.
with dupes as (
  select
    id,
    row_number() over (
      partition by tenant_id
      order by created_at asc, id asc
    ) as rn
  from usage_events
  where kind = 'widget_load'
    and created_at >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc')
    and created_at <  (date_trunc('day', now() at time zone 'utc') at time zone 'utc') + interval '1 day'
)
delete from usage_events
where id in (select id from dupes where rn > 1)
returning id, tenant_id, created_at, metadata->>'origin' as origin, metadata->>'host' as host;

-- 3. Verify: every tenant has at most one widget_load row for today.
select
  tenant_id,
  count(*) as widget_load_rows_today
from usage_events
where kind = 'widget_load'
  and created_at >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc')
  and created_at <  (date_trunc('day', now() at time zone 'utc') at time zone 'utc') + interval '1 day'
group by tenant_id
having count(*) > 1;
-- Expected result: zero rows returned (no tenant exceeds one row/day).
