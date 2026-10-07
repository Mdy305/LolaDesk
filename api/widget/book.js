// POST /api/widget/book
// { tenant, service_id, staff_id, start_iso, hold_token?, client: { first_name, last_name, phone, email }, sms_consent? }
// PUBLIC — no bearer token.
//
// This used to write bookings directly: no rate limit, no availability check, no billing gate, and
// it attached the booking to whatever client record already had that phone number. It now goes
// through the SAME public booking core as /api/public-booking (per-IP limits, the salon's booking
// rules, real availability via a hold, the trial/billing gate, deposits, never overwriting an
// existing client's details, confirmation text) — so this endpoint can't do anything the public
// booking page can't.
import { corsPublic, jsonBody } from '../lib/cors.js';
import { resolveTenantFromRequest } from '../lib/widget-tenant.js';
import publicBooking from '../public-booking.js';

export default async function handler(req, res) {
  if (corsPublic(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    const tenant = await resolveTenantFromRequest(req);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const body = jsonBody(req) || {};
    const { service_id, staff_id, start_iso, client } = body;
    if (!service_id || !start_iso || !client?.phone) {
      return res.status(400).json({ ok: false, error: 'missing_fields' });
    }
    const name = [client.first_name, client.last_name].filter(Boolean).join(' ').trim() || String(client.name || '').trim();

    // Only the fields the public core accepts — the browser never picks the client record or price.
    req.body = {
      action: 'book',
      tenant: tenant.slug || tenant.id,
      service_id: String(service_id),
      staff_id: staff_id ? String(staff_id) : undefined,
      starts_at: String(start_iso),
      hold_token: body.hold_token || undefined,
      client_phone: String(client.phone),
      client_name: name,
      client_email: client.email || undefined,
      sms_consent: body.sms_consent,
      consent_text_version: body.consent_text_version,
      notes: typeof body.notes === 'string' ? body.notes.slice(0, 500) : undefined,
    };
    req.query = { ...(req.query || {}), tenant: tenant.slug || tenant.id };
    req.method = 'POST';

    // Keep the legacy response shape ({ booking: { id, start_time, end_time }, payment_required }) on top of the core's.
    const json = res.json.bind(res);
    res.json = (o) => {
      if (o && o.ok && o.booking_id && !o.booking?.id) {
        o = { ...o, booking: { id: o.booking_id, start_time: o.starts_at || o.start_time || null, end_time: o.ends_at || o.end_time || null } };
      }
      if (o && o.ok && o.payment_required === undefined) o = { ...o, payment_required: !!(o.deposit && (o.deposit.required || o.deposit.link)) };
      return json(o);
    };
    return publicBooking(req, res);
  } catch (e) {
    console.error('[widget/book]', e?.message || e);
    return res.status(500).json({ ok: false, error: 'booking_failed' });
  }
}
