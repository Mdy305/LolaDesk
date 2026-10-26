/**
 * /api/pos/reader — the front-desk card reader (lib/terminal.js).
 *   GET                                         → { readers, test_mode, card_fee }
 *   POST { action:'pair', code, label, address }
 *   POST { action:'remove', reader_id }
 *   POST { action:'status', payment_intent }    → paid | waiting | declined | canceled
 *   POST { action:'cancel', reader_id, payment_intent }
 *   POST { action:'simulate', reader_id }       (Stripe test keys only)
 */
import { bearer, getUserFromToken } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { db } from '../lib/db.js';
import { listReaders, pairReader, removeReader, saleStatus, cancelReaderSale, simulateTap, testMode } from '../lib/terminal.js';
import { paymentsFee, feeLabel } from '../lib/payments-fee.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });
    if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ ok: false, say: 'Payments aren’t set up on this server.' });
    const c = db();

    if (req.method === 'GET') {
      return res.json({ ok: true, readers: await listReaders(c, tenant), test_mode: testMode(), card_fee: feeLabel(paymentsFee()) });
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    let out;
    switch (b.action) {
      case 'pair': out = await pairReader(c, tenant, { code: b.code, label: b.label, address: b.address }); break;
      case 'remove': out = await removeReader(tenant, b.reader_id); break;
      case 'status': out = await saleStatus(c, tenant, b.payment_intent); break;
      case 'cancel': out = await cancelReaderSale(tenant, { readerId: b.reader_id, paymentIntentId: b.payment_intent }); break;
      case 'simulate': out = await simulateTap(tenant, b.reader_id); break;
      default: return res.status(400).json({ ok: false, error: 'unknown_action' });
    }
    return res.status(out.ok === false && !out.status ? 400 : 200).json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, say: `Stripe said: ${String(e?.message || e).slice(0, 160)}` });
  }
}
