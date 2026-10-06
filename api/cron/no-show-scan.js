// GET /api/cron/no-show-scan  (every 15 minutes)
// The salon's no-show fee, collected kindly and only when it's real.
//
// Lola NEVER decides someone was a no-show: a visit that simply wasn't checked
// out is not a no-show. Only a booking the salon marked "no-show" (status
// no_show) is considered. If the salon's policy (Settings → Booking rules /
// Banking → Policies — one source: booking_settings.metadata.deposits) has the
// no-show fee ON with "charge automatically", the client gets ONE text with a
// secure Stripe link for the fee (paid to the salon's connected account).
// Idempotent: a payments row per booking (sub_kind no_show_fee) means done.
// Auth: `Authorization: Bearer $CRON_SECRET` only (Vercel Cron sends it).
import { db } from '../lib/db.js';
import { cronAuthorized } from '../lib/cron-auth.js';
import { readSalonPolicies } from '../lib/salon-policies.js';

const LOOKBACK_DAYS = 3;

export function noShowFeeCents(policy, servicePrice, depositPaid = 0) {
  const p = policy || {};
  if (!p.enabled) return 0;
  const price = Number(servicePrice || 0);
  let dollars;
  if (p.type === 'full') dollars = price - Number(depositPaid || 0);
  else if (p.type === 'percent') dollars = price * Number(p.amount || 0) / 100;
  else dollars = Number(p.amount || 0);
  return Math.max(0, Math.round(dollars * 100));
}

export default async function handler(req, res) {
  if (!cronAuthorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const c = db();
  if (!c) return res.status(503).json({ ok: false, error: 'database not configured' });
  const results = [];
  try {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 864e5).toISOString();
    const { data: marked } = await c.from('bookings')
      .select('id,tenant_id,client_id,service_id,start_time,total_amount,status')
      .in('status', ['no_show', 'no-show']).gte('start_time', since).limit(500);
    const byTenant = {};
    for (const b of marked || []) (byTenant[b.tenant_id] ||= []).push(b);

    for (const [tenantId, list] of Object.entries(byTenant)) {
      let pol;
      try { pol = await readSalonPolicies(c, tenantId); } catch (_) { continue; }
      if (!pol?.no_show?.enabled || !pol?.auto_charge?.no_show_fee) continue;
      const { data: tenant } = await c.from('tenants').select('id,name,phone_number').eq('id', tenantId).maybeSingle();
      if (!tenant?.phone_number) continue;

      for (const b of list) {
        const { data: done } = await c.from('payments').select('id').eq('booking_id', b.id).eq('sub_kind', 'no_show_fee').limit(1);
        if (done && done.length) continue;
        const { data: client } = b.client_id ? await c.from('clients').select('id,name,phone,no_show_count').eq('id', b.client_id).maybeSingle() : { data: null };
        if (!client?.phone) { results.push({ booking_id: b.id, action: 'skipped', reason: 'no_client_phone' }); continue; }
        if (pol.no_show.waive_first_offense) {
          const { data: prior } = await c.from('bookings').select('id').eq('tenant_id', tenantId).eq('client_id', client.id).in('status', ['no_show', 'no-show']).lt('start_time', b.start_time).limit(1);
          if (!prior || !prior.length) {
            await c.from('payments').insert({ tenant_id: tenantId, kind: 'charge', sub_kind: 'no_show_fee', status: 'waived', amount: 0, currency: 'usd', client_id: client.id, booking_id: b.id }).then(() => {}, () => {});
            results.push({ booking_id: b.id, action: 'waived_first_offense' });
            continue;
          }
        }
        const { data: svc } = b.service_id ? await c.from('services').select('name,price').eq('id', b.service_id).maybeSingle() : { data: null };
        const { data: dep } = await c.from('deposits').select('amount,status').eq('booking_id', b.id).maybeSingle();
        const cents = noShowFeeCents(pol.no_show, svc?.price ?? b.total_amount, ['paid', 'kept'].includes(dep?.status) ? dep.amount : 0);
        if (!cents) { results.push({ booking_id: b.id, action: 'skipped', reason: 'zero_fee' }); continue; }
        // Claim first (pending row) so two overlapping runs never text twice.
        const { data: claim, error: claimErr } = await c.from('payments').insert({ tenant_id: tenantId, kind: 'charge', sub_kind: 'no_show_fee', status: 'pending', amount: cents, currency: 'usd', client_id: client.id, booking_id: b.id }).select('id').maybeSingle();
        if (claimErr || !claim?.id) { results.push({ booking_id: b.id, action: 'skipped', reason: 'claim_failed' }); continue; }
        try {
          if (!process.env.STRIPE_SECRET_KEY) throw new Error('stripe_not_configured');
          const { createPaymentLink } = await import('../lib/stripe.js');
          const link = await createPaymentLink({ amountCents: cents, description: `Missed appointment fee — ${tenant.name || 'the salon'}`, tenantId, metadata: { booking_id: String(b.id), kind: 'no_show_fee' } });
          await c.from('payments').update({ stripe_id: link.id }).eq('id', claim.id);
          const { sendSMS } = await import('../lib/sms.js');
          const first = String(client.name || '').split(' ')[0] || 'there';
          await sendSMS({ from: tenant.phone_number, to: client.phone, tenantId, type: 'SMS',
            text: `Hi ${first}, we missed you at ${tenant.name || 'the salon'}. Per our booking policy there's a $${(cents / 100).toFixed(2)} missed-appointment fee — you can pay it securely here: ${link.url}  Reply here to rebook anytime. Reply STOP to opt out.` });
          results.push({ booking_id: b.id, action: 'fee_link_sent', fee_cents: cents });
        } catch (e) {
          await c.from('payments').update({ status: 'failed', at_risk: true }).eq('id', claim.id).then(() => {}, () => {});
          results.push({ booking_id: b.id, action: 'failed', error: String(e?.message || e).slice(0, 160) });
        }
      }
    }
    return res.json({ ok: true, processed: results.length, results });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
