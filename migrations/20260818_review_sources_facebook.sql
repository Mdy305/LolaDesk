-- ============================================================================
-- Review sources: add 'facebook' (idempotent)
-- ============================================================================
-- The review_queue.source check was created with
--   ('google_gmb','yelp_csv','shopify','manual_csv')
-- in 20260816_review_syndication.sql. Facebook review CSVs need a source
-- value, so widen the constraint to accept 'facebook'. Dropping + re-adding
-- is safe: it only ADDS an allowed value, so existing rows always pass.
--
-- api/reviews/upload.js accepts the same value (see its SOURCES list).
-- ============================================================================

alter table review_queue drop constraint if exists review_queue_source_check;

alter table review_queue add constraint review_queue_source_check
  check (source in ('google_gmb','yelp_csv','shopify','manual_csv','facebook'));
