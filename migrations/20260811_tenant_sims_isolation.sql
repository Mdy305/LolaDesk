-- Fixes a real cross-tenant data leak: api/telnyx-sims.js previously
-- returned Telnyx's entire, unfiltered sim_cards list to any
-- authenticated user, with no per-tenant tracking of SIM orders at all.
-- This table records which tenant each SIM order belongs to, the same
-- pattern already used for `integrations`.

CREATE TABLE IF NOT EXISTS tenant_sims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  telnyx_order_id text,
  telnyx_sim_id text,
  address_id text,
  quantity int DEFAULT 1,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenant_sims_tenant ON tenant_sims(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_sims_sim_id ON tenant_sims(telnyx_sim_id) WHERE telnyx_sim_id IS NOT NULL;
