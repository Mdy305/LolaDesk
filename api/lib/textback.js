/**
 * api/lib/textback.js — a caller hangs up or the line drops: Lola texts them in seconds.
 * ════════════════════════════════════════════════════════════════════════════════
 * Fired on Telnyx's call.conversation.ended (the moment the call ends). If an inbound
 * call to a salon's Lola line lasted only a few seconds — they hung up before talking,
 * or the call dropped — Lola texts: "Sorry we got cut off! I can book you right here…".
 * Once per number per day, never to the owner or the salon's own lines, never after
 * they already booked, opt-outs honoured by the SMS funnel, salons can switch it off.
 */
import { missedCallTextbackText } from './lola-persona.js';
import { withStopLine } from './legal.js';
import { getClientMemory, setClientMemory, e164 } from './db.js';

export const SHORT_CALL_SEC = 12;
const DAY = 864e5;

export async function instantTextBack(c, { callControlId, callSessionId, durationSec, from: evFrom = null, to: evTo = null }, { send, now = Date.now() } = {}) {
  if (!c || (!callControlId && !callSessionId && !(evFrom && evTo))) return { sent: false, reason: 'no_call' };
  let q = c.from('calls').select('id,tenant_id,from_number,to_number,direction,duration_seconds,created_at');
  if (callControlId) q = q.eq('telnyx_call_control_id', callControlId); else q = q.eq('call_session_id', callSessionId);
  const { data } = (callControlId || callSessionId) ? await q.limit(1) : { data: [] };
  let call = data?.[0];
  // They hung up before Lola even loaded the salon (no calls row yet): the event itself says who called whom.
  if (!call && evFrom && evTo) {
    try {
      const { resolveInboundTenant } = await import('./tenant-resolver.js');
      const r = await resolveInboundTenant({ to: evTo, from: evFrom });
      if (r?.status === 'resolved' && r.tenant?.id) call = { tenant_id: r.tenant.id, from_number: evFrom, to_number: evTo, direction: 'inbound', duration_seconds: durationSec, created_at: new Date(now).toISOString() };
    } catch (_) {}
  }
  if (!call) return { sent: false, reason: 'unknown_call' };
  const dur = durationSec != null ? Number(durationSec) : (call.duration_seconds != null ? Number(call.duration_seconds) : (now - new Date(call.created_at).getTime()) / 1000);
  if (String(call.direction || 'inbound') !== 'inbound') return { sent: false, reason: 'outbound' };
  if (!(dur >= 0) || dur > SHORT_CALL_SEC) return { sent: false, reason: 'real_conversation' };
  const from = e164(call.from_number || ''), to = e164(call.to_number || '');
  if (!from || from.replace(/\D/g, '').length < 10) return { sent: false, reason: 'no_caller_id' };
  const { data: tenant } = await c.from('tenants').select('id,name,phone_number,operator_phone,missed_call_textback').eq('id', call.tenant_id).maybeSingle();
  if (!tenant || tenant.missed_call_textback === false) return { sent: false, reason: 'off' };
  if ([tenant.phone_number, tenant.operator_phone, to].map((x) => e164(x || '')).includes(from)) return { sent: false, reason: 'own_line' };
  return textBackOnce(c, tenant, { from, to, send, now });
}

/**
 * The one missed-call text sender (the dropped-call path above and the phone line's
 * "caller went silent" goodbye): the STOP line, once per caller per day, never after they
 * just booked; opt-outs are honoured by the SMS funnel. → { sent, reason?, to?, text? }
 */
export async function textBackOnce(c, tenant, { from, to = null, send = null, now = Date.now(), source = 'missed_call_textback' } = {}) {
  from = e164(from || '');
  if (!tenant?.id || !from || from.replace(/\D/g, '').length < 10) return { sent: false, reason: 'no_caller_id' };
  if (tenant.missed_call_textback === false) return { sent: false, reason: 'off' };
  if ([tenant.phone_number, tenant.operator_phone, to].map((x) => e164(x || '')).includes(from)) return { sent: false, reason: 'own_line' };
  try {
    const mem = await getClientMemory(tenant.id, from);
    const last = mem.find((m) => m.key === 'textback_at');
    const at = last && Date.parse(typeof last.value === 'string' ? last.value.replace(/"/g, '') : last.value?.at);
    if (at && now - at < DAY) return { sent: false, reason: 'already_texted_today' };
  } catch (_) {}
  try {
    if (c) {
      const { data: cl } = await c.from('clients').select('id').eq('tenant_id', tenant.id).eq('phone', from).maybeSingle();
      if (cl?.id) { const { data: b } = await c.from('bookings').select('id').eq('tenant_id', tenant.id).eq('client_id', cl.id).gte('created_at', new Date(now - 2 * 3600e3).toISOString()).limit(1); if (b?.length) return { sent: false, reason: 'already_booked' }; }
    }
  } catch (_) {}
  const sms = send || (await import('./sms.js')).sendSms;
  const text = withStopLine(missedCallTextbackText(tenant.name));
  const r = await Promise.resolve(sms({ tenantId: tenant.id, from: to || undefined, to: from, text })).catch((e) => ({ error: String(e?.message || e) }));
  if (r?.skipped || r?.error || r?.failed) return { sent: false, reason: r.reason || r.error || 'not_sent' };
  try { await setClientMemory(tenant.id, from, 'textback_at', { at: new Date(now).toISOString() }); } catch (_) {}
  try { const { logUsage } = await import('./db.js'); await logUsage(tenant.id, 'textback_sent', 1, { source }); } catch (_) {}
  return { sent: true, to: from, text };
}
