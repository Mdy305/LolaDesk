-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260819_backfill_number_connections.sql   ═  APPLIED ON PRODUCTION 2026-08-19  ═
-- ═══════════════════════════════════════════════════════════════════════════
-- Backfill tenant_numbers.connection_id so every active voice line points at
-- the working Call Control app (TELNYX_VOICE_APP_ID = 2982432232334951429).
--
-- Inbound routing itself keys off tenant_id + status, so calls were always
-- answered — but the admin numbers panel and lola-health showed "missing" or
-- stale records. Two states are corrected:
--   • null                → never populated
--   • '2991758319724529273' → the dead 'legacy upgrade' mapping Telnyx
--     rejects for origination (verified live)
--
-- Idempotent + re-runnable: a number already on the working connection is
-- left untouched.
-- ═══════════════════════════════════════════════════════════════════════════

update tenant_numbers
set connection_id = '2982432232334951429',
    updated_at    = now()
where status = 'active'
  and (
    connection_id is null
    or connection_id in ('2991758319724529273')
  );