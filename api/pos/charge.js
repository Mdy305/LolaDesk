// POST /api/pos/charge
// Body: { items, subtotal_cents, tax_cents, tip_cents, total_cents, payment_method: 'card'|'link', client, delivery? }
// For 'card' → creates a PaymentIntent on the tenant's connected Stripe account.
// For 'link' → creates a Stripe Payment Link and SMS/emails it to the client.
export default async function handler(req, res) {
  let cors, jsonBody, bearer, getUserFromToken, resolveTenantForUser, dbFn, stripeFor, connectAccount;
  try {
    ({ cors, jsonBody } = await import('../lib/cors.js'));
    ({ bearer, getUserFromToken } = await import('../lib/auth.js'));
    ({ resolveTenantForUser } = await import('../lib/tenant-access.js'));
    ({ db: dbFn } = await import('../lib/db.js'));
    ({ stripeFor, connectAccount } = await import('../lib/stripe.js'));
  } catch (e) { return res.status(500).json({ ok: false, error: 'import_failed', message: String(e?.message || e) }); }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    if (cors && cors(req, res)) return;
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const body = (jsonBody ? jsonBody(req) : null) || {};
    const items = Array.isArray(body.items) ? body.items : [];
    const total = parseInt(body.total_cents, 10) || 0;
    if (total < 50) return res.status(400).json({ ok: false, error: 'total_too_small' });
    const method = (body.payment_method || 'card').toLowerCase();
    const client = body.client || null;

    const account = await connectAccount(tenant.id);
    if (!account) return res.status(400).json({ ok: false, error: 'not_connected', hint: 'Connect Stripe in Banking first.' });

    const s = stripeFor(tenant.id, account.stripe_account_id);
    const description = items.slice(0, 3).map(i => i.name).join(', ') + (items.length > 3 ? ` +${items.length - 3}` : '');
    const metadata = {
      tenant_id: tenant.id,
      pos_sale: 'true',
      payment_method: method,
      subtotal_cents: String(body.subtotal_cents || 0),
      tax_cents: String(body.tax_cents || 0),
      tip_cents: String(body.tip_cents || 0),
      total_cents: String(total),
      client_id: client?.id || '',
      client_name: (client?.name || 'Walk-in').slice(0, 128),
    };

    let saleId = null, stripeId = null, url = null;

    if (method === 'link') {
      // Create a Stripe Payment Link + deliver it
      const line_items = items.map(i => ({
        quantity: i.qty,
        price_data: {
          currency: 'usd',
          product_data: { name: i.name },
          unit_amount: i.price_cents,
        }
      }));
      // Tax + tip added as ad-hoc line items
      if (parseInt(body.tax_cents, 10) > 0) {
        line_items.push({ quantity: 1, price_data: { currency: 'usd', product_data: { name: 'Tax' }, unit_amount: body.tax_cents } });
      }
      if (parseInt(body.tip_cents, 10) > 0) {
        line_items.push({ quantity: 1, price_data: { currency: 'usd', product_data: { name: 'Tip' }, unit_amount: body.tip_cents } });
      }
      const link = await s.paymentLink(line_items, { metadata });
      stripeId = link.id;
      url = link.url;
    } else {
      // Card / Tap-to-Pay via a PaymentIntent — front-end will confirm via Stripe Terminal or Payment Element.
      const pi = await s.createPaymentIntent({
        amount: total,
        currency: 'usd',
        description,
        metadata,
        confirm: false,   // client confirms at the reader
      });
      stripeId = pi.id;
    }

    // Ledger row
    try {
      const { data: inserted, error } = await dbFn().from('pos_transactions').insert({
        tenant_id: tenant.id,
        stripe_id: stripeId,
        payment_method: method,
        subtotal_cents: parseInt(body.subtotal_cents, 10) || 0,
        tax_cents: parseInt(body.tax_cents, 10) || 0,
        tip_cents: parseInt(body.tip_cents, 10) || 0,
        total_cents: total,
        items,
        client_id: client?.id || null,
        client_name: client?.name || null,
        client_phone: client?.phone || null,
        client_email: client?.email || null,
        status: method === 'link' ? 'pending_link' : 'pending_card',
        cashier_user_id: user.id || null,
        payment_link_url: url,
      }).select().single();
      if (error) throw error;
      saleId = inserted.id;
    } catch (e) {
      console.warn('[pos/charge] ledger insert failed', e?.message);
    }

    // If link mode, fire off delivery best-effort
    if (method === 'link' && url) {
      const delivery = body.delivery || {};
      try {
        if (delivery.phone) {
          const sms = await import('../lib/sms.js').catch(() => null);
          if (sms?.sendSms) await sms.sendSms({ tenant, to: delivery.phone, body: `Your payment: ${url}` });
        }
      } catch (_) {}
      // email delivery could go here if you have api/lib/email-templates.js + a sender.
    }

    return res.json({ ok: true, data: { id: saleId, stripe_id: stripeId, url, method } });
  } catch (e) {
    console.error('[pos/charge]', e?.message);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
