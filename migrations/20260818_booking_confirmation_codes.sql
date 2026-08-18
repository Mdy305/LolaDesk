-- ============================================================================
-- Client self-cancel: confirmation codes on bookings (idempotent).
--
-- Every booking gets a short human-friendly confirmation_code so clients can
-- cancel their own appointment online (code + phone) without an account.
-- The code is also included in the confirmation SMS.
-- ============================================================================

alter table bookings add column if not exists confirmation_code text;

-- Codes are unique where present (nullable so non-cancellable rows can be null).
create unique index if not exists idx_bookings_confirmation_code
  on bookings (confirmation_code) where confirmation_code is not null;

-- Backfill existing confirmed/future bookings that predate this migration so
-- their clients can self-cancel too. Deterministic enough, idempotent: only
-- rows with a null code are touched, and each gets a random 6-char code.
update bookings
   set confirmation_code = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6))
 where confirmation_code is null
   and status in ('confirmed', 'pending');
