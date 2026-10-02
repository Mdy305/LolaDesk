/**
 * api/lib/link-booking.js — Lola closes the booking on ANY platform: she texts the salon's own booking link.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * For salons that keep Boulevard / Vagaro / Fresha / Mindbody / GlossGenius / their own site and choose
 * "Lola texts my booking link" (Settings → Salon details). Lola still does the work: she understands
 * what the client wants, checks REAL availability (LolaDesk's calendar, which includes their system via
 * calendar link or Zapier), agrees the time — then, instead of writing the booking herself, she texts the
 * client the salon's booking page with the exact service and time to pick. Two taps for the client, no
 * automation of anyone's website, nothing breaks when the platform changes its page.
 */
import { db, upsertClient, setClientMemory, logUsage, e164 } from './db.js';
import { listAvailability, parseDurationMin } from './calendar-engine.js';
import { salonTz, fmtSalon } from './salon-time.js';
import { withStopLine } from './legal.js';

export async function bookingMode(tenant, c = db()) {
  const url = String(tenant?.booking_url || '').trim();
  let mode = 'loladesk';
  try { const { data } = await c.from('booking_settings').select('metadata').eq('tenant_id', tenant.id).maybeSingle(); if (data?.metadata?.lola_booking === 'link') mode = 'link'; } catch (_) {}
  return { link: mode === 'link' && /^https:\/\//i.test(url), url, mode };
}

export async function setBookingMode(c, tenantId, mode) {
  const m = mode === 'link' ? 'link' : 'loladesk';
  const { data: row } = await c.from('booking_settings').select('tenant_id,metadata').eq('tenant_id', tenantId).maybeSingle();
  const metadata = { ...((row && row.metadata) || {}), lola_booking: m };
  if (row) await c.from('booking_settings').update({ metadata }).eq('tenant_id', tenantId);
  else await c.from('booking_settings').insert({ tenant_id: tenantId, metadata });
  return m;
}

/**
 * The booking step in link mode. Same inputs as book_appointment.
 * Returns what Lola says, and sends the text when we have the client's mobile.
 */
export async function bookViaLink(tenant, body, { url, startsAt, service, durationMin, send } = {}) {
  const tz = await salonTz(tenant.id);
  const svcName = service?.name || body.service || 'your appointment';
  const first = String(body.client_name || '').trim().split(/\s+/)[0] || '';
  if (!startsAt) return { speak: `Happy to set that up — what day and time would you like for ${svcName}?`, booked: false, needs_time: true };

  // Real availability first (it already includes the salon's own system through its calendar link / Zapier).
  try {
    const av = await listAvailability({ tenant, date: startsAt, durationMin: durationMin || parseDurationMin(service?.duration, 60), service: svcName });
    const slots = (av?.slots || []).map((s) => new Date(s).toISOString());
    const want = new Date(startsAt).toISOString();
    // Only call it taken when it falls inside the window we just read (the list is capped).
    if (slots.length && !slots.includes(want) && Date.parse(want) <= Date.parse(slots[slots.length - 1])) {
      const options = slots.slice(0, 3).map((x) => fmtSalon(x, tz, 'time')).join(', ');
      return { speak: `That time is taken. I can do ${options} instead — which works?`, booked: false, conflict: true, slots };
    }
  } catch (_) {}

  const when = fmtSalon(startsAt, tz);
  const phone = e164(body.client_phone || body.from || '');
  // In a text/DM/chat the link goes in Lola's reply itself; on a phone call she texts it.
  const inChat = ['sms', 'whatsapp', 'instagram', 'web'].includes(String(body.channel || ''));
  const textable = !inChat && phone && !String(body.client_phone || '').includes(':');
  if (textable) {
    const text = withStopLine(`Hi${first ? ' ' + first : ''}! It's Lola from ${tenant.name || 'the salon'}. Here's our booking page for your ${svcName} on ${when} — tap it, pick ${svcName} at that time, and you're locked in: ${url}`);
    const sms = send || (await import('./sms.js')).sendSms;
    const r = await sms({ tenantId: tenant.id, to: phone, text }).catch((e) => ({ error: String(e?.message || e) }));
    if (r?.skipped && r.reason !== 'no_salon_number') return { speak: `Here's our booking page — pick ${svcName} on ${when}: ${url}`, booked: false, link: url };
    try {
      await upsertClient(tenant.id, { phone, name: body.client_name || undefined }).catch(() => null);
      await setClientMemory(tenant.id, phone, 'pending_booking', { service: svcName, starts_at: startsAt, link: url, sent_at: new Date().toISOString() });
      await logUsage(tenant.id, 'booking_link_sent', 1, { service: svcName });
    } catch (_) {}
    return { speak: `Perfect${first ? ', ' + first : ''} — I just texted you our booking link for ${svcName} on ${when}. Tap it and pick that time to lock it in.`, booked: false, link_sent: true, link: url, when };
  }
  // No mobile in this conversation (Instagram, website chat): the link goes right in the reply.
  try { await logUsage(tenant.id, 'booking_link_sent', 1, { service: svcName, channel: 'inline' }); } catch (_) {}
  return { speak: `Here's our booking page — pick ${svcName} on ${when} and you're all set: ${url}`, booked: false, link_sent: true, link: url, when };
}
