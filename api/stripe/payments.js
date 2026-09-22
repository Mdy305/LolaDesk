// GET /api/stripe/payments?range=7d|30d|90d|ytd|all&filter=all|at_risk&q=...
// Lists payments for banking-payments.html.
import { cors } from '../lib/cors.js';
import { bearer, getUserFromToken } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { db } from '../lib/db.js';

const RANGES = { '7d':7, '30d':30, '90d':90 };

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const q = req.query || {};
    const range = String(q.range || '30d');
    const filter = String(q.filter || 'all');
    const search = String(q.q || '').trim().toLowerCase();
    const limit = Math.min(500, Number(q.limit) || 200);

    let since;
    if (range === 'all') since = new Date(0);
    else if (range === 'ytd') since = new Date(new Date().getFullYear(), 0, 1);
    else since = new Date(Date.now() - (RANGES[range] || 30) * 86400000);

    const c = db();
    let query = c.from('payments')
      .select('id, stripe_id, kind, sub_kind, status, amount, currency, stripe_fee, client_id, client_phone, client_name, card_brand, card_last4, receipt_number, receipt_url, description, booking_id, at_risk, refunded, created_at')
      .eq('tenant_id', tenant.id)
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: false })
      .limit(limit);

    if (filter === 'at_risk') query = query.eq('at_risk', true);

    const { data, error } = await query;
    if (error) throw error;

    let list = data || [];

    // Server-side search: name/description/receipt/amount
    if (search) {
      list = list.filter(p => (
        String(p.client_name||'').toLowerCase().includes(search) ||
        String(p.description||'').toLowerCase().includes(search) ||
        String(p.receipt_number||'').toLowerCase().includes(search) ||
        String((Number(p.amount||0)/100).toFixed(2)).includes(search)
      ));
    }

    // Frontend expects "client" not "client_name" as a display alias
    const rows = list.map(p => ({
      id: p.id,
      kind: p.kind,
      sub_kind: p.sub_kind,
      status: p.status,
      amount: p.amount,
      currency: p.currency,
      stripe_fee: p.stripe_fee,
      client: p.client_name,
      client_phone: p.client_phone,
      card_brand: p.card_brand,
      card_last4: p.card_last4,
      receipt_number: p.receipt_number,
      receipt_url: p.receipt_url,
      description: p.description,
      booking_id: p.booking_id,
      at_risk: p.at_risk,
      refunded: p.refunded,
      created_at: p.created_at
    }));

    return res.json({ ok: true, payments: rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
