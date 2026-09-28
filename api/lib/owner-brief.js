/**
 * api/lib/owner-brief.js — "while you were away" and owner alerts.
 * ════════════════════════════════════════════════════════════════
 * One read of what happened since a moment in time: calls Lola took, who
 * needs the owner personally, bookings made and cancelled, what Autopilot
 * did. Used by:
 *   · GET /api/lola/away           — the brief Lola shows when you come back
 *   · owner tool `away_brief`      — "what did I miss?"
 *   · /api/cron/owner-alerts       — texts the owner only when something needs them
 * Read-only. Every query is wrapped so one missing table never breaks the brief.
 */
import { e164 } from './db.js';

// Calls that did not end in a finished conversation with Lola.
const NOT_ANSWERED = new Set(['no-answer', 'busy', 'failed', 'canceled', 'cancelled', 'missed', 'voicemail', 'abandoned']);
// Callers who asked for a person, or were unhappy.
const ESCALATE = /\b(manager|the owner|speak (to|with) (a |the )?(person|human|someone|owner|manager)|real person|complain\w*|refund|upset|angry|terrible|lawyer|call me back|callback)\b/i;

const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
const nameOf = (c) => (c && ([c.first_name, c.last_name].filter(Boolean).join(' ') || c.name)) || '';
const first = (s) => String(s || '').split(' ')[0];
export const prettyPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); const t = d.length === 11 && d[0] === '1' ? d.slice(1) : d; return t.length === 10 ? `(${t.slice(0, 3)}) ${t.slice(3, 6)}-${t.slice(6)}` : String(p || ''); };

async function rows(p) {
  try { const r = await p; return (r && !r.error && Array.isArray(r.data)) ? r.data : []; } catch { return []; }
}

function transcriptOf(call) {
  const t = String(call.recording_url || call.transcript || '');
  return /^https?:\/\//i.test(t) ? '' : t;
}
function callerWords(t) {
  // Only what the caller said, so Lola's own lines ("I'll have the owner call you") don't trigger.
  return t.split(/\n+/).filter(l => /^\s*(caller|client|customer|user)\s*:/i.test(l)).join('\n') || t;
}

/** Why a call needs the owner (null = it doesn't). */
export function callNeedsOwner(call) {
  if (!call || call.handled_at) return null;
  if (String(call.direction || 'inbound') !== 'inbound') return null;
  const status = String(call.status || '').toLowerCase();
  const words = callerWords(transcriptOf(call));
  if (ESCALATE.test(words)) return /refund|complain|upset|angry|terrible|lawyer/i.test(words) ? 'unhappy' : 'asked_for_you';
  if (NOT_ANSWERED.has(status)) return 'missed';
  return null;
}

/**
 * @param c       supabase client
 * @param tenant  { id, name }
 * @param since   ISO timestamp
 * @param opts    { now?: Date }
 */
