// POST /api/stripe/payments/:id/refund
export default async function handler(req, res) {
  let cors, jsonBody, bearer, getUserFromToken, resolveTenantForUser, connectAccount, stripeFor;
  try {
    ({ cors, jsonBody } = await import('../../../lib/cors.js'));
    ({ bearer, getUserFromToken } = await import('../../../lib/auth.js'));
    ({ resolveTenantForUser } = await import('../../../lib/tenant-access.js'));
    ({ connectAccount, stripeFor } = await import('../../../lib/stripe.js'));
  } catch (e) { return res.status(500).json({ ok: false, error: 'import_failed', message: String(e?.message || e) }); }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    if (cors && cors(req, res)) return;
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });
    const account = await connectAccount(tenant.id);
    if (!account) return res.status(400).json({ ok: false, error: 'not_connected' });

    const id = String(req.query.id || '').trim();
    if (!id.startsWith('pi_')) return res.status(400).json({ ok: false, error: 'bad_id', hint: 'expects a PaymentIntent id (pi_...)' });

    const body = (jsonBody ? jsonBody(req) : null) || {};
    const s = stripeFor(tenant.id, account.stripe_account_id);

    const pi = await s.retrievePaymentIntent(id);
    const meta = pi?.metadata || {};
    if (meta.tenant_id && meta.tenant_id !== tenant.id) return res.status(403).json({ ok: false, error: 'forbidden' });

    const opts = {};
    if (Number.isFinite(+body.amount) && +body.amount > 0) opts.amount = parseInt(body.amount, 10);
    if (body.reason) opts.reason = String(body.reason);

    const refund = await s.refund(id, opts);
    return res.json({ ok: true, data: {
      id: refund.id, amount: refund.amount, currency: refund.currency,
      status: refund.status, reason: refund.reason, payment_intent: refund.payment_intent, created: refund.created
    }});
  } catch (e) { return res.status(500).json({ ok: false, error: String(e?.message || e) }); }
}
