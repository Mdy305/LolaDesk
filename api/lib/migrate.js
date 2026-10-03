/**
 * api/lib/migrate.js — startup migration runner (self-healing schema)
 * ════════════════════════════════════════════════════════════════════
 * Vercel functions are serverless: there is no persistent process and no
 * single "boot". So migrations run lazily, on cold start, at the exact moment
 * the code first needs the schema to exist — which for the inbound resolver is
 * the first call/text that hits lookupByNumber().
 *
 * Why an exec_sql RPC instead of raw SQL?
 *   @supabase/supabase-js speaks PostgREST, and PostgREST cannot run DDL
 *   (no CREATE TABLE). The one-time bootstrap is a tiny security-definer
 *   function `public.exec_sql(text)` — shipped in schema.sql (fresh DBs) and
 *   at the top of migrations/20260815_tenant_number_routing.sql (existing
 *   DBs). Once it exists, THIS module self-applies any pending migration on
 *   boot, so a fresh deployment can never silently skip the tenant_numbers
 *   table.
 *
 * Bundled migrations (self-heal targets):
 *   • tenant_numbers          — inbound routing (fires on first call/text)
 *   • tenants.activation_status — email-verification gate (fires on resolver boot)
 *   • mfa_registrations       — owner 2FA store (fires when /api/auth/mfa boots)
 *   • platform_settings       — customer-care KV (fires when /api/customer-care boots)
 *
 * Design constraints:
 *   • Idempotent — every embedded migration uses IF NOT EXISTS / ON CONFLICT,
 *     so re-running (or two cold starts racing) is harmless.
 *   • Non-fatal — if exec_sql is missing, this logs ONE clear warning and
 *     returns 'unavailable'; the resolver already degrades to the legacy
 *     tenants.phone_number column instead of dropping calls.
 *   • Bundled — the DDL lives as an inline string, not a file on disk, because
 *     Vercel only bundles api/** files a function imports; migrations/*.sql at
 *     the repo root is NOT guaranteed to exist inside a function's bundle.
 */

import { db } from './db.js';

// Keep in sync with migrations/20260815_tenant_number_routing.sql. Idempotent
// by construction so the boot path and the manual SQL-editor path agree.
const TENANT_NUMBERS_DDL = `create table if not exists tenant_numbers (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  phone_number  text not null,
  kind          text not null default 'primary',
  connection_id text,
  status        text not null default 'active',
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (phone_number)
);

create index if not exists idx_tenant_numbers_tenant on tenant_numbers (tenant_id);
create index if not exists idx_tenant_numbers_phone  on tenant_numbers (phone_number);

insert into tenant_numbers (tenant_id, phone_number, kind, status)
select t.id, t.phone_number, 'primary', 'active'
from tenants t
where t.phone_number is not null and t.phone_number <> ''
on conflict (phone_number) do nothing;

alter table tenant_numbers enable row level security;`;

// Keep in sync with migrations/20260901_force_tenant_activation_status.sql.
// The email-verification gate writes activation_status on every new tenant; the
// CI applier once ledgered the column migration as applied WITHOUT executing it,
// so production's tenants table lacked the column and real signups 500'd with a
// swallowed "column does not exist". Ensuring it HERE at runtime (with the
// platform's own service key) closes that blind spot deterministically.
const ACTIVATION_STATUS_DDL = `alter table public.tenants add column if not exists activation_status text not null default 'active';

create index if not exists idx_tenants_activation_status on public.tenants(activation_status) where activation_status is not null;`;

// Keep in sync with migrations/20260831_mfa_totp.sql. The MFA table was
// ledger-baselined on production without executing (the pre-fix applier), so
// owner 2FA enrollment failed with "could not find the table in the schema
// cache" while the CI apply job reported success. Self-heal at the exact
// moment /api/auth/mfa needs the table — same repair path that saved
// tenant_numbers and tenants.activation_status.
const MFA_REGISTRATIONS_DDL = `create table if not exists public.mfa_registrations (
  user_identifier text primary key,
  secret          text not null,
  verified        boolean not null default false,
  created_at      timestamptz not null default now(),
  verified_at     timestamptz
);`;

// Keep in sync with migrations/20260901_customer_care.sql. The customer-care
// line's platform-level KV store — same ledger-baseline loss as the MFA table.
const PLATFORM_SETTINGS_DDL = `create table if not exists public.platform_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);`;

