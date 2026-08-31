-- 20260831_email_verify.sql — email verification gates signup activation.
-- =============================================================================
-- A salon owner created via /api/auth/signup no longer auto-confirms: the email
-- is confirmed through Supabase Auth and the tenant starts in `pending_email`.
-- On the owner's first CONFIRMED login the tenant flips to `active` and (if it
-- has no number yet) a Telnyx number is auto-assigned. Existing tenants keep
-- the default `active`, so nothing changes for salons already live. Default
-- also keeps Google/SSO sign-ins active (their email is already verified).
-- =============================================================================
alter table public.tenants add column if not exists activation_status text not null default 'active';

create index if not exists idx_tenants_activation_status on public.tenants(activation_status) where activation_status is not null;
