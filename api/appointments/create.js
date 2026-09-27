// POST /api/appointments/create — walk-in / manual booking from the dashboard.
//
// Thin adapter onto the canonical booking engine: it converts the booking
// dialog's { date, start_time (salon-local) } into a UTC instant using the
// tenant's booking timezone, then runs /api/calendar's `book` action — the
// same path every other booking takes (availability hold, external sync,
// createCanonicalBooking → confirmation SMS + deposit request).
import calendarHandler from '../calendar.js';
import { getBookingSettings } from '../lib/booking-repository.js';
import { zonedLocalToUtc } from '../lib/timezone.js';
import { tenantForRequest } from '../lib/tenant-context.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const date = String(b.date || '').slice(0, 10);
    const time = String(b.start_time || '').slice(0, 5);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(time)) {
      return res.status(400).json({ ok: false, error: 'date_and_start_time_required' });
    }
    if (!b.client_id && !b.client_name) return res.status(400).json({ ok: false, error: 'Client name required' });

    const tenant = await tenantForRequest(req, {});
    if (!tenant?.id) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const settings = await getBookingSettings(tenant.id);
    const tz = settings?.timezone || 'America/New_York';
    const startsAt = zonedLocalToUtc(date, `${time}:00`, tz);

    const bookBody = {
      action: 'book',
      starts_at: startsAt,
      client_id: b.client_id || null,
      client_name: b.client_name || null,
      client_phone: b.client_phone || null,
      client_email: b.client_email || null,
      service_id: b.service_id || null,
      service: b.service_name || null,
      staff_id: b.stylist_id || b.staff_id || null,
      stylist: b.stylist_name || null,
      notes: b.notes || null,
      channel: 'dashboard',
      timezone: tz,
    };

    // Run the canonical handler in-process and capture its JSON reply.
    const out = await runHandler(calendarHandler, {
      method: 'POST',
      headers: req.headers,
      query: {},
      body: bookBody,
    });

    const d = out.body || {};
    if (out.status < 300 && d.ok) {
      return res.status(200).json({ ok: true, data: d.booking || null, booking_id: d.booking_id || null });
    }
    // Translate engine replies into a message the dialog can show.
    let error = d.error || 'booking_failed';
    if (d.needs === 'staff') error = 'Pick a stylist — this service needs one.';
    else if (d.needs === 'service') error = 'Pick a service.';
    else if (d.needs === 'client') error = 'Client details are missing.';
    else if (d.conflict || d.error === 'slot_unavailable') error = 'That time is taken — pick another slot.';
    return res.status(out.status >= 400 ? out.status : 409).json({ ok: false, error, details: d });
  } catch (e) {
    console.error('[appointments/create]', e?.message);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

function runHandler(fn, req) {
  return new Promise((resolve) => {
    let status = 200;
    const res = {
      setHeader() { return res; },
      getHeader() { return undefined; },
      status(code) { status = code; return res; },
      json(body) { resolve({ status, body }); return res; },
      send(body) { resolve({ status, body }); return res; },
      end() { resolve({ status, body: null }); return res; },
    };
    Promise.resolve(fn(req, res)).catch((e) => resolve({ status: 500, body: { ok: false, error: String(e?.message || e) } }));
  });
}
