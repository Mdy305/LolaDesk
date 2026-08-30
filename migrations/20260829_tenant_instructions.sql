-- 20260829_tenant_instructions.sql — Lola's per-salon "special instructions"
-- ===========================================================================
-- The Settings > Lola AI tab exposes "Special instructions — anything Lola
-- should always mention, avoid, or handle a specific way", but no column ever
-- backed it: the page loaded it from nowhere and the write path silently
-- dropped it (settings.js forwards only whitelisted fields, so the owner saw
-- "Saved" while nothing persisted). Add the column and surface it to Lola's
-- call prompt via tenantKnowledgePrompt().
-- ===========================================================================

alter table public.tenants add column if not exists instructions text not null default '';