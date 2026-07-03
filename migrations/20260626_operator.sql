-- ════════════════════════════════════════════════════════════════
-- Operator ("Jarvis") additions — owner-facing voice control
-- ════════════════════════════════════════════════════════════════
-- The owner-facing assistant can do privileged, destructive things
-- (move/cancel appointments, text every client). We gate those on a
-- spoken PIN. Caller ID is stored as a soft signal only (it's spoofable),
-- so the PIN — stored hashed — is the real authorization for changes.
--
-- Safe to re-run (idempotent).

alter table tenants add column if not exists operator_phone   text;  -- owner's caller ID (soft signal)
alter table tenants add column if not exists operator_pin_hash text;  -- sha256 of the spoken PIN

comment on column tenants.operator_phone   is 'Owner caller ID for the private operator line. Soft signal only — not sufficient for destructive actions.';
comment on column tenants.operator_pin_hash is 'sha256 of the spoken operator PIN. Required to confirm move/cancel/broadcast actions.';
