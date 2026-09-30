/**
 * api/lib/lead-relay.js — hot leads reach the owner; the owner's reply reaches the client.
 *
 * Lola answers texts, WhatsApp and website chat on her own. When a client asks
 * for something a person should close (a group or wedding, a quote, a
 * complaint, "can someone call me"), Lola texts the owner from the salon's own
 * line. The owner replies to that text, and Lola passes it to the client on
 * the same channel. No new tables: a relay is a `conversations` row with
 * channel 'relay' and the lead in `metadata`.
 *
 * (Google Business Profile chat was shut down by Google in July 2024, so the
 * inbound channels are the ones LolaDesk owns: calls, texts, WhatsApp, web chat.)
 */
import { sendSMS } from './sms.js';
import { e164, logMessage } from './db.js';

export const HOT_LEAD = /\b(quote|estimate|wedding|bridal|bride|bridesmaids?|prom|quincea(n|ñ)era|party of|group of|\d+\s+(people|ladies|girls|guests|of us)|event|photo ?shoot|corporate|on[- ]site|speak (to|with) (someone|a person|a human|the owner|a manager|the manager)|talk (to|with) (someone|a person|a human|the owner|a manager|the manager)|real person|manager|complain(t)?|refund|unhappy|terrible|ruined|reaction|burn(ed|t)?|emergency|call me|can someone call)\b/i;
export function isHotLead(text) { return HOT_LEAD.test(String(text || '')); }

const HOURS = 6 * 3600e3, OPEN_FOR = 24 * 3600e3;
const fmt = (p) => { const d = String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(p || ''); };
function salonHour(tenant, now) {
  const tz = tenant.timezone || 'America/New_York';
  try { return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(now)) % 24; } catch { return now.getUTCHours(); }
}
const CHANNEL = { sms: 'text', whatsapp: 'WhatsApp', web: 'website chat', voice: 'phone' };

/** Alert the owner about a hot lead. Returns { texted, relayId, reason }. */
export async function escalateLead(c, tenant, { channel = 'sms', phone = '', name = '', text = '', conversationId = null, now = new Date() } = {}) {
  const owner = e164(tenant?.operator_phone || '');
  const lead = e164(phone || '');
  if (!c || !tenant?.id) return { texted: false, reason: 'no_db' };
  if (!owner) return { texted: false, reason: 'no_owner_phone' };
  if (lead && lead === owner) return { texted: false, reason: 'owner_is_lead' };
  const key = lead || ('conv:' + (conversationId || ''));
  // One alert per client per 6 hours.
  try {
    const { data: recent } = await c.from('conversations').select('*').eq('tenant_id', tenant.id).eq('channel', 'relay')
      .gte('started_at', new Date(now.getTime() - HOURS).toISOString());
    if ((recent || []).some((r) => (r.metadata && (r.metadata.key === key)))) return { texted: false, reason: 'recently_alerted' };
  } catch (_) {}
  let relayId = null;
  try {
    const { data } = await c.from('conversations').insert({ tenant_id: tenant.id, channel: 'relay', agent: 'owner', intent: 'hot_lead', status: 'open', started_at: now.toISOString(),
      metadata: { key, phone: lead || null, name: name || null, channel, source_conversation_id: conversationId || null, text: String(text).slice(0, 500) } }).select().maybeSingle();
    relayId = data?.id || null;
  } catch (_) {}
  const h = salonHour(tenant, now);
  if (h < 8 || h >= 21) return { texted: false, relayId, reason: 'night' };   // waits in the Inbox for the morning
  const who = name ? `${name}${lead ? ' ' + fmt(lead) : ''}` : (lead ? fmt(lead) : 'A website visitor');
  const how = lead ? `Reply here and Lola sends it to them, or call ${fmt(lead)}.` : 'They haven’t shared a number yet; Lola is asking for it.';
  const msg = `Hot lead · ${who} on ${CHANNEL[channel] || channel}: "${String(text).replace(/\s+/g, ' ').slice(0, 150)}" ${how}`;
  try {
    const r = await sendSMS({ to: owner, text: msg, tenantId: tenant.id, tenant, skipOptOut: true });
    return { texted: !(r && r.skipped), relayId, reason: r && r.skipped ? r.reason : null };
  } catch (e) { return { texted: false, relayId, reason: 'send_failed' }; }
}

/** The owner texted the salon line. If a hot lead is open, pass the reply on. */
export async function relayOwnerReply(c, tenant, { text = '', now = new Date() } = {}) {
  if (!c || !tenant?.id) return { handled: false };
  let relay = null;
  try {
    const { data } = await c.from('conversations').select('*').eq('tenant_id', tenant.id).eq('channel', 'relay').eq('status', 'open')
      .gte('started_at', new Date(now.getTime() - OPEN_FOR).toISOString()).order('started_at', { ascending: false }).limit(1);
    relay = (data || [])[0] || null;
  } catch (_) {}
  const m = relay?.metadata || {};
  if (!relay || !m.phone) return { handled: false };
  if (/^\s*(done|close|stop relay|end)\s*$/i.test(text)) {
    try { await c.from('conversations').update({ status: 'closed', ended_at: now.toISOString() }).eq('id', relay.id); } catch (_) {}
    await sendSMS({ to: e164(tenant.operator_phone), text: `Closed. Lola takes it from here with ${m.name || fmt(m.phone)}.`, tenantId: tenant.id, tenant, skipOptOut: true }).catch(() => {});
    return { handled: true, closed: true };
  }
  const r = await sendSMS({ to: m.phone, text: String(text).slice(0, 600), tenantId: tenant.id, tenant, type: m.channel === 'whatsapp' ? 'WHATSAPP' : undefined }).catch(() => ({ skipped: true }));
  const sent = !(r && r.skipped);
  if (sent && m.source_conversation_id) { try { await logMessage({ conversationId: m.source_conversation_id, tenantId: tenant.id, role: 'assistant', agent: 'owner', content: text }); } catch (_) {} }
  await sendSMS({ to: e164(tenant.operator_phone), text: sent ? `Sent to ${m.name || fmt(m.phone)}. Keep replying here; text DONE when you're finished.` : `I couldn't text ${m.name || fmt(m.phone)} (they may have opted out). Call them: ${fmt(m.phone)}.`, tenantId: tenant.id, tenant, skipOptOut: true }).catch(() => {});
  return { handled: true, sent };
}

/** A website visitor shared their number after the alert: attach it and tell the owner. */
export const PHONE_IN_TEXT = /(\+?1[\s.-]?)?\(?[2-9]\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
export async function attachLeadPhone(c, tenant, { conversationId, phone, now = new Date() } = {}) {
  const p = e164(phone || '');
  if (!c || !tenant?.id || !conversationId || !p) return { attached: false };
  try {
    const { data } = await c.from('conversations').select('*').eq('tenant_id', tenant.id).eq('channel', 'relay').eq('status', 'open')
      .gte('started_at', new Date(now.getTime() - OPEN_FOR).toISOString());
    const relay = (data || []).find((r) => r.metadata && r.metadata.source_conversation_id === conversationId && !r.metadata.phone);
    if (!relay) return { attached: false };
    await c.from('conversations').update({ metadata: { ...relay.metadata, phone: p } }).eq('id', relay.id);
    if (tenant.operator_phone) await sendSMS({ to: e164(tenant.operator_phone), text: `${relay.metadata.name || 'Your website lead'}'s number: ${fmt(p)}. Reply here and Lola sends it to them.`, tenantId: tenant.id, tenant, skipOptOut: true }).catch(() => {});
    return { attached: true };
  } catch (_) { return { attached: false }; }
}
