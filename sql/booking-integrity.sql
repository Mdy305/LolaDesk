-- Same as migrations/20261006_booking_integrity.sql — paste into Supabase → SQL Editor → Run.
-- 20261006_booking_integrity.sql — no double bookings, ever.
-- ════════════════════════════════════════════════════════════════════════════
-- Idempotent; safe to run more than once. Also self-applied at runtime by
-- api/lib/booking-integrity.js (ensureBookingIntegritySchema → exec_sql), and
-- mirrored in sql/booking-integrity.sql for the Supabase SQL editor.
--
--   1. lola_take_hold(...)  — the ONE atomic "check then hold" step. Takes a
--      per-stylist advisory lock, re-checks bookings + active holds inside the
--      lock, then inserts the hold. Two callers can never hold the same chair.
--   2. bookings.hold_id unique — one hold can only ever become one booking.
--   3. bookings.cancelled_at — the real cancellation moment (deposit refunds).
--   4. availability_holds.requester — who asked (public IP key), so one device
--      can't hold a whole day.
--   5. public_rate_hits — a SHARED rate-limit ledger (every serverless instance
--      sees the same counts); also counts owner-line PIN failures.
--
-- lola_take_hold p_seen_booking_ids: the bookings the availability engine already
-- evaluated (it applies processing-overlap rules to those). Anything ELSE overlapping
-- the window — written after the engine looked — is a conflict.

alter table public.bookings add column if not exists cancelled_at timestamptz;
alter table public.availability_holds add column if not exists requester text;

do $$
begin
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'bookings_hold_id_unique') then
    begin
      create unique index bookings_hold_id_unique on public.bookings (hold_id) where hold_id is not null;
    exception when unique_violation then
      raise notice 'bookings_hold_id_unique skipped: existing duplicate hold_id rows — clean them up and re-run';
    end;
  end if;
end $$;

create index if not exists idx_availability_holds_requester
  on public.availability_holds (tenant_id, requester) where status = 'active';

create table if not exists public.public_rate_hits (
  id   bigserial primary key,
  key  text not null,
  at   timestamptz not null default now()
);
create index if not exists idx_public_rate_hits_key_at on public.public_rate_hits (key, at desc);
alter table public.public_rate_hits enable row level security;

create or replace function public.lola_take_hold(
  p_tenant_id          uuid,
  p_staff_id           uuid,
  p_starts_at          timestamptz,
  p_ends_at            timestamptz,
  p_window_start       timestamptz,
  p_window_end         timestamptz,
  p_expires_at         timestamptz,
  p_hold_token         text,
  p_client_id          uuid default null,
  p_service_id         uuid default null,
  p_channel            text default 'voice',
  p_conversation_id    uuid default null,
  p_exclude_booking_id uuid default null,
  p_seen_booking_ids   uuid[] default '{}',
  p_requester          text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hold public.availability_holds;
  v_clash uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || coalesce(p_staff_id::text, '*'), 0));

  select h.id into v_clash
    from public.availability_holds h
   where h.tenant_id = p_tenant_id
     and h.status = 'active'
     and h.expires_at > now()
     and h.staff_id is not distinct from p_staff_id
     and h.starts_at < p_window_end
     and h.ends_at > p_window_start
   limit 1;
  if v_clash is not null then
    return jsonb_build_object('ok', false, 'conflict', true, 'reason', 'hold', 'id', v_clash);
  end if;

  select b.id into v_clash
    from public.bookings b
   where b.tenant_id = p_tenant_id
     and b.staff_id is not distinct from p_staff_id
     and lower(coalesce(b.status, '')) not in ('cancelled', 'canceled', 'no_show', 'no-show', 'noshow')
     and (p_exclude_booking_id is null or b.id <> p_exclude_booking_id)
     and not (b.id = any (coalesce(p_seen_booking_ids, '{}')))
     and b.start_time < p_window_end
     and coalesce(b.end_time, b.start_time + interval '60 minutes') > p_window_start
   limit 1;
  if v_clash is not null then
    return jsonb_build_object('ok', false, 'conflict', true, 'reason', 'booking', 'id', v_clash);
  end if;

  insert into public.availability_holds
    (tenant_id, client_id, staff_id, service_id, starts_at, ends_at, channel, conversation_id, expires_at, status, hold_token, requester)
  values
    (p_tenant_id, p_client_id, p_staff_id, p_service_id, p_starts_at, p_ends_at, coalesce(p_channel, 'voice'), p_conversation_id, p_expires_at, 'active', p_hold_token, p_requester)
  returning * into v_hold;

  return jsonb_build_object('ok', true, 'hold', to_jsonb(v_hold));
end $$;

revoke all on function public.lola_take_hold(uuid, uuid, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, text, uuid, uuid, text, uuid, uuid, uuid[], text) from public, anon, authenticated;
grant execute on function public.lola_take_hold(uuid, uuid, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, text, uuid, uuid, text, uuid, uuid, uuid[], text) to service_role;

-- PostgREST picks up the new function / table right away.
notify pgrst, 'reload schema';
