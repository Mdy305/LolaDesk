/**
 * /api/deposits — did every sale reach the bank? (owner only)
 *   GET ?days=30|90|365            → { connection, reconcile }
 *   GET ?payout=<id>               → that deposit, line by line (each sale with its client, fees, refunds)
 *   POST { action:'sync' }         → read Square now (sales, clients, deposits)
 */
import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db } from './lib/db.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no salon for this account' });
    const role = String(tenant.role || tenant.access_role || user.role || 'owner').toLowerCase();
    if (/staff|stylist|front/.test(role)) return res.status(403).json({ ok: false, error: 'Only the owner can see deposits.' });
    const c = db();
    if (!c) return res.status(503).json({ ok: false, error: 'database not configured' });
    const D = await import('./lib/square-deposits.js');
    const { data: integ } = await c.from('integrations').select('status,metadata').eq('tenant_id', tenant.id).eq('provider', 'square').maybeSingle().then((x) => x, () => ({ data: null }));
    const scopes = integ?.metadata?.scopes;
    const connection = !integ ? { connected: false, status: 'not_connected' }
      : { connected: integ.status === 'connected', status: integ.status, needs_reconnect: integ.status !== 'connected' || (Array.isArray(scopes) && !scopes.includes('PAYOUTS_READ')) };

    if (req.method === 'GET' && req.query?.payout) {
      const id = String(req.query.payout).slice(0, 80);
      const { data: p } = await c.from('salon_payouts').select('*').eq('tenant_id', tenant.id).eq('external_id', id).maybeSingle();
      if (!p) return res.status(404).json({ ok: false, error: 'Deposit not found.' });
      const { data: lines } = await c.from('salon_payout_entries').select('external_id,entry_type,effective_at,gross_cents,fee_cents,net_cents,payment_ref,refund_ref').eq('tenant_id', tenant.id).eq('payout_ref', id).limit(5000);
      const pay = [...new Set((lines || []).map((l) => l.payment_ref).filter(Boolean))];
      const { data: sales } = pay.length ? await c.from('salon_sales').select('external_id,customer_ref,client_id,day,net_cents').eq('tenant_id', tenant.id).in('external_id', pay.slice(0, 1000)) : { data: [] };
      const sale = new Map((sales || []).map((x) => [x.external_id, x]));
      const ids = [...new Set((sales || []).map((x) => x.client_id).filter(Boolean))];
      const { data: cl } = ids.length ? await c.from('clients').select('id,name,first_name,last_name').in('id', ids.slice(0, 1000)) : { data: [] };
      const nm = new Map((cl || []).map((x) => [x.id, x.name || [x.first_name, x.last_name].filter(Boolean).join(' ')]));
      return res.status(200).json({ ok: true, payout: { id: p.external_id, status: p.status, amount: p.amount_cents, fee: p.fee_cents, arrival_date: p.arrival_date, destination: p.destination_type, destination_ref: p.destination_ref, entries_net: p.entries_net_cents },
        lines: (lines || []).sort((a, b) => String(a.effective_at).localeCompare(String(b.effective_at))).map((l) => { const s = sale.get(l.payment_ref); return { type: l.entry_type, at: l.effective_at, gross: l.gross_cents, fee: l.fee_cents, net: l.net_cents, payment: l.payment_ref, client: s?.client_id ? nm.get(s.client_id) || null : null, client_id: s?.client_id || null, sale_day: s?.day || null }; }) });
    }
    if (req.method === 'GET') {
      const days = [30, 90, 365].includes(Number(req.query?.days)) ? Number(req.query.days) : 30;
      const r = await D.reconcile(c, tenant, { days });
      return res.status(200).json({ ok: true, connection, reconcile: r, say: D.sayDeposits(r) });
    }
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (body.action !== 'sync') return res.status(400).json({ ok: false, error: 'unknown action' });
      const { squareRows } = await import('./lib/square-care.js');
      const row = (await squareRows(c, { status: 'connected' })).find((x) => x.tenant_id === tenant.id);
      if (!row) return res.status(400).json({ ok: false, error: 'Connect Square first (Settings → Square).' });
      const { syncEverything } = await import('./lib/square-data.js');
      return res.status(200).json({ ok: true, ...(await syncEverything(c, row, { budgetMs: 22000 })) });
    }
    return res.status(405).json({ ok: false, error: 'GET or POST' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 200) });
  }
}
