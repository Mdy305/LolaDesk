-- 20260831_mfa_totp.sql — two-factor auth (TOTP) registrations for owners/operators
-- =============================================================================
-- One row per auth email (lowercased). `secret` is the RFC 4648 base32 shared
-- secret shown once at enrollment and mirrored into the owner's authenticator
-- app; `verified` is flipped true only after the owner proves a live code, so a
-- half-finished enrollment never gates a login. Backed by api/lib/mfa.js; the
-- login gate only consults rows with verified = true.
-- =============================================================================

create table if not exists public.mfa_registrations (
  user_identifier text primary key,
  secret          text not null,
  verified        boolean not null default false,
  created_at      timestamptz not null default now(),
  verified_at     timestamptz
);