// GET /api/cron/no-show-scan
// Vercel cron target. Scans bookings past their delay window and either
// marks them no_show or charges the no-show fee (if policy allows).
// Auth: header `x-vercel-cron: 1` OR `?secret=$CRON_SECRET`.
import { db } from '../lib/db.js';
import { previewPolicy } from '../lib/policies.js';
import { stripeFor, connectAccount } from '../lib/stripe.js';

function isAuthorized(req) {
  if (req.headers?.['x-vercel-cron']) return true;
  const secret = req.query?.secret || req.headers?.['x-cron-secret'];
  return secret && secret === process.env.CRON_SECRET;
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const c = db();
  const scannedAt = new Date();

  try {
    // Load all tenants with no-show policy enabled.
    const { data: policies } = await c.from('billing_policies')
      .select('tenant_id, no_show, auto_charge')
      .filter('no_show->enabled', 'eq', 'true');

    const results = [];

    for (const p of (policies || [])) {
      const delayMin = Number(p.no_show?.delay_minutes || 30);
      const cutoff = new Date(Date.now() - delayMin * 60 * 1000).toISOString();

      // Find bookings that are past their start + delay and still open.
      const { data: candidates } = await c.from('bookings')
        .select('id, tenant_id, client_id, service_id, start_time, total_amount, outcome')
        .eq('tenant_id', p.tenant_id)
        .lt('start_time', cutoff)
        .in('outcome', ['confirmed', 'pending', 'pending_payment']);

      for (const b of (candidates || [])) {
        // Mark no-show first.
        await c.from('bookings').update({ outcome: 'no_show' }).eq('id', b.id);

        // Bump client counter.
        if (b.client_id) {
          await c.rpc('increment_no_show', { p_client_id: b.client_id }).catch(() => {});
        }

        // Charge fee if auto-charge enabled.
        if (!p.auto_charge?.no_show_fee) {
          results.push({ booking_id: b.id, action: 'marked_no_show' });
          continue;
        }

        // Load service for override calc.
        const { data: service } = await c.from('services')
          .select('price, deposit_override_type, deposit_override_amount')
          .eq('id', b.service_id).maybeSingle();

        const preview = previewPolicy({
          policy: { no_show: p.no_show },
          service: {
            price_cents: Math.round(Number(service?.price || b.total_amount || 0) * 100)
          }
        });
        const feeCents = preview.no_show_cents || 0;
        if (feeCents === 0) {
          results.push({ booking_id: b.id, action: 'marked_no_show', reason: 'zero_fee' });
          continue;
        }

        // Attempt charge via saved payment method (requires prior deposit intent).
        const account = await connectAccount(b.tenant_id);
        if (!account?.charges_enabled) {
          results.push({ booking_id: b.id, action: 'marked_no_show', reason: 'stripe_not_connected' });
          continue;
        }

        const stripe = stripeFor(b.tenant_id, account.stripe_account_id);
        try {
          const intent = await stripe.createPaymentIntent({
            amount: feeCents,
            currency: 'usd',
            metadata: {
              booking_id: b.id,
              client_id: b.client_id || '',
              tenant_id: b.tenant_id,
              kind: 'no_show_fee'
            },
            description: 'No-show fee',
            confirm: true,
            off_session: true
          });
          await c.from('payments').insert({
            tenant_id: b.tenant_id,
            stripe_id: intent.id,
            kind: 'charge',
            sub_kind: 'no_show_fee',
            status: intent.status === 'succeeded' ? 'succeeded' : 'pending',
            amount: feeCents,
            currency: 'usd',
            client_id: b.client_id,
            booking_id: b.id,
            at_risk: intent.status !== 'succeeded'
          });
          results.push({ booking_id: b.id, action: 'charged', fee_cents: feeCents, status: intent.status });
        } catch (err) {
          results.push({ booking_id: b.id, action: 'charge_failed', error: String(err?.message || err) });
        }
      }
    }

    return res.json({ ok: true, scanned_at: scannedAt.toISOString(), processed: results.length, results });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
