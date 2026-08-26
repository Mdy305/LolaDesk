/**
 * api/lib/booking-reminders.js — the booking reminder engine.
 *
 * The hourly cron (/api/cron/booking-reminders) calls runReminders() to text
 * clients whose confirmed appointment starts ~24h from now. Each salon gates
 * the whole feature with booking_settings.reminder_sms (default ON — the
 * toggle owners flip in Settings → Booking settings).
 *
 * Exactly-once semantics: a booking is reminded once per appointment time.
 * `booking_reminders` has a unique (booking_id, reminder_for) constraint and
 * the engine claims the row BEFORE sending (check-then-insert, with the DB
 * constraint as the race backstop), so two overlapping cron ticks can never
 * double-text a client. If the salon reschedules the appointment, start_time
 * changes, a new reminder_for is minted, and the new time gets its own
 * reminder. Every attempt — sent, failed, or skipped — is logged.
 *
 * The sender is injectable for tests (`runReminders(now, { send })`); the
 * cron uses the real Telnyx sender by default.
 */

import { db } from './db.js';
import { sendSMS } from '../telnyx-sms.js';

// Text when the appointment is 23–25h away. With an hourly cron a booking
// lands in this band for exactly one tick (the 2h band is wider than the 1h
// tick, and the unique constraint absorbs any overlap).
const WINDOW_MS = 23 * 3600e3;
const SPAN_MS = 2 * 3600e3;
const MAX_PER_RUN = 100;

export async function findDueBookings(now = new Date(), client = null) {
  const c = client || db();
  if (!c) throw new Error('database not configured');
  const start = new Date(now.getTime() + WINDOW_MS).toISOString();
  const end = new Date(now.getTime() + WINDOW_MS + SPAN_MS).toISOString();
  const { data, error } = await c.from('bookings')
    .select('id,tenant_id,client_id,service_id,start_time')
    .eq('status', 'confirmed')
    .gte('start_time', start)
    .lt('start_time', end)
    .limit(MAX_PER_RUN);
  if (error) throw error;
  return data || [];
}

// Attach tenant / client / service / booking_settings rows in batch queries
// (the same multi-query pattern sendConfirmationSMS uses).
async function enrich(client, bookings) {
  const tenantIds = [...new Set(bookings.map((b) => b.tenant_id))];
  const clientIds = [...new Set(bookings.map((b) => b.client_id).filter(Boolean))];
  const serviceIds = [...new Set(bookings.map((b) => b.service_id).filter(Boolean))];
  const [tenants, clients, services, settings, integrations] = await Promise.all([
    tenantIds.length ? client.from('tenants').select('id,name,phone_number').in('id', tenantIds) : { data: [] },
    clientIds.length ? client.from('clients').select('id,name,phone,whatsapp_enabled').in('id', clientIds) : { data: [] },
    serviceIds.length ? client.from('services').select('id,name').in('id', serviceIds) : { data: [] },
    tenantIds.length ? client.from('booking_settings').select('tenant_id,reminder_sms').in('tenant_id', tenantIds) : { data: [] },
    tenantIds.length ? client.from('integrations').select('tenant_id,provider,status').in('tenant_id', tenantIds) : { data: [] }
  ]);
  const by = (rows, key) => Object.fromEntries((rows || []).map((r) => [r[key], r]));
  const tMap = by(tenants.data, 'id');
  const clMap = by(clients.data, 'id');
  const svMap = by(services.data, 'id');
  const sMap = by(settings.data, 'tenant_id');
  // A salon's WhatsApp is connected when it has a connected integrations row
  // (the same signal the health screen reads).
  const waTenantIds = new Set(
    (integrations.data || [])
      .filter((r) => r.provider === 'whatsapp' && r.status === 'connected')
      .map((r) => r.tenant_id)
  );
  return bookings.map((b) => ({
    ...b,
    tenant: tMap[b.tenant_id] || null,
    client: clMap[b.client_id] || null,
    service: svMap[b.service_id] || null,
    settings: sMap[b.tenant_id] || null,
    tenant_whatsapp: waTenantIds.has(b.tenant_id)
  }));
}

export function buildReminderText(b) {
  const when = new Date(b.start_time).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
  const what = (b.service && b.service.name) || 'your appointment';
  const salon = (b.tenant && b.tenant.name) || 'the salon';
  return `Reminder from ${salon}: ${what} on ${when}. Reply STOP to opt out.`;
}

// Claim the reminder row BEFORE sending. Returns the row, or null when this
// appointment time was already claimed (check-then-insert; in production the
// unique constraint turns a concurrent double-claim into an error we swallow).
async function claim(client, b, channel) {
  const { data: existing } = await client.from('booking_reminders')
    .select('id')
    .eq('booking_id', b.id)
    .eq('reminder_for', b.start_time)
    .maybeSingle();
  if (existing) return null;
  const { data, error } = await client.from('booking_reminders').insert({
    tenant_id: b.tenant_id,
    booking_id: b.id,
    client_id: b.client_id || null,
    reminder_for: b.start_time,
    status: 'pending',
    channel: channel || 'sms'
  }).select().maybeSingle();
  if (error || !data) return null; // race — the DB constraint won; someone else claimed it
  return data;
}

async function mark(client, id, status, errorText = null) {
  await client.from('booking_reminders')
    .update({ status, error: errorText, sent_at: status === 'sent' ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
    .eq('id', id);
}

export async function runReminders(now = new Date(), { send = sendSMS } = {}) {
  const client = db();
  if (!client) throw new Error('database not configured');
  const bookings = await findDueBookings(now, client);
  const enriched = await enrich(client, bookings);
  const result = { due: bookings.length, sent: 0, whatsapp: 0, sms: 0, failed: 0, skipped: 0, gate_off: 0 };

  for (const b of enriched) {
    // Salon gate: booking_settings.reminder_sms defaults to ON; a missing
    // settings row means the owner never touched the toggle → remind.
    if (b.settings && b.settings.reminder_sms === false) { result.gate_off++; result.skipped++; continue; }
    if (!b.client || !b.client.phone) { result.skipped++; continue; }
    if (!b.tenant || !b.tenant.phone_number) { result.skipped++; continue; }

    // Channel choice: prefer WhatsApp when the salon has it connected AND the
    // client has opted in (clients.whatsapp_enabled, set automatically from a
    // prior WhatsApp conversation or flipped by the owner). Otherwise SMS.
    // This respects WhatsApp's explicit-opt-in rule — a salon can never cold-
    // WhatsApp a client who only ever texted.
    const channel = b.tenant_whatsapp && b.client.whatsapp_enabled ? 'whatsapp' : 'sms';

    const row = await claim(client, b, channel);
    if (!row) { result.skipped++; continue; }

    try {
      await send({
        from: b.tenant.phone_number,
        to: b.client.phone,
        text: buildReminderText(b),
        tenantId: b.tenant_id,
        type: channel === 'whatsapp' ? 'WHATSAPP' : 'SMS'
      });
      await mark(client, row.id, 'sent');
      result.sent++;
      result[channel]++;
    } catch (e) {
      await mark(client, row.id, 'failed', String(e?.message || e));
      result.failed++;
    }
  }
  return result;
}
