-- ════════════════════════════════════════════════════════════════════════════════════════════
-- LolaDesk · sync-atomic-2026-10 — safe to run more than once (Supabase → SQL Editor → Run).
--   1) lola_apply_onboarding(): the onboarding scan writes services, prices, the team, staff hours,
--      opening hours, the Google Places payload and the salon record in ONE transaction —
--      all of it lands, or none of it does (never a half-synced salon).
--   2) booking_settings.business_hours / closures as real columns (the phone line reads them).
--   3) The calendar outbox: one job per external calendar (each iCal link, each booking-system API),
--      claimed with SKIP LOCKED, retried with back-off, failures isolated per job.
--   4) calendar_conflicts: an outside appointment on top of a LolaDesk booking is recorded and stays
--      blocked until the owner resolves it.
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- 2) Opening hours as columns (copied from the metadata fallback where that's all there is).
alter table public.booking_settings add column if not exists business_hours jsonb;
alter table public.booking_settings add column if not exists closures jsonb;
update public.booking_settings
   set business_hours = metadata->'business_hours'
 where business_hours is null and jsonb_typeof(metadata->'business_hours') = 'object';

-- Processing-time columns some menus use (no-ops where they exist).
alter table public.services add column if not exists active_duration_1_min integer;
alter table public.services add column if not exists processing_duration_min integer;
alter table public.services add column if not exists active_duration_2_min integer;

-- 1) Atomic onboarding ingestion.
create or replace function public.lola_apply_onboarding(p_tenant_id uuid, p_plan jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  r jsonb;
  v_id uuid;
  v_week jsonb := p_plan #> '{hours,week}';
  v_md jsonb;
  v_owner_set boolean := false;
  v_hours boolean := false;
  v_services jsonb := '[]'::jsonb;
  n_prices int := 0;
  n_staff int := 0;
  v_new_staff uuid[] := '{}';
  n_refit int := 0;
  v_cols text;
  v_vals text;
  v_sid uuid;
  v_day text;
  v_dow int;
  v_tp jsonb := coalesce(p_plan->'tenant_patch', '{}'::jsonb);
  v_bp jsonb := coalesce(p_plan->'settings_patch', '{}'::jsonb);
begin
  if p_tenant_id is null then raise exception 'lola_apply_onboarding: tenant required'; end if;
  if not exists (select 1 from tenants where id = p_tenant_id) then raise exception 'lola_apply_onboarding: unknown tenant'; end if;
  -- One ingestion per salon at a time (a double click or a retry waits, then sees the first one's rows).
  perform pg_advisory_xact_lock(hashtextextended('lola_onboard:' || p_tenant_id::text, 0));

  insert into booking_settings (tenant_id) values (p_tenant_id) on conflict (tenant_id) do nothing;
  select coalesce(metadata, '{}'::jsonb) into v_md from booking_settings where tenant_id = p_tenant_id for update;

  -- Opening hours: never over hours the owner set by hand.
  v_owner_set := (v_md ? 'hours_confirmed_at') and coalesce(v_md->>'hours_source', '') not in ('website', 'google');
  if v_week is not null and jsonb_typeof(v_week) = 'object' and not v_owner_set then
    update booking_settings
       set business_hours = v_week,
           metadata = v_md || jsonb_build_object('business_hours', v_week, 'hours_confirmed_at', now(),
                                                 'hours_source', coalesce(p_plan #>> '{hours,source}', 'website'))
     where tenant_id = p_tenant_id;
    v_hours := true;
  end if;

  -- Services: new names only (a retry never duplicates the menu).
  for r in select * from jsonb_array_elements(coalesce(p_plan->'services_insert', '[]'::jsonb)) loop
    continue when coalesce(trim(r->>'name'), '') = '';
    continue when exists (select 1 from services s where s.tenant_id = p_tenant_id and lower(s.name) = lower(trim(r->>'name')) and s.is_active);
    insert into services (tenant_id, name, description, category, duration_minutes, price, is_active,
                          active_duration_1_min, processing_duration_min, active_duration_2_min)
    values (p_tenant_id, trim(r->>'name'), coalesce(r->>'description', ''), nullif(r->>'category', ''),
            greatest(5, coalesce((r->>'duration_minutes')::int, 60)), greatest(0, coalesce((r->>'price')::numeric, 0)), true,
            (r->>'active_duration_1_min')::int, (r->>'processing_duration_min')::int, (r->>'active_duration_2_min')::int)
    returning id into v_id;
    v_services := v_services || jsonb_build_object('id', v_id, 'name', trim(r->>'name'), 'price', greatest(0, coalesce((r->>'price')::numeric, 0)));
  end loop;

  -- Prices the website shows for services already on the menu without one (an owner's price is never overwritten).
  for r in select * from jsonb_array_elements(coalesce(p_plan->'services_price', '[]'::jsonb)) loop
    update services set price = (r->>'price')::numeric, updated_at = now()
     where tenant_id = p_tenant_id and lower(name) = lower(r->>'name') and coalesce(price, 0) = 0 and (r->>'price')::numeric > 0;
    if found then n_prices := n_prices + 1; end if;
  end loop;

  -- The "Consultation $0" placeholder steps aside once a real menu exists.
  if jsonb_array_length(v_services) > 0 then
    update services set is_active = false, updated_at = now()
     where tenant_id = p_tenant_id and lower(name) = 'consultation' and coalesce(price, 0) = 0
       and id not in (select (x->>'id')::uuid from jsonb_array_elements(v_services) x);
  end if;

  -- The team: new names only; the starter stylist steps aside.
  for r in select * from jsonb_array_elements(coalesce(p_plan->'staff_insert', '[]'::jsonb)) loop
    continue when coalesce(trim(r->>'name'), '') = '';
    continue when exists (select 1 from staff s where s.tenant_id = p_tenant_id and lower(s.name) = lower(trim(r->>'name')) and s.is_active);
    insert into staff (tenant_id, name, role, is_active) values (p_tenant_id, trim(r->>'name'), coalesce(nullif(r->>'role', ''), 'Stylist'), true)
    returning id into v_sid;
    v_new_staff := v_new_staff || v_sid;
    n_staff := n_staff + 1;
  end loop;
  if n_staff > 0 and coalesce(p_plan->>'default_staff', '') <> '' then
    update staff set is_active = false, updated_at = now()
     where tenant_id = p_tenant_id and name = p_plan->>'default_staff' and not (id = any(v_new_staff));
  end if;

  -- Staff hours: new stylists, and stylists still on the starter week (09:00–19:00 × 7), get the salon's week.
  v_week := coalesce(v_week, (select business_hours from booking_settings where tenant_id = p_tenant_id), v_md->'business_hours');
  if v_week is not null and jsonb_typeof(v_week) = 'object' then
    for v_sid in
      select s.id from staff s where s.tenant_id = p_tenant_id and s.is_active and (
        s.id = any(v_new_staff)
        or not exists (select 1 from staff_schedules x where x.staff_id = s.id)
        or (select count(*) = 7 and bool_and(to_char(x.start_time, 'HH24:MI') = '09:00' and to_char(x.end_time, 'HH24:MI') = '19:00')
              from staff_schedules x where x.staff_id = s.id))
    loop
      delete from staff_schedules where staff_id = v_sid;
      foreach v_day in array array['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] loop
        v_dow := array_position(array['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], v_day) - 1;
        continue when v_week->v_day is null or coalesce((v_week->v_day->>'closed')::boolean, false);
        insert into staff_schedules (tenant_id, staff_id, day_of_week, start_time, end_time)
        values (p_tenant_id, v_sid, v_dow, (v_week->v_day->>'open')::time, (v_week->v_day->>'close')::time);
      end loop;
      n_refit := n_refit + 1;
    end loop;
  end if;

  -- The salon record (Google Places payload, knowledge, links) — only listed columns that exist.
  select string_agg(format('%I', c.column_name), ', ' order by c.column_name),
         string_agg(format('x.%I', c.column_name), ', ' order by c.column_name)
    into v_cols, v_vals
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'tenants'
     and c.column_name = any (array['services', 'team', 'hours', 'location', 'website_url', 'google_review_url', 'gmb_url', 'persona', 'knowledge'])
     and v_tp ? c.column_name;
  if v_cols is not null then
    if position(',' in v_cols) > 0 then
      execute format('update public.tenants t set (%s) = (select %s from jsonb_populate_record(null::public.tenants, $1) x) where t.id = $2', v_cols, v_vals)
        using v_tp, p_tenant_id;
    else
      execute format('update public.tenants t set %s = (select %s from jsonb_populate_record(null::public.tenants, $1) x) where t.id = $2', v_cols, v_vals)
        using v_tp, p_tenant_id;
    end if;
  end if;

  -- Booking settings the scan found (timezone only while the calendar is empty; the cancellation window; a deposit hint).
  if v_bp ? 'timezone' and not exists (select 1 from bookings where tenant_id = p_tenant_id) then
    update booking_settings set timezone = v_bp->>'timezone' where tenant_id = p_tenant_id;
  end if;
  if v_bp ? 'cancellation_window_hours' then
    update booking_settings set cancellation_window_hours = (v_bp->>'cancellation_window_hours')::int where tenant_id = p_tenant_id;
  end if;
  if v_bp ? 'deposits_detected' then
    update booking_settings set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('deposits_detected', v_bp->'deposits_detected')
     where tenant_id = p_tenant_id;
  end if;

  return jsonb_build_object('ok', true, 'atomic', true, 'hours', v_hours, 'hours_owner_set', v_owner_set,
    'services', v_services, 'services_added', jsonb_array_length(v_services), 'prices_filled', n_prices,
    'team_added', n_staff, 'schedules_set', n_refit, 'tenant_columns', coalesce(v_cols, ''));
end;
$fn$;
revoke all on function public.lola_apply_onboarding(uuid, jsonb) from public, anon, authenticated;

-- 3) The calendar outbox: one row per external calendar.
create table if not exists public.calendar_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  integration_id uuid not null,
  provider text not null,
  feed_key text not null default 'api',
  label text,
  status text not null default 'new',          -- new | ok | retrying | failing
  attempts integer not null default 0,
  next_run_at timestamptz not null default now(),
  lease_until timestamptz,
  last_ok_at timestamptz,
  last_error text,
  last_count integer,
  updated_at timestamptz not null default now(),
  unique (tenant_id, integration_id, feed_key)
);
create index if not exists idx_calendar_sync_jobs_due on public.calendar_sync_jobs (next_run_at) where lease_until is null;
alter table public.calendar_sync_jobs enable row level security;

-- Claim due jobs: concurrent workers never take the same job (SKIP LOCKED), a crashed worker's lease expires.
create or replace function public.lola_claim_sync_jobs(p_limit integer default 20, p_lease_seconds integer default 90, p_tenant_id uuid default null)
returns setof public.calendar_sync_jobs
language plpgsql
security definer
set search_path = public
as $fn$
begin
  return query
  update calendar_sync_jobs j
     set lease_until = now() + make_interval(secs => greatest(15, p_lease_seconds)), updated_at = now()
   where j.id in (
     select id from calendar_sync_jobs
      where (p_tenant_id is null and next_run_at <= now() or p_tenant_id is not null and tenant_id = p_tenant_id)
        and (lease_until is null or lease_until < now())
      order by next_run_at
      limit greatest(1, least(p_limit, 200))
      for update skip locked)
  returning j.*;
end;
$fn$;
revoke all on function public.lola_claim_sync_jobs(integer, integer, uuid) from public, anon, authenticated;

-- 4) Double bookings with an outside calendar: kept blocked until resolved.
create table if not exists public.calendar_conflicts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  booking_id uuid,
  provider text not null,
  external_booking_id text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  staff_id text,
  status text not null default 'open',          -- open | resolved
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (tenant_id, provider, external_booking_id, booking_id)
);
create index if not exists idx_calendar_conflicts_open on public.calendar_conflicts (tenant_id) where status = 'open';
alter table public.calendar_conflicts enable row level security;
