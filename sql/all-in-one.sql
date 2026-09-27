-- LolaDesk all-in-one migration. Safe to re-run.

-- ===================== Services =====================
CREATE TABLE IF NOT EXISTS services (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name              text NOT NULL,
  category          text,
  duration_minutes  int  NOT NULL DEFAULT 60,
  price_cents       int  NOT NULL DEFAULT 0,
  deposit_cents     int  NOT NULL DEFAULT 0,
  buffer_minutes    int  NOT NULL DEFAULT 0,
  description       text,
  active            boolean NOT NULL DEFAULT true,
  online_bookable   boolean NOT NULL DEFAULT true,
  staff_only        boolean NOT NULL DEFAULT false,
  sort_order        int NOT NULL DEFAULT 0,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS services_tenant_idx ON services (tenant_id, active);
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS svc_read  ON services;
DROP POLICY IF EXISTS svc_write ON services;
CREATE POLICY svc_read  ON services FOR SELECT USING (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid()));
CREATE POLICY svc_write ON services FOR ALL    USING (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid()))
                                              WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid()));

-- ===================== Staff (team) =====================
CREATE TABLE IF NOT EXISTS staff_members (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name           text NOT NULL,
  role           text NOT NULL DEFAULT 'Stylist',
  phone          text,
  email          text,
  color          text,
  commission_pct int  NOT NULL DEFAULT 0,
  working_days   jsonb NOT NULL DEFAULT '[]'::jsonb,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_tenant_idx ON staff_members (tenant_id, active);
ALTER TABLE staff_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stf_read  ON staff_members;
DROP POLICY IF EXISTS stf_write ON staff_members;
CREATE POLICY stf_read  ON staff_members FOR SELECT USING (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid()));
CREATE POLICY stf_write ON staff_members FOR ALL    USING (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid()))
                                                   WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid()));

-- ===================== Reviews =====================
CREATE TABLE IF NOT EXISTS reviews (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_id  text,
  source       text NOT NULL DEFAULT 'manual',   -- google | yelp | website | manual
  author       text,
  body         text,
  rating       int,
  reply        text,
  replied_at   timestamptz,
  replied_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reviews_tenant_idx ON reviews (tenant_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS reviews_external_uk ON reviews (tenant_id, source, external_id) WHERE external_id IS NOT NULL;
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rv_read  ON reviews;
DROP POLICY IF EXISTS rv_write ON reviews;
CREATE POLICY rv_read  ON reviews FOR SELECT USING (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid()));
CREATE POLICY rv_write ON reviews FOR ALL    USING (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid()))
                                              WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid()));

-- ===================== Inventory =====================
CREATE TABLE IF NOT EXISTS inventory_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text NOT NULL,
  brand        text,
  sku          text,
  price_cents  int  NOT NULL DEFAULT 0,
  cost_cents   int  NOT NULL DEFAULT 0,
  stock        int  NOT NULL DEFAULT 0,
  min_stock    int  NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inventory_tenant_idx ON inventory_items (tenant_id);
ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS iv_read  ON inventory_items;
DROP POLICY IF EXISTS iv_write ON inventory_items;
CREATE POLICY iv_read  ON inventory_items FOR SELECT USING (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid()));
CREATE POLICY iv_write ON inventory_items FOR ALL    USING (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid()))
                                                      WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid()));

-- ===================== Referrals =====================
CREATE TABLE IF NOT EXISTS referrals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  referrer_client_id uuid,
  referred_client_id uuid,
  status             text NOT NULL DEFAULT 'pending', -- pending | earned | redeemed
  reward_cents       int NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS referrals_tenant_idx ON referrals (tenant_id, created_at DESC);
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rf_read  ON referrals;
DROP POLICY IF EXISTS rf_write ON referrals;
CREATE POLICY rf_read  ON referrals FOR SELECT USING (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid()));
CREATE POLICY rf_write ON referrals FOR ALL    USING (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid()))
                                                WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid()));

-- ===================== Tenant meta extensions =====================
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS working_hours       jsonb;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS lead_max_days       int  NOT NULL DEFAULT 60;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS lead_min_hours      int  NOT NULL DEFAULT 2;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS slot_minutes        int  NOT NULL DEFAULT 30;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS auto_confirm        boolean NOT NULL DEFAULT true;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS forward_after_hours boolean NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS record_calls        boolean NOT NULL DEFAULT true;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS brand_color         text;

-- ===================== Client waitlist flag =====================
ALTER TABLE clients ADD COLUMN IF NOT EXISTS on_waitlist boolean NOT NULL DEFAULT false;
