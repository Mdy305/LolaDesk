-- ═══════════════════════════════════════════════════════════════════════════
-- 20260818_widget_load_daily_unique.sql — enforce daily-deduped widget_load
-- ═══════════════════════════════════════════════════════════════════════════
-- The beacon (api/widget-beacon.js, commit 2b018a8) already dedupes
-- widget_load at write time — one row per tenant per UTC day. But that is a
-- read-then-write check: two concurrent beacons can both see "not logged
-- today" and both insert. This index makes the rule authoritative at the
-- database level, so the second insert fails with a unique violation instead
-- of writing a duplicate row. The beacon's catch swallows that violation and
-- returns {ok:true}, so callers never see an error.
--
-- Semantics: one usage_events row per (tenant, UTC calendar day) where
-- kind = 'widget_load'. embed_copied and embed_preview are NOT affected —
-- every copy/preview remains a distinct row.
--
-- Idempotent and safe to re-run. The defensive collapse below guarantees the
-- index creation can never fail on a database that still has pre-dedupe
-- duplicates (production was verified clean on 2026-08-18).
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Collapse any pre-existing duplicates across ALL days (not just today),
--    keeping the earliest row per tenant per UTC day. Zero rows deleted when
--    the table is already clean.
with dupes as (
  select
    id,
    row_number() over (
      partition by tenant_id, (created_at at time zone 'utc')::date
      order by created_at asc, id asc
    ) as rn
  from usage_events
  where kind = 'widget_load'
)
delete from usage_events
where id in (select id from dupes where rn > 1);

-- 2. The guard: at most one widget_load row per tenant per UTC day.
--    The partial WHERE clause keeps the index tiny (only widget_load rows
--    are indexed) and leaves every other usage kind unrestricted.
create unique index if not exists idx_usage_widget_load_daily
  on usage_events (tenant_id, ((created_at at time zone 'utc')::date))
  where kind = 'widget_load';
