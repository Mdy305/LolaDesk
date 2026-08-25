-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260825_gmb_review_replies.sql
--  WHAT: Lola auto-replies to Google reviews (the live replacement for the
--        retired Google Business Messages API — chat from Maps ended
--        2024-07-31, so review replies are how Lola answers on Google).
--   1. gmb_review_replies — audit log of every public reply Lola posts.
--   2. tenants.auto_reply_gmb — per-salon opt-in toggle (default off).
-- Idempotent. RLS: no public policy (reads go through the service role).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists gmb_review_replies (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  review_id   text not null unique,   -- Google resource name (accounts/…/reviews/…)
  rating      integer,
  reviewer    text,
  comment     text,
  reply       text not null,
  posted_at   timestamptz default now(),
  created_at  timestamptz default now()
);

create index if not exists idx_gmb_replies_tenant on gmb_review_replies (tenant_id);
create index if not exists idx_gmb_replies_review on gmb_review_replies (review_id);

alter table tenants add column if not exists auto_reply_gmb boolean not null default false;

alter table gmb_review_replies enable row level security;
