// POST /api/widget/book
// { tenant, service_id, staff_id, start_iso, client: { first_name, last_name, phone, email } }
// Creates a booking and (if deposit policy is on) a Stripe PaymentIntent for the deposit.
// PUBLIC — no bearer token. Rate-limited by tenant+phone.
import { corsPublic, jsonBody } from '../lib/cors.js';
import { db } from '../lib/db.js';
import { resolveTenantFromRequest } from '../lib/widget-tenant.js';
import { previewPolicy } from '../lib/policies.js';
import { stripeFor, connectAccount } from '../lib/stripe.js';

export default async function handler(req, res) {
  if (corsPublic(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    const tenant = await resolveTenantFromRequest(req);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const body = jsonBody(req);
    const { service_id, staff_id, start_iso, client } = body;
    if (!service_id || !start_iso || !client?.phone) {
      return res.status(400).json({ ok: false, error: 'missing_fields' });
    }

    const c = db();

    // Fetch service + policies.
    const [{ data: service }, { data: policy }] = await Promise.all([
      c.from('services')
        .select('id, name, duration_min, price, currency, deposit_override_type, deposit_override_amount')
        .eq('id', service_id).eq('tenant_id', tenant.id).maybeSingle(),
      c.from('billing_policies').select('*').eq('tenant_id', tenant.id).maybeSingle()
    ]);
    if (!service) return res.status(404).json({ ok: false, error: 'service_not_found' });

    // Upsert client by phone.
    let { data: existing } = await c.from('clients')
      .select('id, first_name, last_name, name, email')
      .eq('tenant_id', tenant.id)
      .eq('phone', client.phone)
      .maybeSingle();
    let clientRow = existing;
    if (!clientRow) {
      const { data: inserted } = await c.from('clients').insert({
        tenant_id: tenant.id,
        first_name: client.first_name || null,
        last_name: client.last_name || null,
        name: [client.first_name, client.last_name].filter(Boolean).join(' ') || null,
        phone: client.phone,
        email: client.email || null
      }).select().single();
      clientRow = inserted;
    }

    // Compute end_time.
    const startTime = new Date(start_iso);
    const durationMin = Number(service.duration_min || 60);
    const endTime = new Date(startTime.getTime() + durationMin * 60000);

    // Compute deposit if policy on.
    let depositCents = 0;
    if (policy?.deposits?.enabled) {
      const preview = previewPolicy({
        policy,
        service: {
          price_cents: Math.round(Number(service.price || 0) * 100),
          deposit_override_type: service.deposit_override_type,
          deposit_override_amount: service.deposit_override_amount
        }
      });
      depositCents = preview.deposit_cents || 0;
    }

    // Create booking (pending payment if deposit required).
    const { data: booking, error: bookErr } = await c.from('bookings').insert({
      tenant_id: tenant.id,
      client_id: clientRow.id,
      service_id: service.id,
      staff_id: staff_id || null,
      start_time: startTime.toISOString(),
      end_time: endTime.toISOString(),
      total_amount: Number(service.price || 0),
      deposit_amount_cents: depositCents,
      outcome: depositCents > 0 ? 'pending_payment' : 'confirmed',
      source: 'widget',
      created_at: new Date().toISOString()
    }).select().single();
    if (bookErr) throw bookErr;

    // If no deposit, we're done.
    if (depositCents === 0) {
      return res.json({
        ok: true,
        booking: { id: booking.id, start_time: booking.start_time, end_time: booking.end_time },
        payment_required: false
      });
    }

    // Create Stripe PaymentIntent on the tenant's Connect account.
    const account = await connectAccount(tenant.id);
    if (!account?.charges_enabled) {
      // No Stripe connected — accept booking without deposit (owner can chase later).
      await c.from('bookings').update({ outcome: 'confirmed', deposit_amount_cents: 0 })
        .eq('id', booking.id);
      return res.json({
        ok: true,
        booking: { id: booking.id, start_time: booking.start_time, end_time: booking.end_time },
        payment_required: false,
        warning: 'stripe_not_connected'
      });
    }

    const stripe = stripeFor(tenant.id, account.stripe_account_id);
    const intent = await stripe.createPaymentIntent({
      amount: depositCents,
      currency: service.currency || 'usd',
      metadata: {
        booking_id: booking.id,
        client_id: clientRow.id,
        tenant_id: tenant.id,
        kind: 'deposit'
      },
      description: `Deposit — ${service.name}`
    });

    return res.json({
      ok: true,
      booking: { id: booking.id, start_time: booking.start_time, end_time: booking.end_time },
      payment_required: true,
      client_secret: intent.client_secret,
      stripe_account: account.stripe_account_id,
      deposit_cents: depositCents
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
