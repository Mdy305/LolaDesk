-- billing_policies: one row per tenant carrying the JSON policy blob.
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS billing_policies (
  tenant_id   uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  policies    jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid NULL
);

CREATE INDEX IF NOT EXISTS billing_policies_updated_at_idx
  ON billing_policies (updated_at DESC);

-- RLS: only members of the tenant can read or write their row.
ALTER TABLE billing_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS billing_policies_read  ON billing_policies;
DROP POLICY IF EXISTS billing_policies_write ON billing_policies;

CREATE POLICY billing_policies_read ON billing_policies
  FOR SELECT USING (
    tenant_id IN (SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid())
  );

CREATE POLICY billing_policies_write ON billing_policies
  FOR ALL USING (
    tenant_id IN (SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid())
  )
  WITH CHECK (
    tenant_id IN (SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid())
  );
