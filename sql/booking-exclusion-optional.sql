-- OPTIONAL — a hard database backstop against overlapping bookings.
-- ════════════════════════════════════════════════════════════════════════════
-- NOT applied automatically. lola_take_hold (migrations/20261006_booking_integrity.sql)
-- already serializes every Lola / widget / dashboard booking per stylist.
--
-- Only run this for a salon setup that never double-books a stylist on purpose:
-- it REJECTS (a) a short service placed inside another client's colour
-- processing time, and (b) owner "book it anyway" overlaps (force / walk-ins).
-- Those are features today, so this stays opt-in.
--
-- Fails safely: if overlapping rows already exist, the constraint is skipped
-- with a notice instead of erroring.

create extension if not exists btree_gist;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_no_staff_overlap') then
    begin
      alter table public.bookings
        add constraint bookings_no_staff_overlap
        exclude using gist (
          tenant_id with =,
          staff_id with =,
          tstzrange(start_time, coalesce(end_time, start_time + interval '60 minutes'), '[)') with &&
        ) where (staff_id is not null and lower(coalesce(status, '')) not in ('cancelled', 'canceled', 'no_show', 'no-show', 'noshow'));
    exception when others then
      raise notice 'bookings_no_staff_overlap skipped: % — resolve existing overlaps first', sqlerrm;
    end;
  end if;
end $$;
