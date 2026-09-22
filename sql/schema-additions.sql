-- ═══════════════════════════════════════════════════════════════
-- LolaDesk — schema-additions.sql
-- Adds the tables + columns the new frontend surfaces need.
-- Every statement is IF NOT EXISTS / IF NOT EXISTS — idempotent.
-- Run this in Supabase → SQL Editor → New Query, then Execute.
-- ═══════════════════════════════════════════════════════════════

-- 1. billing_policies — one row per tenant. Powers banking-policies.html.
CREATE TABLE IF NOT EXISTS billing_policies (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  deposits JSONB NOT NULL DEFAULT '{"enabled":true,"type":"percent","amount":25,"premium_amount":50,"min_amount":15}'::jsonb,
  no_show JSONB NOT NULL DEFAULT '{"enabled":true,"type":"fixed","amount":50,"delay_minutes":30,"waive_first_offense":false}'::jsonb,
  late_cancel JSONB NOT NULL DEFAULT '{"enabled":true,"window_hours":24,"amount":25}'::jsonb,
  tips JSONB NOT NULL DEFAULT '{"enabled":true,"presets":[20,25,30,0],"default_index":1,"suggest_when":"all","base_on":"subtotal"}'::jsonb,
  auto_charge JSONB NOT NULL DEFAULT '{"deposit_on_booking":true,"no_show_fee":true,"late_cancel_fee":true,"retry_failed":true,"rebook_nudge":false}'::jsonb,
  currency TEXT NOT NULL DEFAULT 'usd',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. stripe_connect_accounts — per tenant. Powers banking.html connect flow.
CREATE TABLE IF NOT EXISTS stripe_connect_accounts (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_account_id TEXT UNIQUE NOT NULL,
  sub_state TEXT NOT NULL DEFAULT 'pending',
  charges_enabled BOOLEAN NOT NULL DEFAULT false,
  payouts_enabled BOOLEAN NOT NULL DEFAULT false,
  schedule JSONB NOT NULL DEFAULT '{"interval":"weekly","weekly_anchor":"friday"}'::jsonb,
  currency TEXT NOT NULL DEFAULT 'usd',
  destination_last4 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. payments — every charge / tip / deposit / refund / fee.
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_id TEXT UNIQUE,
  kind TEXT NOT NULL,
  sub_kind TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  amount INT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  stripe_fee INT NOT NULL DEFAULT 0,
  client_id UUID REFERENCES clients(id),
  client_phone TEXT,
  client_name TEXT,
  card_brand TEXT,
  card_last4 TEXT,
  receipt_number TEXT,
  receipt_url TEXT,
  description TEXT,
  booking_id UUID REFERENCES bookings(id),
  at_risk BOOLEAN NOT NULL DEFAULT false,
  refunded BOOLEAN NOT NULL DEFAULT false,
  retry_count INT NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS payments_tenant_created_idx ON payments(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_tenant_kind_idx ON payments(tenant_id, kind);
CREATE INDEX IF NOT EXISTS payments_at_risk_idx ON payments(tenant_id) WHERE at_risk = true;
CREATE INDEX IF NOT EXISTS payments_booking_idx ON payments(booking_id) WHERE booking_id IS NOT NULL;

-- 4. payment_links_sent — track outbound SMS payment links (recovery).
CREATE TABLE IF NOT EXISTS payment_links_sent (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payment_id UUID REFERENCES payments(id) ON DELETE CASCADE,
  stripe_payment_link_id TEXT,
  sent_to TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'sent'
);
CREATE INDEX IF NOT EXISTS payment_links_tenant_idx ON payment_links_sent(tenant_id, sent_at DESC);

-- 5. calendar_sync_credentials — per user (staff or owner).
CREATE TABLE IF NOT EXISTS calendar_sync_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  provider TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  scope TEXT,
  expires_at TIMESTAMPTZ,
  external_calendar_id TEXT,
  email TEXT,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, user_id, provider)
);

-- 6. Column additions to existing tables.

-- services
ALTER TABLE services
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS photo_url TEXT,
  ADD COLUMN IF NOT EXISTS buffer_after_min INT,
  ADD COLUMN IF NOT EXISTS deposit_override_type TEXT,
  ADD COLUMN IF NOT EXISTS deposit_override_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS tags TEXT[],
  ADD COLUMN IF NOT EXISTS sort_order INT DEFAULT 100;

-- staff
ALTER TABLE staff
  ADD COLUMN IF NOT EXISTS first_name TEXT,
  ADD COLUMN IF NOT EXISTS last_name TEXT,
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS color TEXT,
  ADD COLUMN IF NOT EXISTS services UUID[],
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS photo_url TEXT;

-- booking_settings — business hours + closures + reminder timing
ALTER TABLE booking_settings
  ADD COLUMN IF NOT EXISTS business_hours JSONB DEFAULT '{"mon":{"open":"10:00","close":"20:00","closed":false},"tue":{"open":"10:00","close":"20:00","closed":false},"wed":{"open":"10:00","close":"20:00","closed":false},"thu":{"open":"10:00","close":"20:00","closed":false},"fri":{"open":"10:00","close":"20:00","closed":false},"sat":{"open":"10:00","close":"20:00","closed":false},"sun":{"open":"10:00","close":"20:00","closed":true}}'::jsonb,
  ADD COLUMN IF NOT EXISTS closures TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS reminder_lead_hours INT DEFAULT 24,
  ADD COLUMN IF NOT EXISTS rebook_followup_days INT DEFAULT 28;

-- clients — waiver + counters
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS rebook_nudge_opt_out BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS no_show_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS visit_count INT NOT NULL DEFAULT 0;

-- 7. Row-level security.
-- Service role bypasses RLS, so this is safety net for when the anon key
-- is used from the browser directly (recommended future migration).
ALTER TABLE billing_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_connect_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_links_sent ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_sync_credentials ENABLE ROW LEVEL SECURITY;

-- A helper view of the current user → tenant relation. Assumes you have
-- a tenant_members table already. If your table is named differently
-- (e.g. tenant_users), swap the name in the policies below.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'billing_policies_tenant_isolation') THEN
    CREATE POLICY billing_policies_tenant_isolation ON billing_policies
      USING (tenant_id IN (SELECT tenant_id FROM tenant_members WHERE user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'stripe_connect_tenant_isolation') THEN
    CREATE POLICY stripe_connect_tenant_isolation ON stripe_connect_accounts
      USING (tenant_id IN (SELECT tenant_id FROM tenant_members WHERE user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'payments_tenant_isolation') THEN
    CREATE POLICY payments_tenant_isolation ON payments
      USING (tenant_id IN (SELECT tenant_id FROM tenant_members WHERE user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'payment_links_tenant_isolation') THEN
    CREATE POLICY payment_links_tenant_isolation ON payment_links_sent
      USING (tenant_id IN (SELECT tenant_id FROM tenant_members WHERE user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'calendar_sync_tenant_isolation') THEN
    CREATE POLICY calendar_sync_tenant_isolation ON calendar_sync_credentials
      USING (tenant_id IN (SELECT tenant_id FROM tenant_members WHERE user_id = auth.uid()));
  END IF;
END $$;

-- 8. Seed billing_policies for every existing tenant (idempotent).
INSERT INTO billing_policies (tenant_id)
SELECT id FROM tenants
ON CONFLICT (tenant_id) DO NOTHING;

-- Done.
SELECT
  (SELECT COUNT(*) FROM billing_policies) AS billing_policies_count,
  (SELECT COUNT(*) FROM stripe_connect_accounts) AS stripe_connect_count,
  (SELECT COUNT(*) FROM payments) AS payments_count;
