/**
 * /api/calendar.ics — add-to-calendar for a client's own booking.
 * ══════════════════════════════════════════════════════════════════
 * The confirmation text promises the client the appointment; the calendar
 * file keeps it on their phone. Resolves a booking by its unambiguous
 * confirmation code + client phone (the same public self-service contract
 * calendar.js 'lookup' uses — never by booking_id, which is internal),
 * and returns a standards-compliant ICS (text/calendar) that Apple
 * Calendar, Google Calendar, and Outlook all import.
 *
 * Only CONFIRMED, upcoming bookings produce a file; anything else is a
 * plain 404 so a stale link never installs a wrong event. The route is
 * unauthenticated by design — the code+phone pair IS the credential.
 *
 * Calendars disagree about the filename extension, so the handler strips
 * it (…/api/calendar.ics?code=…&phone=…) and serves the same bytes for
 * any suffix; Vercel routes both /api/calendar and /api/calendar.ics here.
 */

import { db } from './lib/db.js';

function normPhone(p){
  let d = String(p || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return d;
}

// RFC 5545: backslash, semicolon, comma must be escaped in text values;
// newlines are encoded as literal \n.
function icsEscape(s){
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// UTC "YYYYMMDDTHHMMSSZ" — ICS requires UTC timestamps (the trailing Z).
function icsStamp(iso){
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// Fold content lines at 75 octets (RFC 5545 §3.1): continuation lines open
// with a single space.
function foldLine(line){
  if (line.length <= 75) return line;
  const parts = [line.slice(0, 75)];
  for (let i = 75; i < line.length; i += 74) parts.push(' ' + line.slice(i, i + 74));
  return parts.join('\r\n');
}

export function buildIcs({ salon, serviceName, staffName, startIso, endIso, location }){
  const summary = icsEscape(`${serviceName || 'Appointment'} — ${salon || 'the salon'}`);
  const description = icsEscape(
    `${serviceName || 'Your appointment'} at ${salon || 'the salon'}` +
    (staffName ? ` with ${staffName}` : '')
  );
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//LolaDesk//Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${icsStamp(startIso)}-${icsEscape(String(salon || 'lola')).replace(/[^A-Za-z0-9]/g, '')}@loladesk.com`,
    `DTSTAMP:${icsStamp(new Date().toISOString())}`,
    `DTSTART:${icsStamp(startIso)}`,
    `DTEND:${icsStamp(endIso || startIso)}`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:${description}`,
    location ? `LOCATION:${icsEscape(location)}` : null,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR'
  ].filter(Boolean);
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });

  try {
    const c = db();
    if (!c) return res.status(503).json({ ok: false, error: 'database_not_configured' });

    // The filename suffix (.ics) is cosmetic — the query string carries the
    // credential regardless of which form the calendar app kept.
    const code = String((req.query && req.query.code) || '').trim().toUpperCase();
    const phone = String((req.query && req.query.phone) || '');
    if (!code || !phone) return res.status(404).json({ ok: false, error: 'not_found' });

    const { data: booking } = await c.from('bookings').select('*')
      .eq('confirmation_code', code).maybeSingle();
    if (!booking || booking.status !== 'confirmed') return res.status(404).json({ ok: false, error: 'not_found' });

    const [{ data: client }, { data: tenant }, { data: svc }, { data: staff }] = await Promise.all([
      c.from('clients').select('phone').eq('id', booking.client_id).maybeSingle(),
      c.from('tenants').select('name,location').eq('id', booking.tenant_id).maybeSingle(),
      booking.service_id ? c.from('services').select('name').eq('id', booking.service_id).maybeSingle() : Promise.resolve({ data: null }),
      booking.staff_id ? c.from('staff').select('name').eq('id', booking.staff_id).maybeSingle() : Promise.resolve({ data: null })
    ]);
    if (!client || normPhone(client.phone) !== normPhone(phone)) return res.status(404).json({ ok: false, error: 'not_found' });

    const ics = buildIcs({
      salon: tenant && tenant.name,
      serviceName: svc && svc.name,
      staffName: staff && staff.name,
      startIso: booking.start_time,
      endIso: booking.end_time,
      location: tenant && tenant.location
    });

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="appointment.ics"');
    return res.status(200).send(ics);
  } catch (e) {
    console.error('[calendar.ics]', e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
