/**
 * api/lib/sms.js — THE one owner of outbound Telnyx messaging.
 * ════════════════════════════════════════════════════════════════════
 * Every SMS/WhatsApp send in the product goes through sendSms() here —
 * booking confirmations/cancellations, reminders, waitlist offers,
 * autopilot recovery, campaigns, inbox replies, owner texts. No other
 * file may POST to /v2/messages.
 *
 * Why one owner: when the Telnyx messaging profile was silently disabled,
 * three separate send paths failed in three different ways and nothing
 * surfaced it. One funnel means one opt-out gate, one auth, one place to
 * add logging/metrics/health signals.
 */
import { e164, isOptedOut } from './db.js';
import { resolveInboundTenant } from './tenant-resolver.js';

// The historical alias: every pre-existing call site imports `sendSMS`.
export { sendSms as sendSMS };

export async function sendSms({
  from, to, text, profileId, tenantId,
  skipOptOut = false, type = 'SMS', channel = 'sms',
} = {}) {
  const isWhatsApp = String(type || channel || '').toUpperCase() === 'WHATSAPP';
  if (!skipOptOut) {
    try {
      const t = tenantId || (await resolveInboundTenant({ to: from }))?.tenant?.id;
      if (t && await isOptedOut(t, to)) return { skipped: true, reason: 'opted_out' };
    } catch { /* opt-out check is best-effort; never block the send on it */ }
  }

  const payload = { from, to };
  if (isWhatsApp) {
    payload.whatsapp_message = { type: 'text', text: { body: text } };
  } else {
    payload.text = text;
    if (profileId) payload.messaging_profile_id = profileId;
  }

  const r = await fetch('https://api.telnyx.com/v2/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });
  return r.json();
}

/**
 * Autopilot's historically looser contract, preserved: e164-normalizes,
 * reports {skipped, reason} on missing key/recipients/Telnyx errors, and
 * never throws. Kept here so the reason-shape moves with the owner.
 */
export async function sendAutopilotSms({ from, to, text, tenantId } = {}) {
  if (!process.env.TELNYX_API_KEY) return { skipped: true, reason: 'TELNYX_API_KEY not set' };
  if (!from || !to) return { skipped: true, reason: 'missing from/to' };
  if (tenantId) {
    try { if (await isOptedOut(tenantId, to)) return { skipped: true, reason: 'opted_out' }; } catch { }
  }
  try {
    await sendSms({ from: e164(from), to: e164(to), text, tenantId });
    return { sent: true };
  } catch (e) {
    return { skipped: true, reason: String(e?.message || e) };
  }
}
