-- ════════════════════════════════════════════════════════════════════════
-- sql/rls-hardening.sql — Row Level Security on every salon (tenant) table
-- ════════════════════════════════════════════════════════════════════════
-- WHY: Supabase exposes every table in the `public` schema through PostgREST.
-- The anon key is public by design (it ships to every browser). Any public
-- table WITHOUT row level security can be read and written by anyone holding
-- that key — every salon's clients, memories, conversations and calls.
--
-- WHAT THIS DOES: turns RLS ON for every table that holds salon data. It adds
-- NO new "allow" policies, so for the anon/authenticated roles the default is
-- DENY (existing tenant_read_own policies from schema.sql keep working).
--
-- WHY THE APP KEEPS WORKING: every LolaDesk API route talks to Postgres with
-- the service-role key (api/lib/db.js → SUPABASE_SERVICE_KEY), and the
-- service_role BYPASSES RLS. The browser never queries Supabase tables
-- directly (it calls /api/*). Nothing about the app's access pattern changes.
--
-- SAFE TO RUN: idempotent (ENABLE on an already-enabled table is a no-op),
-- skips tables that don't exist, never drops/alters data, columns or
-- existing policies. Run it in the Supabase SQL editor; re-run any time
-- (e.g. after new tables are added — the dynamic block picks them up).
-- ════════════════════════════════════════════════════════════════════════

-- 1. Every public base table that carries a tenant_id column (clients,
--    client_memories, conversations, messages, calls, call_sessions, bookings,
--    services, staff, knowledge_base, tenant_numbers, tenant_users, usage_events,
--    integrations, booking_settings, waitlists, campaigns, … whatever exists).
do $$
declare r record;
begin
  for r in
    select c.table_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public'
       and c.column_name = 'tenant_id'
       and t.table_type = 'BASE TABLE'
  loop
    execute format('alter table public.%I enable row level security', r.table_name);
  end loop;
end $$;

-- 2. Salon-sensitive tables that are keyed some other way (no tenant_id column).
do $$
declare t text;
begin
  foreach t in array array[
    'tenants',               -- salon records: owner email, operator phone, PIN hash, settings
    'staff_services',        -- which stylist does which service (scoped through staff)
    'mfa_registrations',     -- owners' second-factor secrets
    'booking_services',      -- scoped through bookings.booking_id
    'telnyx_events',         -- inbound webhook de-dupe (phone numbers in ids)
    'orchestrator_audit',    -- owner prompts
    'telemetry_events',      -- widget beacons (IPs, user agents)
    'oauth_states',          -- OAuth handshakes
    'admin_audit',
    'platform_settings'
  ]
  loop
    if exists (select 1 from information_schema.tables
                where table_schema = 'public' and table_name = t and table_type = 'BASE TABLE') then
      execute format('alter table public.%I enable row level security', t);
    end if;
  end loop;
end $$;

-- 3. Re-assert: the self-migration helper must never be callable by a browser token.
do $$
declare r text;
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'exec_sql') then
    execute 'revoke all on function public.exec_sql(text) from public';
    foreach r in array array['anon','authenticated']
    loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke execute on function public.exec_sql(text) from %I', r);
      end if;
    end loop;
  end if;
end $$;

-- 4. Check (read-only): any public table still WITHOUT RLS is listed here.
--    Expected after this script: none that hold salon data.
select c.relname as table_without_rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relkind = 'r'
   and not c.relrowsecurity
 order by 1;
