/**
 * api/lib/lead-inbox.js — Lola never loses a request.
 * ═══════════════════════════════════════════════════════════════════
 * Every time someone gives Lola their details to book, asks for a call back or leaves a message —
 * on the phone, the website widget, a text or a DM — a copy lands where the salon will see it,
 * whether or not the booking went through:
 *
 *   • the salon is known  → a lead on the salon's dashboard ("Needs you": call them back, with what
 *                            they wanted and why it wasn't booked), the client saved to Clients, and
 *                            the owner told by text + email (once per person per 10 minutes);
 *   • the salon is unknown → the LolaDesk Console (Support), with everything she heard and which
 *                            line it came in on — never dropped.
 *
 * Stored as usage_events kind 'lead' (no new table): the dashboard's notifications, the action
 * center and the Console already read that substrate.
 *
 *   saveLead({ tenant, name, phone, email, service, when, message, channel, reason, salonLine, call })
 *     → { ok, where: 'salon'|'platform'|null, duplicate?, alerted? }
 *   leadSummary(lead) → one human line
 */
import { db, logUsage, e164, upsertClient } from './db.js';

const DEDUPE_MS = 10 * 60e3;
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const REASONS = {
  salon_unknown: 'Lola couldn’t tell which salon this line belongs to',
  unsigned: 'Lola’s booking connection was being repaired',
  service_paused: 'bookings through Lola are paused on this account',
  service_not_found: 'the service wasn’t on the menu',
  conflict: 'that time was taken',
  slot_taken: 'that time was taken',
  no_availability: 'nothing was open then',
  error: 'the booking didn’t go through',
  unfinished: 'they didn’t finish booking',
};
export const reasonWords = (r) => (r ? (REASONS[r] || String(r).replace(/_/g, ' ')) : '');

/**
 * Why a booking attempt didn't end in a booking. Mid-conversation steps (she still needs their email,
 * offered other times) are kept quietly — a later booking closes them; only a real failure alerts the owner.
 */
export function bookingOutcome(result = {}) {
  const soft = Array.isArray(result?.needs) || !!result?.needs_service || Array.isArray(result?.offers) || Array.isArray(result?.slots) || Array.isArray(result?.times);
  return soft ? { reason: 'unfinished', alert: false } : { reason: result?.error || 'error', alert: true };
}

/** A booking went through: any open lead for that number is done. */
export async function leadBooked(tenant, phone) {
  const p = phone ? e164(phone) : '';
  if (!tenant?.id || !p) return;
  try { await logUsage(tenant.id, 'lead_done', 1, { phone: p }); } catch (_) {}
}

export function leadSummary(l = {}) {
  const who = [l.name, l.phone].filter(Boolean).join(' · ') || 'Someone';
  const want = [l.service, l.when].filter(Boolean).join(' ');
  return `${who}${want ? ` wants ${want}` : ''}${l.message ? ` — “${clip(l.message, 160)}”` : ''}${l.reason ? ` (not booked: ${reasonWords(l.reason)})` : ''}${l.channel ? ` [${l.channel}]` : ''}`;
}

async function recentSame(c, tenantId, phone, name) {
  try {
    const { data } = await c.from('usage_events').select('metadata,created_at').eq('tenant_id', tenantId).eq('kind', 'lead')
      .gte('created_at', new Date(Date.now() - DEDUPE_MS).toISOString()).order('created_at', { ascending: false }).limit(20);
    return (data || []).find((r) => (phone && r.metadata?.phone === phone) || (!phone && name && r.metadata?.name === name)) || null;
  } catch (_) { return null; }
}

