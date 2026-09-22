// GET /api/widget/availability?tenant=<slug>&service_id=<uuid>&staff_id=<uuid>&date=YYYY-MM-DD
// PUBLIC. Returns open time slots for a given day, given service duration and existing bookings.
// Slot granularity = 15 min. Respects tenant business_hours + closures.
import { corsPublic } from '../lib/cors.js';
import { db } from '../lib/db.js';
import { resolveTenantFromRequest } from '../lib/widget-tenant.js';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function pad(n) { return n < 10 ? '0' + n : String(n); }

function parseHM(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  return { h, m };
}

export default async function handler(req, res) {
  if (corsPublic(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    const tenant = await resolveTenantFromRequest(req);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const service_id = String(req.query?.service_id || '');
    const staff_id = String(req.query?.staff_id || '');
    const date = String(req.query?.date || '');
    if (!service_id || !date) return res.status(400).json({ ok: false, error: 'missing_params' });

    const c = db();

    const { data: service } = await c.from('services')
      .select('duration_min, buffer_after_min')
      .eq('id', service_id)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (!service) return res.status(404).json({ ok: false, error: 'service_not_found' });

    const { data: settings } = await c.from('booking_settings')
      .select('business_hours, closures')
      .eq('tenant_id', tenant.id)
      .maybeSingle();

    const closures = new Set(settings?.closures || []);
    if (closures.has(date)) return res.json({ ok: true, slots: [], closed: true });

    const [y, m, d] = date.split('-').map(Number);
    const dow = DAYS[new Date(y, m - 1, d).getDay()];
    const hours = settings?.business_hours?.[dow];
    if (!hours || hours.closed) return res.json({ ok: true, slots: [], closed: true });

    const open = parseHM(hours.open);
    const close = parseHM(hours.close);

    // Load bookings that day for either the specific staff or any staff.
    const dayStart = new Date(y, m - 1, d, 0, 0, 0).toISOString();
    const dayEnd = new Date(y, m - 1, d + 1, 0, 0, 0).toISOString();
    let q = c.from('bookings')
      .select('start_time, end_time, staff_id, outcome')
      .eq('tenant_id', tenant.id)
      .gte('start_time', dayStart)
      .lt('start_time', dayEnd)
      .not('outcome', 'in', '(cancelled,no_show)');
    if (staff_id) q = q.eq('staff_id', staff_id);
    const { data: bookings } = await q;

    // Build slot grid.
    const durationMin = Number(service.duration_min || 60);
    const bufferMin = Number(service.buffer_after_min || 0);
    const total = durationMin + bufferMin;
    const step = 15;

    const slots = [];
    const startMin = open.h * 60 + open.m;
    const closeMin = close.h * 60 + close.m;

    for (let t = startMin; t + durationMin <= closeMin; t += step) {
      const slotStart = new Date(y, m - 1, d, Math.floor(t / 60), t % 60).getTime();
      const slotEnd = slotStart + durationMin * 60 * 1000;

      // No slots in the past.
      if (slotStart < Date.now() + 30 * 60 * 1000) continue;

      const conflict = (bookings || []).some(b => {
        const bs = new Date(b.start_time).getTime();
        const be = b.end_time ? new Date(b.end_time).getTime() : bs + 60 * 60 * 1000;
        return bs < slotEnd + bufferMin * 60000 && be + bufferMin * 60000 > slotStart;
      });
      if (conflict) continue;

      const hh = Math.floor(t / 60);
      const mm = t % 60;
      slots.push({
        time: `${pad(hh)}:${pad(mm)}`,
        iso: new Date(slotStart).toISOString()
      });
    }

    return res.json({ ok: true, slots, date, dow });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
