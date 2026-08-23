-- ============================================================================
-- Review request links — per-tenant Yelp / Google review URLs (idempotent).
--
-- The "get reviews on Yelp" answer is a review-request campaign: after a
-- client's appointment ends, Lola texts them a direct link to the salon's
-- Yelp "Write a Review" page (and Google review link). Real customers write
-- the reviews — fully Yelp-compliant, no fake-review fraud.
--
-- The autopilot 'review-request' agent (api/lib/autopilot.js) reads these
-- columns; the Settings page writes them.
--
--   * tenants.yelp_review_url   — direct link to the salon's Yelp
--                                 "Write a Review" page, e.g.
--                                 https://www.yelp.com/biz/<alias>
--   * tenants.google_review_url — Google review shortcut link, e.g.
--                                 https://g.page/r/<id>/review
--
-- RLS: tenants may read/update their own row (existing policy); these are
-- just two more columns on the same table.
-- ============================================================================

alter table tenants add column if not exists yelp_review_url text;
alter table tenants add column if not exists google_review_url text;

-- The agent_runs CHECK constraint originally allowed only four agents; the
-- review-request agent extends the ledger. Drop + recreate with the new set
-- (idempotent: the constraint is recreated with the same name).
alter table agent_runs drop constraint if exists agent_runs_agent_check;
alter table agent_runs add constraint agent_runs_agent_check check (agent in
  ('routing-heal', 'missed-call-recovery', 'rebooking', 'sync-self-heal', 'review-request'));
