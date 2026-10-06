-- LolaDesk — October fixes (booking integrity, money, client notes, one call row).
-- Safe to run more than once. Supabase → SQL Editor → New query → paste → Run.

-- ════ 20261006_booking_integrity.sql ════
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

-- ════ 20261006_money_fix.sql ════
-- ============================================================================
-- Money fix (idempotent): billing lifecycle columns, one-trial-per-salon brake,
-- and indexes for the fee / cost ledgers. Every column is optional for the code:
-- api/stripe-webhook.js retries without the new tenant columns if they're missing,
-- and lib/service-gate.js falls back to current_period_end when past_due_since is absent.
-- ============================================================================

-- ── tenants: subscription lifecycle ─────────────────────────────────────────
alter table tenants add column if not exists past_due_since     timestamptz;  -- first failed payment (7-day grace)
alter table tenants add column if not exists billing_interval   text;         -- monthly | annual
alter table tenants add column if not exists canceled_at        timestamptz;
alter table tenants add column if not exists trial_denied_reason text;        -- salon_phone | owner_phone | google_place | website | ip_trial_limit
alter table tenants add column if not exists stripe_subscription_id text;
alter table tenants add column if not exists current_period_end timestamptz;

-- ── signup_attempts: persisted per-IP sign-up / trial brake (lib/trial-guard.js) ──
create table if not exists signup_attempts (
  id          uuid primary key default gen_random_uuid(),
  ip          text not null,
  email       text,
  tenant_id   uuid references tenants(id) on delete set null,
  trial       boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists idx_signup_attempts_ip on signup_attempts (ip, created_at desc);
alter table signup_attempts enable row level security;   -- service role only

-- ── ledgers ────────────────────────────────────────────────────────────────
create index if not exists idx_usage_events_kind_time on usage_events (kind, created_at desc);
do $$ begin
  if exists (select 1 from information_schema.tables where table_name = 'booking_fees') then
    execute 'create index if not exists idx_booking_fees_status_id on booking_fees (status, id)';
  end if;
end $$;

-- deposits.status now also takes: disputed (charge.dispute.created), expired / flagged / void / kept
-- (already used by lib/deposits.js) — the column has no check constraint, nothing to change.

-- ════ 20261006_client_notes.sql ════
-- ============================================================================
-- Client notes + color formulas (idempotent).
--
-- The client profile (client.html → /api/crm-notes) keeps a running history
-- per client: free-text notes ("prefers Saturday mornings", "allergic to PPD")
-- and color formulas ({date, formula, developer, processing, notes, stylist}).
-- One table, two kinds, always scoped to the salon (tenant_id).
--
-- Until this runs, /api/crm-notes degrades gracefully: notes and formulas are
-- appended to clients.notes as dated lines, so nothing an owner types is lost.
--
-- RLS: tenants read their own rows; writes are service-role only (the API
-- resolves the salon from the signed-in user, never from the request).
-- ============================================================================

-- The fallback store (and the "On file" card) — present on every install, made sure here.
alter table clients add column if not exists notes text;

create table if not exists client_notes (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  client_id   uuid not null references clients(id) on delete cascade,
  kind        text not null default 'note' check (kind in ('note', 'formula')),
  body        text,                              -- the note, or the formula itself
  data        jsonb not null default '{}'::jsonb, -- formula: {date, formula, developer, processing, notes, stylist}
  author      text,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_client_notes_client on client_notes (tenant_id, client_id, kind, created_at desc);

alter table client_notes enable row level security;
drop policy if exists client_notes_read on client_notes;
create policy client_notes_read on client_notes
  for select using (tenant_id = auth_tenant());

-- ════ 20261006_calls_one_row.sql ════
-- ============================================================================
-- One calls row per phone call (idempotent). lib/call-row.js finds-or-creates by
-- telnyx_call_control_id; this index makes a race between two webhooks for the
-- same call impossible. If old duplicate rows exist, the index is skipped (with a
-- notice) instead of failing the script — everything else still applies.
-- ============================================================================
alter table calls add column if not exists telnyx_call_control_id text;
do $$ begin
  begin
    execute 'create unique index if not exists calls_one_row_per_call on calls (telnyx_call_control_id) where telnyx_call_control_id is not null';
  exception when unique_violation then
    raise notice 'calls: older duplicate rows share a call id — one-row index skipped (new calls are still de-duplicated in code)';
  end;
end $$;

