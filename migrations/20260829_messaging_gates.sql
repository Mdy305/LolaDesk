-- 20260829_messaging_gates.sql — per-salon messaging toggles with real gates
-- ===========================================================================
-- The Settings > Messaging tab exposes "Missed call text-back" and
-- "Review requests", but neither had a write path: the fields were silently
-- dropped and the features always ran. Add the two columns (default ON so
-- existing behavior is unchanged) and gate telnyx-voice.js's text-back and
-- autopilot.js's review-request agent on them.
-- ===========================================================================

alter table public.tenants add column if not exists missed_call_textback boolean not null default true;
alter table public.tenants add column if not exists review_requests      boolean not null default true;