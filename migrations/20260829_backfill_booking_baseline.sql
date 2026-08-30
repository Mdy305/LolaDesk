-- 20260829_backfill_booking_baseline.sql — one-time backfill of per-tenant
-- booking basics for tenants that predate the provisioning seed.
-- ===========================================================================
-- The shipped ensureBookingBaseline() only activates for NEWLY provisioned
-- tenants (and lazily when a tenant is fully bookless). Early tenants already
-- have a booking_settings row, so the gate returns `skipped:'present'` and
-- never creates their services / staff / schedule — even though every real
-- tenant (except luxe-beauty-studio) has ZERO staff_schedules, which is what
-- availability-engine-v2 actually reads to build bookable slots. As a result
-- Lola and the booking widget render "book now" but can never offer a time.
--
-- This backfills on the same rules as the seed, guarded with NOT EXISTS so it
-- is idempotent and safe to re-run: it never duplicates or overwrites.
-- ===========================================================================

-- 1. booking_settings for any tenant that still lacks one.
insert into public.booking_settings (tenant_id)
select t.id
from public.tenants t
where not exists (select 1 from public.booking_settings bs where bs.tenant_id = t.id);

-- 2. services: seed from the owner's stored menu (tenants.services), or one
--    default "Consultation" so the catalog is never empty. Plain insert —
--    there is no unique (tenant_id, name) constraint on services.
insert into public.services (tenant_id, name, duration_minutes, price, description, is_active)
select
  t.id,
  coalesce(nullif(trim(elem ->> 'name'), ''), 'Consultation') as name,
  coalesce(nullif((elem ->> 'duration')::int, null), 60) as duration_minutes,
  coalesce(nullif((elem ->> 'price')::numeric, null), 0) as price,
  coalesce(elem ->> 'category', '') as description,
  true as is_active
from public.tenants t,
     lateral jsonb_array_elements(coalesce(t.services, '[]'::jsonb)) as elem
where not exists (select 1 from public.services s where s.tenant_id = t.id)
union all
select t.id, 'Consultation', 60, 0, '', true
from public.tenants t
where not exists (select 1 from public.services s where s.tenant_id = t.id)
  and (t.services is null or jsonb_array_length(t.services) = 0);

-- 3. one default staff member for tenants with no staff.
insert into public.staff (tenant_id, name, role, is_active)
select t.id, 'Any available team member', 'Stylist', true
from public.tenants t
where not exists (select 1 from public.staff st where st.tenant_id = t.id);

-- 4. a Mon–Sun (1,2,3,4,5,6,0) 09:00–19:00 schedule for every staff member that
--    has NO schedule yet (new or pre-existing), so the availability engine has
--    slots to offer. This is the actual blocker across every real tenant.
insert into public.staff_schedules (tenant_id, staff_id, day_of_week, start_time, end_time)
select st.tenant_id, st.id, d.day, '09:00:00', '19:00:00'
from public.staff st
cross join (values (1),(2),(3),(4),(5),(6),(0)) as d(day)
where not exists (
  select 1 from public.staff_schedules sc
  where sc.staff_id = st.id and sc.day_of_week = d.day
);