// Keep in sync with migrations/20260701_complete_supabase_wiring.sql. The
// deposits table feeds the no-show protection loop (api/lib/deposits.js);
// the wiring migration predates the CI applier ever touching production, so
// self-heal when the deposits cron / booking seam cold-starts.
const DEPOSITS_DDL = `create table if not exists public.deposits (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references public.tenants(id) on delete cascade,
  booking_id                uuid references public.bookings(id) on delete set null,
  amount                    numeric not null default 0,
  status                    text default 'pending',
  stripe_payment_intent_id  text,
  created_at                timestamptz default now()
);

create index if not exists idx_deposits_tenant on public.deposits(tenant_id, created_at desc);`;

// rebooking_offers — auto-rebooking loop (api/lib/rebooking.js): one offer
// per completed booking, advanced/expired by the hourly sweep. Mirrors the
// migration definition exactly.
const REBOOKING_OFFERS_DDL = `create table if not exists public.rebooking_offers (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  booking_id     uuid references public.bookings(id) on delete cascade,
  client_id      uuid references public.clients(id) on delete cascade,
  service_id     uuid references public.services(id) on set null,
  staff_id       uuid references public.staff(id) on set null,
  proposed_start timestamptz,
  window_end     timestamptz,
  status         text not null default 'offered',
  advanced_count int not null default 0,
  last_texted_at timestamptz,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

create unique index if not exists uniq_rebooking_offers_booking
  on public.rebooking_offers(booking_id);

create index if not exists idx_rebooking_offers_tenant
  on public.rebooking_offers(tenant_id, status, created_at desc);`;

// booking_reminders second band — the 2h-before "radar" heads-up
// (api/lib/booking-reminders.js): widens the exactly-once key to include
// band. Widening a unique key never violates existing data; the old
// constraint is dropped by guarded name.
const REMINDER_BAND_DDL = `
alter table public.booking_reminders add column if not exists band text not null default '24h';

alter table public.booking_reminders
  drop constraint if exists booking_reminders_booking_id_reminder_for_key;

alter table public.booking_reminders
  add constraint booking_reminders_no_double_text unique (booking_id, reminder_for, band);`;

// legal_acceptances — proof each owner agreed to the Terms at signup.
const LEGAL_ACCEPTANCES_DDL = `create table if not exists public.legal_acceptances (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid,
  tenant_id     uuid,
  email         text,
  terms_version text not null,
  documents     jsonb,
  accepted_at   timestamptz not null default now(),
  ip            text,
  user_agent    text
);
create index if not exists idx_legal_acceptances_tenant on public.legal_acceptances (tenant_id);
alter table public.legal_acceptances enable row level security;`;

// support_tickets — what callers and texters ask LolaDesk's own support line.
const SUPPORT_TICKETS_DDL = `create table if not exists public.support_tickets (
  id         uuid primary key default gen_random_uuid(),
  name       text,
  business   text,
  phone      text,
  email      text,
  issue      text,
  urgency    text not null default 'normal',
  channel    text,
  status     text not null default 'open',
  created_at timestamptz not null default now()
);
create index if not exists idx_support_tickets_created on public.support_tickets (created_at desc);
alter table public.support_tickets enable row level security;`;

// tenant_channels — a salon's own Instagram (and future social) inbox connection.
const TENANT_CHANNELS_DDL = `create table if not exists public.tenant_channels (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  channel     text not null,
  account_id  text not null,
  username    text,
  access_token text,
  expires_at  timestamptz,
  status      text not null default 'active',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (channel, account_id)
);
create index if not exists idx_tenant_channels_tenant on public.tenant_channels (tenant_id);
alter table public.tenant_channels enable row level security;`;

