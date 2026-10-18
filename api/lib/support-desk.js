/**
 * api/lib/support-desk.js — a salon's help tickets, through Lola.
 * ═══════════════════════════════════════════════════════════════════
 * The owner never has to find a form: "Lola, tell support the texts aren't going out" →
 * Lola previews it, sends it on their yes, and it lands in the LolaDesk Console → Support
 * (support_tickets, tenant_id set, channel 'lola_in_app') with her own check attached.
 * When the team answers from the Console, Lola tells the owner the next time they talk,
 * and the dashboard's Contact support window lists every request with the team's replies.
 *
 *   openSupportTicket(c, tenant, { message, urgency, user, context, diagnose })
 *   ticketsFor(c, tenantId, { limit })        → [{ id, ref, issue, status, created_at, replies, … }]
 *   supportStatusSay(list)                    → one human sentence (or two)
 *   unseenReplies(c, tenantId)                → { count, latest: { text, at, ticket } }
 *   markSupportSeen(c, tenantId)
 */
import { recordTicket, SUPPORT_EMAIL } from './customer-care.js';

export const SUPPORT_CHANNEL = 'lola_in_app';
const SEEN_KEY = 'support_seen';
const HOURLY_CAP = 5;

export const ticketRef = (id) => String(id || '').replace(/[^a-z0-9]/gi, '').slice(-6).toUpperCase();
const firstName = (s) => String(s || '').trim().split(/\s+/)[0] || '';
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
const dayLabel = (iso) => { try { return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); } catch (_) { return ''; } };
const CHECK_WORDS = { brain: 'her brain', voice: 'her voice', texts: 'texting', telnyx_account: 'the Telnyx account', assistant: 'the phone assistant', all_salons: 'salon lines' };
const STATUS_WORDS = { open: 'waiting for the team', in_progress: 'being worked on', resolved: 'resolved' };

/** The owner's request → a ticket in the Console. → { ok, ticket, ref, say, limited? } */
export async function openSupportTicket(c, tenant, { message = '', urgency = 'normal', user = null, context = '', diagnose = true } = {}) {
  const text = String(message || '').trim();
  if (!c || !tenant?.id) return { ok: false, say: `I can't reach LolaDesk support from here right now — email ${SUPPORT_EMAIL} and they'll help.` };
  if (text.length < 3) return { ok: false, needs_detail: true, say: "What's going on? Tell me in a sentence and I'll get it to the LolaDesk team." };
  try {
    const { data: recent } = await c.from('support_tickets').select('id,created_at').eq('tenant_id', tenant.id)
      .gte('created_at', new Date(Date.now() - 3600e3).toISOString()).limit(HOURLY_CAP + 1);
    if ((recent || []).length >= HOURLY_CAP) return { ok: false, limited: true, say: "The team already has your messages from this past hour — they'll reply soon, and I'll tell you the moment they do." };
  } catch (_) { /* the cap is a courtesy, never a blocker */ }

  // What Lola sees about herself right now, so the team starts with facts, not "it's broken".
  let check = '';
  if (diagnose) {
    try {
      const { lolaSelfCheck } = await import('./lola-doctor.js');
      const chk = await Promise.race([lolaSelfCheck(tenant, { speakTest: false }), new Promise((r) => setTimeout(() => r(null), 6000))]);
      const bad = (chk?.checks || []).filter((x) => x && x.ok === false).map((x) => CHECK_WORDS[x.key] || String(x.key || '').replace(/_/g, ' ')).filter(Boolean);
      check = chk ? (bad.length ? `Lola's own check: ${bad.slice(0, 6).join(', ')} need attention.` : "Lola's own check: everything passed.") : '';
    } catch (_) { /* no diagnosis is fine */ }
  }
  const issue = [text, context ? `What they were doing: ${clip(context, 600)}` : '', check].filter(Boolean).join('\n\n');
  const r = await recordTicket(c, {
    tenant_id: tenant.id, business: tenant.name || null,
    name: user?.user_metadata?.name || user?.user_metadata?.full_name || tenant.owner_name || null,
    email: user?.email || tenant.owner_email || null, phone: tenant.owner_phone || tenant.operator_phone || null,
    issue, urgency: urgency === 'high' ? 'high' : 'normal', channel: SUPPORT_CHANNEL,
  });
  if (!r.saved) return { ok: false, say: `That didn't go through on my side — email ${SUPPORT_EMAIL} and they'll help right away.` };
  let id = null;
  try {
    const { data } = await c.from('support_tickets').select('id,created_at').eq('tenant_id', tenant.id).order('created_at', { ascending: false }).limit(1);
    id = data?.[0]?.id || null;
  } catch (_) {}
  const ref = id ? ticketRef(id) : '';
  const how = [r.ticket.phone && 'text', r.ticket.email && 'email'].filter(Boolean).join(' or ');
  return { ok: true, ticket: { ...r.ticket, id }, ref, alerted: r.alerted,
    say: `Sent${ref ? ` — ticket ${ref}` : ''}. The LolaDesk team usually answers within one business day${how ? ` by ${how}` : ''}, and I'll tell you here the moment they do.` };
}

