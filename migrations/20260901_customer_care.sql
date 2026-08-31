-- 20260901_customer_care.sql — platform_settings (key/value) for company-level state
-- =============================================================================
-- The customer-care line (/api/customer-care) provisions a LolaDesk company
-- support assistant on Telnyx + attaches one of the owner's owned numbers to
-- it, and must remember that pair across deploys so it's idempotent and the
-- health surfaces can read it. That state is platform-level (NOT tenant-
-- scoped), so it lives in a tiny KV table rather than a tenants row.
-- Idempotent; the app reads/writes with the service role.
-- =============================================================================

create table if not exists public.platform_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