// Lola's marketing engine — campaigns, recipients, the 30-day fill plan, saved analyses.
// (Same as sql/lola-marketing.sql + sql/revenue-engine.sql, so salons never depend on a manual SQL run.)
const LOLA_CAMPAIGNS_DDL = `create table if not exists public.lola_campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null, segment text not null, segment_days int, message text not null,
  status text not null default 'draft' check (status in ('draft','sending','paused','sent','cancelled')),
  created_by text, total int not null default 0,
  created_at timestamptz not null default now(), started_at timestamptz, finished_at timestamptz
);
create index if not exists lola_campaigns_tenant_idx on public.lola_campaigns (tenant_id, created_at desc);
create index if not exists lola_campaigns_status_idx on public.lola_campaigns (status);
alter table public.lola_campaigns enable row level security;`;
const LOLA_CAMPAIGN_RECIPIENTS_DDL = `create table if not exists public.lola_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.lola_campaigns(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  phone text not null, first_name text,
  status text not null default 'pending' check (status in ('pending','sent','failed','skipped')),
  error text, sent_at timestamptz,
  unique (campaign_id, phone)
);
create index if not exists lola_campaign_recipients_campaign_idx on public.lola_campaign_recipients (campaign_id, status);
create index if not exists lola_campaign_recipients_tenant_idx on public.lola_campaign_recipients (tenant_id, status, sent_at);
alter table public.lola_campaign_recipients enable row level security;`;
const LOLA_FILL_PLANS_DDL = `create table if not exists public.lola_fill_plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  status text not null default 'proposed', autopilot boolean not null default false, reason text,
  horizon_start date, horizon_end date,
  forecast jsonb default '{}'::jsonb, strategy jsonb default '{}'::jsonb, items jsonb default '[]'::jsonb,
  approved_at timestamptz, created_at timestamptz not null default now()
);
create index if not exists idx_fill_plans_tenant on public.lola_fill_plans (tenant_id, created_at desc);
create index if not exists idx_fill_plans_status on public.lola_fill_plans (status);
alter table public.lola_fill_plans enable row level security;`;
const MARKETING_INTELLIGENCE_DDL = `create table if not exists public.marketing_intelligence (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null, source_url text, title text, summary text,
  data jsonb default '{}'::jsonb, performance jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_marketing_intel_tenant on public.marketing_intelligence (tenant_id, created_at desc);
alter table public.marketing_intelligence enable row level security;`;

// booking_outbox — durable write-through of LolaDesk bookings to the salon's own platform.
const BOOKING_OUTBOX_DDL = `create table if not exists public.booking_outbox (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  booking_id      uuid not null,
  op              text not null default 'create',
  payload         jsonb,
  status          text not null default 'pending',
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  provider        text,
  external_id     text,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (booking_id, op)
);
create index if not exists idx_booking_outbox_due on public.booking_outbox (status, next_attempt_at);
create index if not exists idx_booking_outbox_tenant on public.booking_outbox (tenant_id);
alter table public.booking_outbox enable row level security;`;

// Memoized per cold start: run the probe (and any DDL) at most once per
// function instance, then every later call is a no-op promise resolution.
let _ensured = null;

/** Forget the memoized result (tests, or after a manual re-migration). */
export function resetMigrations() {
  _ensured = null;
}

/**
 * Ensure required schema exists. Returns a string status:
 *   'no-db'       — Supabase env vars not configured (db() is null)
 *   'up-to-date'  — every probed table/column already exists, nothing to do
 *   'applied'     — something was missing and was just created
 *   'unavailable' — schema missing but exec_sql isn't there to fix it
 *   'error'       — unexpected failure (logged; degrades gracefully)
 */
export function ensureMigrations() {
  if (_ensured) return _ensured;
  _ensured = runMigrations().catch((err) => {
    console.warn('[migrate] unexpected migration error:', String(err?.message || err).slice(0, 200));
    _ensured = null; // allow a retry on the next call / cold start
    return 'error';
  });
  return _ensured;
}

// Shared ensure step: if PostgREST reports the table missing, apply its
// idempotent DDL through exec_sql. Returns the table name when applied.
async function ensureTable(c, table, ddl, applied) {
  try {
    const probe = await c.from(table).select('*').limit(1);
    if (!probe.error) return; // present
    const res = await c.rpc('exec_sql', { p_sql: ddl });
    if (res?.error) throw new Error(res.error?.message || 'exec_sql returned an error');
    console.log('[migrate] applied ' + table + ' (was missing)');
    applied.push(table);
  } catch (e) {
    console.warn('[migrate] ' + table + ' ensure failed:', String(e?.message || e).slice(0, 160));
  }
}

