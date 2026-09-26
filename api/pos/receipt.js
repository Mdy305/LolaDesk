// POST /api/pos/receipt
// Body: { sale_id, phone?, email? }
// Fetches the sale row and sends a short text receipt via SMS (Telnyx).
export default async function handler(req, res) {
  let cors, jsonBody, bearer, getUserFromToken, resolveTenantForUser, dbFn;
  try {
    ({ cors, jsonBody } = await import('../lib/cors.js'));
    ({ bearer, getUserFromToken } = await import('../lib/auth.js'));
    ({ resolveTenantForUser } = await import('../lib/tenant-access.js'));
    ({ db: dbFn } = await import('../lib/db.js'));
  } catch (e) { return res.status(500).json({ ok: false, error: 'import_failed', message: String(e?.message || e) }); }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    if (cors && cors(req, res)) return;
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const body = (jsonBody ? jsonBody(req) : null) || {};
    const phone = String(body.phone || '').trim();
    const email = String(body.email || '').trim();
    if (!phone && !email) return res.status(400).json({ ok: false, error: 'phone_or_email_required' });

    let sale = null;
    if (body.sale_id) {
      try {
        const { data } = await dbFn().from('pos_transactions').select('*').eq('id', body.sale_id).eq('tenant_id', tenant.id).maybeSingle();
        sale = data || null;
      } catch (_) {}
    }
    if (!sale) return res.status(404).json({ ok: false, error: 'sale_not_found' });

    const fmt = c => `$${(Math.max(0, c) / 100).toFixed(2)}`;
    const lines = [];
    lines.push(`${tenant.name || 'Salon'} — receipt`);
    for (const it of (sale.items || []).slice(0, 6)) lines.push(`${it.name} × ${it.qty}   ${fmt(it.price_cents * it.qty)}`);
    if ((sale.items || []).length > 6) lines.push(`+ ${(sale.items || []).length - 6} more`);
    lines.push(`—`);
    if (sale.tax_cents) lines.push(`Tax   ${fmt(sale.tax_cents)}`);
    if (sale.tip_cents) lines.push(`Tip   ${fmt(sale.tip_cents)}`);
    lines.push(`Total ${fmt(sale.total_cents)}`);

    const msg = lines.join('\n');

    let sent = { sms: false, email: false };
    if (phone) {
      try {
        const sms = await import('../lib/sms.js').catch(() => null);
        if (sms?.sendSms) {
          await sms.sendSms({ tenant, to: phone, body: msg });
          sent.sms = true;
        }
      } catch (e) { console.warn('[pos/receipt] sms failed', e?.message); }
    }
    // email delivery: leave for later once you plug in a template + sender.
    if (email) sent.email = false;

    return res.json({ ok: true, data: { sent, receipt: msg } });
  } catch (e) {
    console.error('[pos/receipt]', e?.message);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
