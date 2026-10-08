/**
 * api/lib/live-booking.js — one Lola, whatever booking system the salon uses.
 * ═══════════════════════════════════════════════════════════════════════════
 * Lola's front-desk flow never changes: understand → check real availability → offer real times →
 * collect first + last name, mobile, email → book → VERIFY → confirm by text/email → it's on the
 * LolaDesk screen. What changes per salon is only where "the book" lives:
 *
 *   • a LIVE connector (META.live — e.g. Boulevard): availability is asked of that system, the
 *     booking is made there and read back before Lola says "booked"; LolaDesk keeps a mirror.
 *   • any other connected system (Square, Vagaro, Mindbody, Fresha, Google, Cal, Booksy, calendar
 *     link, Zapier): LolaDesk's calendar — which already sees that system's appointments — is the
 *     book, and every booking is written through to the system (booking-outbox).
 *   • nothing connected: LolaDesk's own calendar.
 *
 * Adding a system = one connector file implementing the contract; Lola's words and behavior don't move.
 *   liveAvailability(integration, { service, date, wantAt, stylist, tz })
 *     → { ok, service, staffName, staffMissing, exact:{startTime}|null, times:[{startTime}], nextDate, nextTimes, menu? }
 *   createAppointment(integration, { starts_at, date, service, stylist, timezone, client:{ first_name, last_name, name, phone, email }, notes })
 *     → { id, verified, starts_at, ends_at, service, staff }   (throws .code 'conflict' with .offers, 'card_required', 'service_not_found')
 */
import { getTenantIntegrations } from './db.js';

/** The salon's live booking system, if it has one connected: { provider, name, integration, connector }. */
export async function liveProviderFor(tenantId) {
  if (!tenantId) return null;
  let rows = [];
  try { rows = await getTenantIntegrations(tenantId); } catch (_) { return null; }
  const { getConnector } = await import('./aggregator.js');
  for (const integration of rows) {
    let connector = null;
    try { connector = getConnector(integration.provider); } catch (_) { continue; }
    if (connector?.META?.live && typeof connector.liveAvailability === 'function' && (typeof connector.liveCreate === 'function' || typeof connector.createAppointment === 'function')) {
      if (typeof connector.credsFromIntegration === 'function' && !connector.credsFromIntegration(integration)) continue;
      if (typeof connector.liveReady === 'function' && !(await connector.liveReady(integration))) continue;
      return { provider: integration.provider, name: connector.META.name || integration.provider, integration, connector };
    }
  }
  return null;
}

export async function liveCheck(lp, args) {
  return lp.connector.liveAvailability(lp.integration, args);
}

/** → { ok:true, id, verified, startAt, endAt, service, staffName } | { ok:false, error, offers, menu, message } */
export async function liveBook(lp, payload) {
  try {
    // liveCreate when a connector also keeps the outbox's createAppointment (Square); else createAppointment (Boulevard).
    const r = typeof lp.connector.liveCreate === 'function' ? await lp.connector.liveCreate(lp.integration, payload) : await lp.connector.createAppointment(lp.integration, payload);
    const id = r?.id || r?.external_id;
    if (!id) return { ok: false, error: 'not_confirmed', message: 'the booking system returned no appointment' };
    return { ok: true, id, verified: r.verified !== false, startAt: r.starts_at || payload.starts_at, endAt: r.ends_at || null, service: r.service || payload.service, staffName: r.staff || null };
  } catch (e) {
    const code = String(e?.code || '');
    const error = code === 'conflict' || /conflict|taken|unavailable/i.test(String(e?.message)) ? 'taken'
      : code === 'card_required' ? 'card_required'
      : code === 'service_not_found' ? 'service_not_found'
      : (code === 'timeout' || code === 'network' || code === 'auth') ? 'unreachable' : 'not_confirmed';
    return { ok: false, error, offers: e?.offers || [], menu: e?.menu || [], message: String(e?.message || e).slice(0, 200) };
  }
}
