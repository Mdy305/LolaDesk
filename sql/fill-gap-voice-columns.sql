-- Extend fill_gap_attempts to record voice-call outcomes.
-- Safe to re-run: uses IF NOT EXISTS on every add.

ALTER TABLE fill_gap_attempts ADD COLUMN IF NOT EXISTS channel             text DEFAULT 'sms';
ALTER TABLE fill_gap_attempts ADD COLUMN IF NOT EXISTS telnyx_call_id      text;
ALTER TABLE fill_gap_attempts ADD COLUMN IF NOT EXISTS answered_at         timestamptz;
ALTER TABLE fill_gap_attempts ADD COLUMN IF NOT EXISTS ended_at            timestamptz;
ALTER TABLE fill_gap_attempts ADD COLUMN IF NOT EXISTS call_duration_sec   int;
ALTER TABLE fill_gap_attempts ADD COLUMN IF NOT EXISTS answered_by         text;         -- 'human' | 'machine_end_beep' | etc
ALTER TABLE fill_gap_attempts ADD COLUMN IF NOT EXISTS final_call_status   text;         -- 'completed' | 'no-answer' | 'busy' | 'failed'
ALTER TABLE fill_gap_attempts ADD COLUMN IF NOT EXISTS gather_response     text;         -- raw speech or DTMF Lola heard

CREATE INDEX IF NOT EXISTS fill_gap_attempts_telnyx_call_id_idx
  ON fill_gap_attempts (telnyx_call_id) WHERE telnyx_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fill_gap_attempts_channel_idx
  ON fill_gap_attempts (tenant_id, channel, created_at DESC);
