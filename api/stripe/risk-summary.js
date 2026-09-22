// GET /api/stripe/risk-summary — surfaces revenue-at-risk on banking.html
// and the "Lola recovered" tile on revenue.html.
import { cors } from '../lib/cors.js';
import { bearer, getUserFromToken } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { db } from '../lib/db.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const c = db();

    // Unpaid fees + unclaimed deposits — at_risk=true rows are the recovery hunt list.
    const { data: atRisk } = await c.from('payments')
      .select('kind, amount')
      .eq('tenant_id', tenant.id)
      .eq('at_risk', true);
    const rows = atRisk || [];

    const unpaid_fees_rows = rows.filter(p => p.kind === 'fee');
    const unclaimed_deposit_rows = rows.filter(p => p.kind === 'deposit');

    const unpaid_fees = {
      count: unpaid_fees_rows.length,
      total: unpaid_fees_rows.reduce((s,p) => s + Number(p.amount||0), 0)
    };
    const unclaimed_deposits = {
      count: unclaimed_deposit_rows.length,
      total: unclaimed_deposit_rows.reduce((s,p) => s + Number(p.amount||0), 0)
    };

    const at_risk_total = unpaid_fees.total + unclaimed_deposits.total;

    // "recovered_total" = fees that were charged successfully last 30 days
    // (money Lola pulled back from would-be no-shows). Powers the revenue.html
    // "Lola recovered" hero tile.
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data: recovered } = await c.from('payments')
      .select('amount')
      .eq('tenant_id', tenant.id)
      .eq('kind', 'fee')
      .eq('status', 'succeeded')
      .gte('created_at', since);
    const recovered_total = (recovered || []).reduce((s,p) => s + Number(p.amount||0), 0);

    return res.json({
      ok: true,
      currency: 'usd',
      unpaid_fees,
      unclaimed_deposits,
      at_risk_total,
      recovered_total
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
