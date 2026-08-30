-- ═══════════════════════════════════════════════════════════════════════════
-- 20260818_clients_schema_compat.sql — reconcile legacy client columns
-- ═══════════════════════════════════════════════════════════════════════════
-- The production `clients` table was migrated to a first_name/last_name/phone/
-- status/preferred_service/preferred_staff_id schema, but many API paths still
-- read the LEGACY columns (name, phone_number, opted_out, is_vip, last_service).
-- Those queries fail with "column clients.X does not exist" (Growth OS,
-- campaign-send, marketing-automations, salon, operator-db, orchestrator, …).
--
-- Fix: recreate the legacy columns as STORED GENERATED columns derived from the
-- canonical columns. Every legacy reader works again, the values can never
-- drift from the canonical data, and no writer has to dual-write. The two
-- writers that target generated columns are updated in code (salon.js writes
-- name → now writes first_name/last_name; db.js setOptOut writes opted_out →
-- now writes status).
--
-- Idempotent and safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- Full name for display/search: "first last", null when both are empty.
-- (btrim/coalesce/|| instead of concat_ws — concat_ws is not marked IMMUTABLE
-- and generated columns require immutable expressions.)
alter table clients
  add column if not exists name text generated always as (
    nullif(btrim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')), '')
  ) stored;

-- Legacy phone alias.
alter table clients
  add column if not exists phone_number text generated always as (phone) stored;

-- Legacy service alias.
alter table clients
  add column if not exists last_service text generated always as (preferred_service) stored;

-- VIP convention used across the codebase: explicit status OR spend >= 1000.
alter table clients
  add column if not exists is_vip boolean generated always as (
    lower(coalesce(status, '')) = 'vip' or coalesce(lifetime_value, 0) >= 1000
  ) stored;

-- Opt-out is now a status value. Generated so STOP-handling reads stay honest.
alter table clients
  add column if not exists opted_out boolean generated always as (
    lower(coalesce(status, '')) = 'opted_out'
  ) stored;

-- Opt-out timestamp stays a REAL writable column (setOptOut maintains it).
alter table clients
  add column if not exists opted_out_at timestamptz;
