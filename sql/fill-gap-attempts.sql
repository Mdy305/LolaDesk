-- fill_gap_attempts: every time Lola texts a client to fill a gap.
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS fill_gap_attempts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  gap_date            date NOT NULL,
  gap_start_time      text NOT NULL,           -- 'HH:MM'
  gap_duration_minutes int NOT NULL DEFAULT 30,
  gap_stylist         text,
  client_id           uuid,
  waitlist_id         uuid,
  client_name         text,
  client_phone        text NOT NULL,
  source              text NOT NULL,           -- 'waitlist' | 'lapsed' | 'manual'
  fit_score           int,
  message             text NOT NULL,
  telnyx_message_id   text,
  status              text NOT NULL DEFAULT 'pending', -- 'sent' | 'failed' | 'accepted' | 'declined' | 'booked'
  error               text,
  responded_at        timestamptz,
  outcome             text,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fill_gap_attempts_tenant_date_idx
  ON fill_gap_attempts (tenant_id, gap_date DESC, gap_start_time);
CREATE INDEX IF NOT EXISTS fill_gap_attempts_phone_idx
  ON fill_gap_attempts (tenant_id, client_phone, created_at DESC);
CREATE INDEX IF NOT EXISTS fill_gap_attempts_status_idx
  ON fill_gap_attempts (tenant_id, status);

ALTER TABLE fill_gap_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fill_gap_attempts_read  ON fill_gap_attempts;
DROP POLICY IF EXISTS fill_gap_attempts_write ON fill_gap_attempts;
CREATE POLICY fill_gap_attempts_read ON fill_gap_attempts
  FOR SELECT USING (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid()));
CREATE POLICY fill_gap_attempts_write ON fill_gap_attempts
  FOR ALL USING (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid()))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid()));
