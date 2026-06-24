-- ═══════════════════════════════════════════════════════════════
-- MIGRATION: 20260624_lola_photo_campaigns_schema.sql
-- LOLA™ Photo Analysis + Email Campaigns Database Schema
-- ═══════════════════════════════════════════════════════════════

-- Campaign sends tracking table
CREATE TABLE IF NOT EXISTS campaign_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  campaign_type VARCHAR(50) NOT NULL,
  email_subject VARCHAR(255),
  email_from VARCHAR(255),
  email_html TEXT,
  provider VARCHAR(50),
  message_id VARCHAR(255),
  success BOOLEAN DEFAULT FALSE,
  opened_at TIMESTAMP,
  clicked_at TIMESTAMP,
  bounced BOOLEAN DEFAULT FALSE,
  unsubscribed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT fk_campaign_sends_client FOREIGN KEY (client_id) REFERENCES clients(id),
  CONSTRAINT fk_campaign_sends_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX idx_campaign_sends_client ON campaign_sends(client_id, tenant_id);
CREATE INDEX idx_campaign_sends_created ON campaign_sends(created_at);
CREATE INDEX idx_campaign_sends_type ON campaign_sends(campaign_type);

-- Follow-up queue for scheduled campaigns
CREATE TABLE IF NOT EXISTS follow_up_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  campaign_type VARCHAR(50) NOT NULL,
  context JSONB,
  scheduled_for TIMESTAMP NOT NULL,
  processed_at TIMESTAMP,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT fk_followup_client FOREIGN KEY (client_id) REFERENCES clients(id),
  CONSTRAINT fk_followup_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX idx_followup_scheduled ON follow_up_queue(scheduled_for) WHERE processed_at IS NULL;
CREATE INDEX idx_followup_client ON follow_up_queue(client_id, tenant_id);

-- Photo analysis results
CREATE TABLE IF NOT EXISTS photo_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  analysis_data JSONB NOT NULL,
  photo_url VARCHAR(2000),
  image_hash VARCHAR(64),
  condition VARCHAR(50),
  risk_level VARCHAR(20),
  requires_consultation BOOLEAN,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT fk_photo_client FOREIGN KEY (client_id) REFERENCES clients(id),
  CONSTRAINT fk_photo_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX idx_photo_client ON photo_analyses(client_id, tenant_id);
CREATE INDEX idx_photo_risk ON photo_analyses(risk_level);
CREATE INDEX idx_photo_created ON photo_analyses(created_at);
CREATE INDEX idx_photo_hash ON photo_analyses(image_hash) WHERE image_hash IS NOT NULL;

-- Email unsubscribe tracking
CREATE TABLE IF NOT EXISTS email_unsubscribes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  unsubscribe_token VARCHAR(255) UNIQUE,
  reason TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT fk_unsub_client FOREIGN KEY (client_id) REFERENCES clients(id),
  CONSTRAINT fk_unsub_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX idx_unsub_token ON email_unsubscribes(unsubscribe_token);
CREATE INDEX idx_unsub_client ON email_unsubscribes(client_id, tenant_id);

-- Client mood history for sentiment tracking
CREATE TABLE IF NOT EXISTS client_mood_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  mood VARCHAR(50),
  context JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT fk_mood_client FOREIGN KEY (client_id) REFERENCES clients(id),
  CONSTRAINT fk_mood_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX idx_mood_client ON client_mood_history(client_id, tenant_id);
CREATE INDEX idx_mood_created ON client_mood_history(created_at);

-- Error logging for troubleshooting
CREATE TABLE IF NOT EXISTS error_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID,
  client_id UUID,
  error_type VARCHAR(100),
  error_message TEXT,
  stack_trace TEXT,
  context JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT fk_error_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_error_client FOREIGN KEY (client_id) REFERENCES clients(id)
);

CREATE INDEX idx_error_tenant ON error_logs(tenant_id);
CREATE INDEX idx_error_created ON error_logs(created_at);
CREATE INDEX idx_error_type ON error_logs(error_type);

-- Add columns to existing clients table if they don't exist
ALTER TABLE clients 
  ADD COLUMN IF NOT EXISTS vip_status BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS last_contact TIMESTAMP,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

-- RLS policies for campaign tables
ALTER TABLE campaign_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_up_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE photo_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_unsubscribes ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_mood_history ENABLE ROW LEVEL SECURITY;

-- Tenant isolation policies
CREATE POLICY IF NOT EXISTS campaign_sends_tenant_isolation 
  ON campaign_sends FOR SELECT 
  USING (tenant_id = auth.jwt()->'tenant_id'::UUID);

CREATE POLICY IF NOT EXISTS follow_up_queue_tenant_isolation 
  ON follow_up_queue FOR SELECT 
  USING (tenant_id = auth.jwt()->'tenant_id'::UUID);

CREATE POLICY IF NOT EXISTS photo_analyses_tenant_isolation 
  ON photo_analyses FOR SELECT 
  USING (tenant_id = auth.jwt()->'tenant_id'::UUID);

-- Triggers for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_campaign_sends_updated_at 
  BEFORE UPDATE ON campaign_sends
  FOR EACH ROW 
  EXECUTE FUNCTION update_updated_at_column();

-- Grant permissions
GRANT SELECT, INSERT, UPDATE ON campaign_sends TO authenticated;
GRANT SELECT, INSERT, UPDATE ON follow_up_queue TO authenticated;
GRANT SELECT, INSERT ON photo_analyses TO authenticated;
GRANT SELECT, INSERT ON email_unsubscribes TO authenticated;
GRANT SELECT, INSERT ON client_mood_history TO authenticated;
GRANT SELECT, INSERT ON error_logs TO authenticated;
