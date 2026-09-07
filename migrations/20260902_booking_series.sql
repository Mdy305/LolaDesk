-- 20260902_booking_series.sql — real recurring-series identity for bookings
-- ===========================================================================
-- The first recurrence pass (PR #45) cloned occurrences and tagged them in
-- bookings.notes — a loop, not a series. Real series management ("cancel this
-- / this and following / all", "move the whole series") needs identity:
--
--   series_id    uuid  — shared by every occurrence of one series
--   series_pos   int   — 1-based position inside the series
--   series_total int   — planned occurrence count
--   series_rule  text  — 'weekly' | 'biweekly' | 'monthly'
--
-- Every occurrence stays an ordinary bookings row (per-instance edit/cancel
-- stays natural); these columns are what let the dashboard and the API act
-- on the SERIES as well as the instance. Idempotent — safe on fresh and
-- established databases alike; no RLS changes (bookings policies already
-- tenant-scope every access).
-- ===========================================================================

alter table public.bookings add column if not exists series_id uuid;
alter table public.bookings add column if not exists series_pos int;
alter table public.bookings add column if not exists series_total int;
alter table public.bookings add column if not exists series_rule text;

create index if not exists idx_bookings_series_id
  on public.bookings(series_id) where series_id is not null;