export async function awayBrief(c, tenant, since, opts = {}) {
  const now = opts.now || new Date();
  const tid = tenant.id;

  const [calls, made, cancelled, runs] = await Promise.all([
    rows(c.from('calls').select('*').eq('tenant_id', tid).gte('created_at', since).order('created_at', { ascending: false }).limit(300)),
    rows(c.from('bookings').select('*').eq('tenant_id', tid).gte('created_at', since).order('created_at', { ascending: false }).limit(300)),
    rows(c.from('bookings').select('*').eq('tenant_id', tid).eq('status', 'cancelled').gte('updated_at', since).limit(200)),
    rows(c.from('agent_runs').select('*').eq('tenant_id', tid).gte('ran_at', since).order('ran_at', { ascending: false }).limit(20)),
  ]);

  const newBookings = made.filter(b => b.status !== 'cancelled');
  // A booking made AND cancelled while away is only a cancellation.
  const cancels = cancelled.filter(b => !made.some(m => m.id === b.id && m.status !== 'cancelled'));

  // Names for everyone involved, in one query each.
  const clientIds = [...new Set([...newBookings, ...cancels].map(b => b.client_id).filter(Boolean))];
  const phones = [...new Set(calls.map(k => e164(k.from_number)).filter(Boolean))];
  const [byIdRows, byPhoneRows] = await Promise.all([
    clientIds.length ? rows(c.from('clients').select('*').eq('tenant_id', tid).in('id', clientIds)) : [],
    phones.length ? rows(c.from('clients').select('*').eq('tenant_id', tid).in('phone', phones)) : [],
  ]);
  const byId = new Map(byIdRows.map(r => [r.id, r]));
  const byPhone = new Map(byPhoneRows.map(r => [r.phone, r]));

  const inbound = calls.filter(k => String(k.direction || 'inbound') === 'inbound');
  const seen = new Set();
  const needs = [];
  for (const k of inbound) {
    const why = callNeedsOwner(k);
    const phone = e164(k.from_number);
    if (!why || !phone || seen.has(phone)) continue;
    seen.add(phone);
    const cl = byPhone.get(phone);
    const name = nameOf(cl);
    needs.push({
      kind: 'callback', reason: why, call_id: k.id, phone, client_id: cl?.id || null,
      name: name || prettyPhone(phone), known: !!name, vip: !!(cl && (cl.is_vip || cl.status === 'vip')), at: k.created_at,
      action: `Call ${name || prettyPhone(phone)} back`,
    });
  }
  // VIPs and unhappy callers first.
  const rank = (n) => (n.reason === 'unhappy' ? 0 : n.vip ? 1 : n.reason === 'asked_for_you' ? 2 : 3);
  needs.sort((a, b) => rank(a) - rank(b));

  const bookedValue = newBookings.reduce((s, b) => s + (Number(b.total_amount ?? b.price) || 0), 0);
  const byLola = newBookings.filter(b => !b.source || /lola|voice|sms|phone|widget/i.test(String(b.source))).length;
  const soonCancels = cancels.filter(b => {
    const t = new Date(b.start_time).getTime();
    return t > now.getTime() && t - now.getTime() < 48 * 3600e3;
  });

  const counts = {
    calls: inbound.length,
    needs_you: needs.length,
    booked: newBookings.length,
    booked_by_lola: byLola,
    booked_value: Math.round(bookedValue),
    cancelled: cancels.length,
    autopilot: runs.length,
  };

  // ── Lola's words ──
  const parts = [];
  if (counts.calls) parts.push(`took ${plural(counts.calls, 'call')}`);
  if (counts.booked) parts.push(`booked ${plural(counts.booked, 'appointment')}${counts.booked_value ? ` (${money(counts.booked_value)})` : ''}`);
  let say = parts.length ? `While you were away I ${parts.join(' and ')}.` : '';
  if (counts.cancelled) {
    const who = cancels.slice(0, 2).map(b => first(nameOf(byId.get(b.client_id)))).filter(Boolean);
    say += ` ${plural(counts.cancelled, 'cancellation')}${who.length ? ` (${who.join(', ')})` : ''}.`;
  }
  if (needs.length) {
    const n = needs[0];
    const why = n.reason === 'unhappy' ? 'sounded unhappy' : n.reason === 'asked_for_you' ? 'asked for you' : 'called and I missed them';
    say += ` ${n.known ? first(n.name) : `A caller at ${n.name}`}${n.vip ? ' (VIP)' : ''} ${why}${needs.length > 1 ? `, and ${plural(needs.length - 1, 'other person', 'others')} need${needs.length - 1 === 1 ? 's' : ''} a call back` : ''}. Want me to call ${needs.length > 1 || !n.known ? 'them' : first(n.name)} back?`;
  }
  const autopilot = runs.map(r => r.summary).filter(Boolean).slice(0, 3);
  if (autopilot.length && !say) say = `While you were away: ${autopilot[0]}`;
  say = say.trim();

  const notable = !!(counts.calls || counts.booked || counts.cancelled || needs.length);
  const headline = notable
    ? [counts.calls && plural(counts.calls, 'call'), counts.booked && `${counts.booked} booked`, needs.length && `${needs.length} need${needs.length === 1 ? 's' : ''} you`].filter(Boolean).join(' · ')
    : '';

  const suggestions = [];
  if (needs[0]) suggestions.push(needs[0].action);
  if (soonCancels.length) suggestions.push('Fill the cancelled slot');
  suggestions.push('Catch me up on today');

  return {
    since, counts, notable, headline,
    say: say || "All quiet while you were away. Nothing needs you.",
    needs: needs.slice(0, 8),
    bookings: newBookings.slice(0, 8).map(b => ({ id: b.id, client: nameOf(byId.get(b.client_id)) || 'A client', start_time: b.start_time, amount: Number(b.total_amount ?? b.price) || 0 })),
    cancellations: cancels.slice(0, 8).map(b => ({ id: b.id, client: nameOf(byId.get(b.client_id)) || 'A client', start_time: b.start_time, soon: soonCancels.includes(b) })),
    autopilot,
    suggestions: suggestions.slice(0, 3),
  };
}

/** The owner alert text: only what needs them, short enough for one SMS. */
export function alertText(brief, tenantName) {
  const lines = [];
  for (const n of brief.needs.slice(0, 3)) {
    const why = n.reason === 'unhappy' ? 'sounded unhappy' : n.reason === 'asked_for_you' ? 'asked for you' : 'called, missed';
    lines.push(`• ${n.known ? n.name : 'Caller'}${n.vip ? ' (VIP)' : ''} ${why}: ${prettyPhone(n.phone)}`);
  }
  if (brief.needs.length > 3) lines.push(`• +${brief.needs.length - 3} more to call back`);
  for (const b of brief.cancellations.filter(x => x.soon).slice(0, 2)) lines.push(`• ${b.client} cancelled a booking in the next 48h`);
  if (!lines.length) return '';
  return `Lola · ${tenantName || 'your salon'}\n${lines.join('\n')}\nOpen LolaDesk → Calls to call back, or tell Lola "call them back".`;
}
