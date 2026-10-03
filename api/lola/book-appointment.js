// POST /api/lola/book-appointment
// { to_number, from_number, service_id, staff_id?, start_iso, client_name? }
// LolaBrain commits a booking — through the canonical engine: availability
// hold (no double-booking), "any stylist" resolution, createCanonicalBooking
// (confirmation text with the code, deposit request), salon-local times.
import { toolAuth, tenantForCalledNumber } from './_tool-tenant.js';
import { upsertClient, getClientByPhone, e164 } from '../lib/db.js';
import { holdAvailability, getAvailability } from '../lib/availability-engine-v2.js';
import { createCanonicalBooking, releaseHold } from '../lib/booking-repository.js';
import { salonTz, fmtSalon } from '../lib/salon-time.js';
import { db } from '../lib/db.js';
import { gateNewBooking, turnedAway, CALLER_LINE } from '../lib/billing-enforce.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  // Public skill (anyone may ask for openings / book): refused only in legacy strict mode
  // (LOLA_TOOL_SECRET set and neither that header nor the signed k=… present).
  if (toolAuth(req) === 'refused') return res.status(401).json({ error: 'unauthorized' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { to_number, from_number, service_id, staff_id, start_iso, client_name } = body;
    if (!to_number || !service_id || !start_iso || !from_number) return res.status(400).json({ error: 'missing_params' });
    const tenant = await tenantForCalledNumber(to_number);
    if (!tenant) return res.status(404).json({ error: 'tenant_not_found' });
    const startIso = new Date(start_iso).toISOString();
    const tz = await salonTz(tenant.id);
    // Trial over and unpaid (BILLING_ENFORCE): take a callback, text the owner.
    if (gateNewBooking(tenant)) {
      await turnedAway(db(), tenant, { channel: 'voice', caller: from_number, when: fmtSalon(startIso, tz, 'long') });
      return res.json({ ok: false, blocked: true, message: CALLER_LINE });
    }

    // Existing client first (never rename them to "Client"), else create.
    let client = await getClientByPhone(tenant.id, from_number).catch(() => null);
    if (!client) client = await upsertClient(tenant.id, { phone: e164(from_number), name: client_name || null });
    if (!client?.id) return res.status(500).json({ error: 'client_not_saved' });

    let staffId = staff_id || null;
    if (!staffId) {
      const av = await getAvailability({ tenantId: tenant.id, serviceId: service_id, date: startIso, limit: 500 });
      staffId = (av.slots || []).find(x => x.starts_at === startIso)?.staff_id || null;
    }
    const held = staffId ? await holdAvailability({ tenantId: tenant.id, clientId: client.id, serviceId: service_id, staffId, startsAt: startIso, channel: 'voice', ttlSeconds: 120 }) : { ok: false };
    if (!held.ok) {
      const alt = await getAvailability({ tenantId: tenant.id, serviceId: service_id, date: startIso, limit: 3 });
      const options = (alt.slots || []).map(s => fmtSalon(s.starts_at, tz, 'time')).join(', ');
      return res.json({ ok: false, conflict: true, message: `That time isn't available.${options ? ` I can do ${options}.` : ''}`, slots: (alt.slots || []).map(s => s.starts_at) });
    }
    const booking = await createCanonicalBooking({
      tenantId: tenant.id, clientId: client.id, serviceId: service_id, staffId,
      startTime: held.slot.starts_at, endTime: held.slot.ends_at, status: 'confirmed',
      totalAmount: held.slot.price ?? 0, source: 'lola_phone', holdId: held.hold.id,
    });
    await releaseHold(tenant.id, held.hold.hold_token, 'converted');
    const when = fmtSalon(booking.start_time, tz);
    return res.json({ ok: true, booking_id: booking.id, when, service: held.slot.service_name, stylist: held.slot.staff_name,
      message: `Booked with ${held.slot.staff_name} on ${when}. I'm texting the confirmation now.` });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
