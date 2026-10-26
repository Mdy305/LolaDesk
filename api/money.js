/**
 * /api/money — the Payments home.
 *   GET                      → moneySnapshot (lib/money.js) + LolaDesk's card fee label
 *   POST { action:'payout' } → send what's ready to the bank (instant when possible)
 */
import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { getBookingSettings } from './lib/booking-repository.js';
import { moneySnapshot, payOut } from './lib/money.js';
import { paymentsFee, feeLabel } from './lib/payments-fee.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    if (req.method === 'GET') {
      let tz = 'America/New_York';
      try { tz = (await getBookingSettings(tenant.id))?.timezone || tz; } catch (_) {}
      const snap = await moneySnapshot(tenant.id, { tz });
      return res.json({ ...snap, card_fee: feeLabel(paymentsFee()) });
    }
    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (b.action !== 'payout') return res.status(400).json({ ok: false, error: 'unknown_action' });
      // One tap = one payout: the same request id never sends twice.
      const key = b.request_id ? `payout_${tenant.id}_${String(b.request_id).slice(0, 64)}` : null;
      const out = await payOut(tenant.id, { idempotencyKey: key });
      return res.status(out.ok ? 200 : 400).json(out);
    }
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
