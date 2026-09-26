-- pos_transactions: every register sale, one row.
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS pos_transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_id       text,                       -- PaymentIntent id or Payment Link id
  payment_method  text NOT NULL,              -- 'card' | 'cash' | 'link'
  status          text NOT NULL DEFAULT 'pending', -- 'pending_card' | 'pending_link' | 'paid' | 'refunded' | 'canceled' | 'failed'
  subtotal_cents  int  NOT NULL DEFAULT 0,
  tax_cents       int  NOT NULL DEFAULT 0,
  tip_cents       int  NOT NULL DEFAULT 0,
  total_cents     int  NOT NULL,
  cash_given_cents  int,
  cash_change_cents int,
  items           jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{ id, name, sub, kind, qty, price_cents }]
  client_id       uuid,
  client_name     text,
  client_phone    text,
  client_email    text,
  cashier_user_id uuid,
  payment_link_url text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  paid_at         timestamptz,
  refunded_at     timestamptz,
  refunded_amount_cents int
);

CREATE INDEX IF NOT EXISTS pos_transactions_tenant_created_idx
  ON pos_transactions (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pos_transactions_stripe_id_idx
  ON pos_transactions (stripe_id);
CREATE INDEX IF NOT EXISTS pos_transactions_client_id_idx
  ON pos_transactions (client_id) WHERE client_id IS NOT NULL;

-- RLS: tenant members can see and write their own sales.
ALTER TABLE pos_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pos_transactions_read  ON pos_transactions;
DROP POLICY IF EXISTS pos_transactions_write ON pos_transactions;

CREATE POLICY pos_transactions_read ON pos_transactions
  FOR SELECT USING (
    tenant_id IN (SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid())
  );

CREATE POLICY pos_transactions_write ON pos_transactions
  FOR ALL USING (
    tenant_id IN (SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid())
  )
  WITH CHECK (
    tenant_id IN (SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid())
  );
