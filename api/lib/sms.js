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
import { e164, isOptedOut, db as _smsDb } from './db.js';
import { resolveInboundTenant } from './tenant-resolver.js';

// The historical alias: every pre-existing call site imports `sendSMS`.
export { sendSms as sendSMS };

async function _sendSmsCore({
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

  // Telnyx requires E.164 (+13055550100) for both ends.
  const fromE = e164(from), toE = e164(to);
  if (!/^\+\d{7,15}$/.test(String(fromE || '')) || !/^\+\d{7,15}$/.test(String(toE || ''))) return { skipped: true, reason: 'bad_number' };
  const payload = { from: fromE, to: toE };
  if (isWhatsApp) {
    // Documented WhatsApp route: POST /messages/whatsapp with type WHATSAPP.
    payload.type = 'WHATSAPP';
    payload.whatsapp_message = { type: 'text', text: { body: text } };
  } else {
    payload.text = text;
    if (profileId) payload.messaging_profile_id = profileId;
  }

  const r = await fetch(isWhatsApp ? 'https://api.telnyx.com/v2/messages/whatsapp' : 'https://api.telnyx.com/v2/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  // A refused text (10DLC block, bad number, no balance) must never look sent.
  if (!r.ok || (Array.isArray(j?.errors) && j.errors.length)) {
    const reason = j?.errors?.[0]?.detail || j?.errors?.[0]?.title || `telnyx_${r.status}`;
    console.warn('[sms] Telnyx refused the text:', reason);
    return { skipped: true, failed: true, reason, errors: j?.errors || [] };
  }
  return j;
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


/**
 * Public entry point. Accepts the canonical { from, to, text, tenantId }
 * shape AND the { tenant, to, body } shape some features use. When `from`
 * is missing it resolves the salon's own line (tenant_numbers primary →
 * tenants.phone_number → env). Missing essentials return
 * { skipped, reason } instead of sending a broken request to Telnyx.
 */
export async function sendSms(opts = {}) {
  const o = { ...opts };
  if (o.text == null && o.body != null) o.text = o.body;
  if (o.text == null && o.message != null) o.text = o.message;
  if (!o.tenantId && o.tenant && o.tenant.id) o.tenantId = o.tenant.id;
  if (!o.from) o.from = await _resolveSalonLine(o.tenant, o.tenantId);
  const tenant = o.tenant;
  delete o.body; delete o.message; delete o.tenant;
  if (!o.from || !o.to || !o.text) {
    const reason = !o.from ? 'no_salon_number' : (!o.to ? 'no_recipient' : 'no_text');
    console.warn('[sms] not sent:', reason, tenant && tenant.id ? `tenant=${tenant.id}` : '');
    return { skipped: true, reason };
  }
  return _sendSmsCore(o);
}

async function _resolveSalonLine(tenant, tenantId) {
  const id = (tenant && tenant.id) || tenantId || null;
  try {
    const c = _smsDb();
    if (c && id) {
      const { data: rows } = await c.from('tenant_numbers').select('*').eq('tenant_id', id);
      const list = (rows || []).filter(r => r && (r.phone_number || r.phone_e164));
      const pick = list.find(r => r.kind === 'primary') || list.find(r => r.status === 'active') || list[0];
      if (pick) return pick.phone_number || pick.phone_e164;
    }
  } catch (_) { /* fall through */ }
  let t = tenant || null;
  if ((!t || !(t.phone_number || t.phone_e164)) && id) {
    try {
      const c = _smsDb();
      if (c) { const { data } = await c.from('tenants').select('*').eq('id', id).maybeSingle(); if (data) t = data; }
    } catch (_) { /* fall through */ }
  }
  const own = t && (t.phone_number || t.phone_e164 || t.phone);
  if (own) return own;
  // Multi-tenant rule: a salon's text NEVER goes out from another salon's (or the
  // platform's) line. The shared env number is only for platform messages.
  if (id) return null;
  return process.env.TELNYX_FROM_NUMBER || process.env.TELNYX_NUMBER || null;
}