async function runMigrations() {
  const c = db();
  if (!c) return 'no-db';

  const applied = [];

  // Cheap probe: if the table exists this returns rows (or an empty array)
  // with error:null. If it's missing, PostgREST returns a non-null error.
  const probe = await c.from('tenant_numbers').select('id').limit(1);
  if (!probe.error) {
    // Table present — still verify the email-verification column below.
  } else {
    try {
      const res = await c.rpc('exec_sql', { p_sql: TENANT_NUMBERS_DDL });
      if (res?.error) throw new Error(res.error?.message || 'exec_sql returned an error');
      console.log('[migrate] applied tenant_numbers (routing table was missing)');
      applied.push('tenant_numbers');
    } catch (e) {
      const msg = String(e?.message || e);
      const missingFn = /could not find the function|function .*exec_sql.* does not exist|PGRST202/i.test(msg);
      console.warn(
        '[migrate] tenant_numbers missing; auto-apply unavailable' +
          (missingFn ? ' — run migrations/20260815_tenant_number_routing.sql once to bootstrap exec_sql' : '') +
          ': ' + msg.slice(0, 160)
      );
    }
  }

  // tenants.activation_status — the column the email-verification gate writes.
  // Idempotent ALTER; only fires when PostgREST reports the column missing.
  try {
    const tcol = await c.from('tenants').select('activation_status').limit(1);
    if (tcol.error && /activation_status/i.test(String(tcol.error?.message || tcol.error))) {
      const res = await c.rpc('exec_sql', { p_sql: ACTIVATION_STATUS_DDL });
      if (res?.error) throw new Error(res.error?.message || 'exec_sql returned an error');
      console.log('[migrate] applied tenants.activation_status (email-verification gate column)');
      applied.push('activation_status');
    }
  } catch (e) {
    console.warn('[migrate] activation_status ensure failed:', String(e?.message || e).slice(0, 160));
  }

  // mfa_registrations — owner 2FA enrollment/verification store; the
  // self-heal fires when the 2FA endpoint cold-starts (see MFA_REGISTRATIONS_DDL).
  await ensureTable(c, 'mfa_registrations', MFA_REGISTRATIONS_DDL, applied);
  // platform_settings — customer-care line KV; self-heals when the
  // customer-care endpoint cold-starts.
  await ensureTable(c, 'platform_settings', PLATFORM_SETTINGS_DDL, applied);
  await ensureTable(c, 'legal_acceptances', LEGAL_ACCEPTANCES_DDL, applied);
  await ensureTable(c, 'support_tickets', SUPPORT_TICKETS_DDL, applied);
  await ensureTable(c, 'tenant_channels', TENANT_CHANNELS_DDL, applied);
  await ensureTable(c, 'booking_outbox', BOOKING_OUTBOX_DDL, applied);
  await ensureTable(c, 'lola_campaigns', LOLA_CAMPAIGNS_DDL, applied);
  await ensureTable(c, 'lola_campaign_recipients', LOLA_CAMPAIGN_RECIPIENTS_DDL, applied);
  await ensureTable(c, 'lola_fill_plans', LOLA_FILL_PLANS_DDL, applied);
  await ensureTable(c, 'marketing_intelligence', MARKETING_INTELLIGENCE_DDL, applied);
  // deposits — no-show protection loop (api/lib/deposits.js); self-heals when
  // the deposits cron or the booking seam cold-starts.
  await ensureTable(c, 'deposits', DEPOSITS_DDL, applied);
  // rebooking_offers — auto-rebooking loop (api/lib/rebooking.js); self-heals
  // when the rebooking seam or cron cold-starts.
  await ensureTable(c, 'rebooking_offers', REBOOKING_OFFERS_DDL, applied);

  // booking_reminders.band — second reminder band (2h radar); self-heals when
  // the reminder engine cold-starts. Runs whenever the band column is missing.
  try {
    const band = await c.from('booking_reminders').select('band').limit(1);
    if (band.error && /band/i.test(String(band.error?.message || band.error))) {
      const res = await c.rpc('exec_sql', { p_sql: REMINDER_BAND_DDL });
      if (res?.error) throw new Error(res.error?.message || 'exec_sql returned an error');
      console.log('[migrate] applied booking_reminders.band (2h radar lane)');
      applied.push('booking_reminders.band');
    }
  } catch (e) {
    console.warn('[migrate] booking_reminders.band ensure failed:', String(e?.message || e).slice(0, 160));
  }

  return applied.length ? 'applied' : 'up-to-date';
}
