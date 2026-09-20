-- LolaDesk reminder second band — the 2h-before "radar" heads-up.
-- Idempotent, non-destructive (widening a unique key can never violate
-- existing data). booking_reminders' unique (booking_id, reminder_for)
-- constraint is the engine's exactly-once spine; the 2h band needs its own
-- claim lane, so the key widens to (booking_id, reminder_for, band). The
-- band column defaults to '24h' so every pre-existing row keeps its meaning.

alter table public.booking_reminders
  add column if not exists band text not null default '24h';

-- Widen the exactly-once key: one claim per (booking, time, band). The old
-- constraint must be dropped by name; guard it so the statement is safe to
-- re-run and on databases where the constraint name differs.
do $$ begin
  alter table public.booking_reminders
    drop constraint if exists booking_reminders_booking_id_reminder_for_key;
exception when others then null;
end $$;

alter table public.booking_reminders
  add constraint booking_reminders_no_double_text
  unique (booking_id, reminder_for, band);

create index if not exists idx_booking_reminders_due
  on public.booking_reminders(reminder_for, status);
