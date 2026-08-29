-- ============================================================================
-- Lola Autopilot · callback-recovery agent
-- ============================================================================
-- Extends the autopilot ledger for the callback-recovery agent, which
-- ORIGINATES a call back from the salon's own line to callers who rang and
-- weren't served (see api/lib/call-callback.js for the shared originate core).
--
--   * tenants.callback_sent_at  — cooldown stamp so Lola only returns missed
--                                 calls once per window per salon.
--   * agent_runs.agent check    — admit 'callback-recovery' into the ledger.
--
-- Idempotent; safe to re-run.
-- ============================================================================

alter table tenants add column if not exists callback_sent_at timestamptz;

alter table agent_runs drop constraint if exists agent_runs_agent_check;
alter table agent_runs add constraint agent_runs_agent_check check (
  agent in ('routing-heal', 'missed-call-recovery', 'rebooking', 'sync-self-heal', 'review-request', 'callback-recovery')
);