/** A salon's recent requests, newest first. */
export async function ticketsFor(c, tenantId, { limit = 10 } = {}) {
  if (!c || !tenantId) return [];
  try {
    const { data } = await c.from('support_tickets').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(limit);
    return (data || []).map((t) => ({
      id: t.id, ref: ticketRef(t.id), issue: String(t.issue || '').split('\n\n')[0], status: t.status || 'open',
      urgency: t.urgency || 'normal', created_at: t.created_at, resolved_at: t.resolved_at || null,
      replies: (Array.isArray(t.replies) ? t.replies : []).map((x) => ({ at: x.at, text: x.text, via: x.via })),
    }));
  } catch (_) { return []; }
}

/** "Your ticket about … — the team replied Tue Oct 20: "…"" */
export function supportStatusSay(list) {
  const open = (list || []).filter((t) => t.status !== 'resolved');
  if (!list?.length) return "You haven't asked LolaDesk support for anything yet. If something isn't working, just tell me and I'll send it to the team.";
  const t = open[0] || list[0];
  const last = t.replies[t.replies.length - 1];
  const about = `"${clip(t.issue, 70)}"`;
  const head = last
    ? `The team answered your request ${about} on ${dayLabel(last.at)}: "${clip(last.text, 220)}"`
    : `Your request ${about} (ticket ${t.ref}) is ${STATUS_WORDS[t.status] || 'open'} — sent ${dayLabel(t.created_at)}.`;
  const more = open.length > 1 ? ` You have ${open.length} open requests in all.` : (!open.length ? ' Everything you asked about is resolved.' : '');
  return head + more;
}

async function seenAt(c, tenantId) {
  try {
    const { data } = await c.from('client_memories').select('value').eq('tenant_id', tenantId).eq('client_phone', 'owner').eq('key', SEEN_KEY).maybeSingle();
    return Date.parse(data?.value?.at || '') || 0;
  } catch (_) { return 0; }
}
export async function markSupportSeen(c, tenantId) {
  if (!c || !tenantId) return;
  try { await c.from('client_memories').upsert({ tenant_id: tenantId, client_phone: 'owner', key: SEEN_KEY, value: { at: new Date().toISOString() } }, { onConflict: 'tenant_id,client_phone,key' }); } catch (_) {}
}

/** Team replies the owner hasn't heard yet. → { count, latest } */
export async function unseenReplies(c, tenantId) {
  const list = await ticketsFor(c, tenantId, { limit: 10 });
  const since = await seenAt(c, tenantId);
  const fresh = [];
  for (const t of list) for (const r of t.replies) if (Date.parse(r.at || '') > since) fresh.push({ ...r, ticket: t });
  fresh.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { count: fresh.length, latest: fresh[0] || null };
}

/** One line for the briefing when the team has answered. */
export async function supportBriefLine(c, tenant, { owner = '' } = {}) {
  const u = await unseenReplies(c, tenant.id);
  if (!u.count) return null;
  const who = firstName(owner);
  return `${who ? who + ', ' : ''}LolaDesk support answered your request "${clip(u.latest.ticket.issue, 60)}": "${clip(u.latest.text, 180)}"${u.count > 1 ? ` (${u.count} new replies — open Contact support to see them all)` : ''}.`;
}
