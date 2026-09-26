// GET /api/stripe/payments/:id
export default async function handler(req, res) {
  let cors, bearer, getUserFromToken, resolveTenantForUser, connectAccount, stripeFor;
  try {
    ({ cors } = await import('../../../lib/cors.js'));
    ({ bearer, getUserFromToken } = await import('../../../lib/auth.js'));
    ({ resolveTenantForUser } = await import('../../../lib/tenant-access.js'));
    ({ connectAccount, stripeFor } = await import('../../../lib/stripe.js'));
  } catch (e) { return res.status(500).json({ ok: false, error: 'import_failed', message: String(e?.message || e) }); }

  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    if (cors && cors(req, res)) return;
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });
    const account = await connectAccount(tenant.id);
    if (!account) return res.status(400).json({ ok: false, error: 'not_connected' });

    const id = String(req.query.id || '').trim();
    if (!id.startsWith('pi_') && !id.startsWith('ch_')) return res.status(400).json({ ok: false, error: 'bad_id' });

    const s = stripeFor(tenant.id, account.stripe_account_id);
    const pi = id.startsWith('pi_')
      ? await s.retrievePaymentIntent(id)
      : await s.raw.charges.retrieve(id, { stripeAccount: account.stripe_account_id });

    const meta = pi?.metadata || {};
    if (meta.tenant_id && meta.tenant_id !== tenant.id) return res.status(403).json({ ok: false, error: 'forbidden' });

    let refunds = [];
    try {
      const list = await s.raw.refunds.list(
        { payment_intent: id.startsWith('pi_') ? id : undefined, charge: id.startsWith('ch_') ? id : undefined, limit: 20 },
        { stripeAccount: account.stripe_account_id }
      );
      refunds = list.data || [];
    } catch (_) {}

    return res.json({
      ok: true,
      data: {
        id: pi.id, amount: pi.amount,
        amount_received: pi.amount_received ?? pi.amount_captured ?? pi.amount,
        currency: pi.currency, status: pi.status, description: pi.description || '', created: pi.created,
        customer: pi.customer || null, receipt_email: pi.receipt_email || null,
        latest_charge: pi.latest_charge || null, metadata: meta,
        refunds: refunds.map(r => ({ id: r.id, amount: r.amount, reason: r.reason, status: r.status, created: r.created }))
      }
    });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e?.message || e) }); }
}
