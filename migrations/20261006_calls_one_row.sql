-- ============================================================================
-- One calls row per phone call (idempotent). lib/call-row.js finds-or-creates by
-- telnyx_call_control_id; this index makes a race between two webhooks for the
-- same call impossible. If old duplicate rows exist, the index is skipped (with a
-- notice) instead of failing the script — everything else still applies.
-- ============================================================================
alter table calls add column if not exists telnyx_call_control_id text;
do $$ begin
  begin
    execute 'create unique index if not exists calls_one_row_per_call on calls (telnyx_call_control_id) where telnyx_call_control_id is not null';
  exception when unique_violation then
    raise notice 'calls: older duplicate rows share a call id — one-row index skipped (new calls are still de-duplicated in code)';
  end;
end $$;