export async function saveLead({ tenant = null, name = '', phone = '', email = '', service = '', when = '', message = '', channel = '', reason = '', salonLine = '', call = '', alert = true, trusted = true } = {}) {
  const c = db();
  const lead = {
    name: clip(name, 80), phone: phone ? (e164(phone) || clip(phone, 20)) : '', email: clip(email, 120).toLowerCase(),
    service: clip(service, 80), when: clip(when, 60), message: clip(message, 600), channel: clip(channel, 20),
    reason: clip(reason, 40), call: clip(call, 80), status: 'open',
  };
  // Nothing to call back and nothing said: not a lead.
  if (!lead.phone && !lead.email && !lead.message) return { ok: false, where: null };

  if (tenant?.id && c) {
    const dup = await recentSame(c, tenant.id, lead.phone, lead.name);
    // The same person again within minutes (Lola retrying): one lead, not five.
    if (dup && !lead.message && dup.metadata?.service === lead.service && (lead.reason === dup.metadata?.reason || lead.reason === 'unfinished')) return { ok: true, where: 'salon', duplicate: true };
    try { await logUsage(tenant.id, 'lead', 1, lead); } catch (_) { /* still alert below */ }
    // An unverified request (not from LolaDesk's own signed wiring) is kept for the record only: it
    // creates no client and alerts nobody, so a forged request can't spam a salon.
    if (!trusted) return { ok: true, where: 'salon', quiet: true };
    if (lead.phone) { try { await upsertClient(tenant.id, { phone: lead.phone, name: lead.name || undefined, email: lead.email || undefined }); } catch (_) { /* the lead itself is saved */ } }
    let alerted = false;
    if (alert && (!dup || dup.metadata?.reason !== lead.reason)) {
      try {
        const { notifyOwner } = await import('./billing-enforce.js');
        const r = await notifyOwner(tenant, `Lola: ${leadSummary(lead)}. It’s on your LolaDesk dashboard under Needs you.`, { subject: `New request for ${tenant.name || 'your salon'}${lead.name ? ' — ' + lead.name : ''}` });
        alerted = !!(r.texted || r.emailed);
      } catch (_) {}
    }
    return { ok: true, where: 'salon', alerted };
  }

  if (!trusted) return { ok: false, where: null };   // unverified and unroutable: nothing to keep
  // No salon: the LolaDesk team gets it, with the line it came in on, so it can be routed by hand.
  try {
    const { recordTicket } = await import('./customer-care.js');
    const r = await recordTicket(c, {
      name: lead.name || null, phone: lead.phone || null, email: lead.email || null,
      issue: `Unrouted request — ${leadSummary(lead)}${salonLine ? `\nCame in on salon line: ${salonLine}` : '\nNo salon line on the request (website widget missing its salon header?)'}${lead.call ? `\nConversation: ${lead.call}` : ''}`,
      urgency: 'high', channel: 'lead_unrouted',
    });
    return { ok: !!r?.saved, where: 'platform' };
  } catch (_) { return { ok: false, where: null }; }
}

/** The salon's open leads for the dashboard's Needs you list (last 7 days, minus resolved). */
export function leadActions(usage = [], { now = Date.now() } = {}) {
  const out = [];
  // Booked after all (Lola offered another time and they took it): that lead is done.
  const done = usage.filter((e) => e.kind === 'lead_done' && e.metadata?.phone).map((e) => ({ phone: e.metadata.phone, at: Date.parse(e.created_at) }));
  for (const e of usage) {
    if (e.kind !== 'lead' || !e.metadata) continue;
    if (now - Date.parse(e.created_at) > 7 * 86400e3) continue;
    const m = e.metadata;
    if (!m.phone && !m.email && !m.message) continue;   // old count-only rows
    if (m.phone && done.some((d) => d.phone === m.phone && d.at >= Date.parse(e.created_at))) continue;
    out.push({
      id: 'lead:' + String(e.created_at).replace(/[^0-9]/g, '').slice(0, 17) + (m.phone || '').replace(/\D/g, '').slice(-4),
      type: 'lead', priority: m.reason ? 'critical' : 'high',
      title: m.reason ? `Book ${m.name ? m.name.split(' ')[0] : 'this client'} — Lola couldn’t finish` : `Call back ${m.name ? m.name.split(' ')[0] : 'a new client'}`,
      detail: leadSummary(m), phone: m.phone || null, created_at: e.created_at, href: 'clients.html', cta: m.phone ? 'Call back' : 'Open clients',
    });
  }
  return out;
}
