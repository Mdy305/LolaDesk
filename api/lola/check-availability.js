// POST /api/lola/check-availability   { to_number, service_id, staff_id?, date? }
// LolaBrain asks "what's open Friday?". Answers from the ONE availability
// engine (staff schedules, time off, blocked time, buffers, holds, existing
// bookings) in the salon's timezone. Next 3 openings that day, or across the
// next 7 days when no date is given.
import { toolAuth, tenantForCalledNumber } from './_tool-tenant.js';
import { getAvailability } from '../lib/availability-engine-v2.js';
import { salonTz, fmtSalon } from '../lib/salon-time.js';
import { localDateKey } from '../lib/timezone.js';
import { db } from '../lib/db.js';
import { gateNewBooking, turnedAway, CALLER_LINE } from '../lib/billing-enforce.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  // Public skill (anyone may ask for openings / book): refused only in legacy strict mode
  // (LOLA_TOOL_SECRET set and neither that header nor the signed k=… present).
  if (toolAuth(req) === 'refused') return res.status(401).json({ error: 'unauthorized' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { to_number, service_id, staff_id, date } = body;
    if (!to_number || !service_id) return res.status(400).json({ error: 'missing_params' });
    const tenant = await tenantForCalledNumber(to_number);
    if (!tenant) return res.status(404).json({ error: 'tenant_not_found' });
    // Trial over and unpaid (BILLING_ENFORCE): take a callback, text the owner.
    if (gateNewBooking(tenant)) {
      await turnedAway(db(), tenant, { channel: 'voice', caller: body.from_number || body.from || '', when: date ? String(date).slice(0, 10) : '' });
      return res.json({ ok: false, blocked: true, message: CALLER_LINE, slots: [] });
    }
    const tz = await salonTz(tenant.id);
    const today = localDateKey(new Date(), tz);
    const add = (k, n) => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
    const days = date ? [String(date).slice(0, 10)] : Array.from({ length: 7 }, (_, i) => add(today, i));
    const found = []; let serviceName = null, duration = null;
    for (const key of days) {
      if (found.length >= 3) break;
      const av = await getAvailability({ tenantId: tenant.id, serviceId: service_id, staffId: staff_id || null, date: key, limit: 3 - found.length });
      if (!av.ok) { if (av.error === 'service_not_found') return res.status(404).json({ error: 'service_not_found' }); continue; }
      serviceName = av.service?.name || serviceName; duration = av.service?.duration_minutes || duration;
      for (const s of av.slots) found.push({ iso: s.starts_at, date: s.date, staff_id: s.staff_id, staff_name: s.staff_name, human: fmtSalon(s.starts_at, tz) });
    }
    return res.json({
      service: serviceName, duration_min: duration, slots: found.slice(0, 3), count: Math.min(3, found.length),
      message: found.length ? `I have ${found.length > 1 ? found.length + ' open times' : 'one opening'}: ${found.slice(0, 3).map(s => s.human).join('; ')}. Which works?` : "I don't see any openings for that. Want me to check next week?",
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
