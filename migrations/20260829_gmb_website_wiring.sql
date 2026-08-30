-- 20260829_gmb_website_wiring.sql
-- Adds a dedicated Google Business (Maps/GMB) profile link column so owners
-- can save their Maps profile in Settings, and so Lola (the salon's
-- VP-marketing voice) can cite the real website + Google profile mid-call.
alter table public.tenants add column if not exists gmb_url text;