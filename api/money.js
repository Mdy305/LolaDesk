/**
 * /api/money — the Payments home.
 *   GET                                   → moneySnapshot (lib/money.js) + LolaDesk's card fee label
 *   GET ?view=transactions&range=today|7d|30d → every payment, in detail (from Stripe)
 *   POST { action:'payout' }              → send what's ready to the bank (instant when possible)
 *   POST { action:'refund', payment_intent } → refund one payment in full
 */
import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { getBookingSettings } from './lib/booking-repository.js';
import { moneySnapshot, payOut, listTransactions, refundTransaction } from './lib/money.js';
import { paymentsFee, feeLabel } from './lib/payments-fee.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    if (req.method === 'GET' && (req.query?.view === 'transactions')) {
      let tz = 'America/New_York';
      try { tz = (await getBookingSettings(tenant.id))?.timezone || tz; } catch (_) {}
      const range = String(req.query.range || 'today');
      const since = range === '30d' ? new Date(Date.now() - 30 * 864e5) : range === '7d' ? new Date(Date.now() - 7 * 864e5) : salonMidnight(tz);
      return res.json(await listTransactions(tenant.id, { since }));
    }
    if (req.method === 'GET') {
      let tz = 'America/New_York';
      try { tz = (await getBookingSettings(tenant.id))?.timezone || tz; } catch (_) {}
      const snap = await moneySnapshot(tenant.id, { tz });
      return res.json({ ...snap, card_fee: feeLabel(paymentsFee()) });
    }
    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (b.action === 'refund') {
        // The page asks twice before sending this; Stripe's idempotency key makes a double tap harmless.
        const out = await refundTransaction(tenant.id, b.payment_intent);
        return res.status(out.ok ? 200 : 400).json(out);
      }
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

// Midnight today in the salon's time zone.
function salonMidnight(tz) {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const g = (t) => Number(parts.find((p) => p.type === t)?.value) || 0;
    return new Date(now.getTime() - ((g('hour') * 60 + g('minute')) * 60 + g('second')) * 1000);
  } catch (_) { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
}
