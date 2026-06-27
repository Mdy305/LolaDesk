/**
 * /api/operator-tools — Privileged skill layer for the owner-facing "Jarvis".
 * ════════════════════════════════════════════════════════════════════════
 * The OWNER talks to Lola to run the salon by voice. Telnyx's operator
 * assistant calls this webhook for every action, exactly like the public
 * lola-tools endpoint — ONE endpoint, the `tool` field selects the skill —
 * but these skills can change the book and message clients, so they're gated.
 *
 * SECURITY
 *   1. Shared secret: requests must carry  x-lola-operator-secret == OPERATOR_TOOLS_SECRET
 *      (set on the Telnyx tool's webhook headers). Blocks the public internet.
 *   2. Two-phase confirm for destructive tools (move / cancel / broadcast):
 *        preview call  ->  { needs_confirmation:true, confirm_token, speak:"...say your PIN and 'confirm'" }
 *        confirm call  ->  same tool + { confirm:true, confirm_token, pin:"1234" }  -> executes
 *      The confirm_token is an HMAC of the resolved action, so nothing is
 *      stored server-side and the action can't be tampered between steps.
 *   3. The PIN must match tenant.operator_pin_hash. No PIN set => no changes.
 *
 * SKILLS
 *   whats_my_day        read the schedule for a day
 *   find_revenue        booked revenue for today / week / month / date
 *   who_is_due          clients overdue for a rebooking
 *   move_appointment    reschedule a booking            (destructive → confirm + PIN)
 *   cancel_appointment  cancel a booking                (destructive → confirm + PIN)
 *   broadcast_text      text a segment of clients       (destructive → confirm + PIN)
 *   book_for_client     add a booking
 *
 * Webhook contract:  POST { tool, tenant|to, ...args }  ->  { speak, ... }
 * Never throws at the caller; failures degrade to a graceful spoken line.
 */

import { getTenantBySlug, getTenantByPhone, createBooking, upsertClient } from './lib/db.js';
import { sendSMS } from './telnyx-sms.js';
import {
  listBookings, enrichBookings, findBooking, cancelBooking, moveBooking,
  revenueSummary, dueForRebooking, broadcastAudience,
  resolveDate, computeNewStart, pinOk, isKnownOperator, signAction, verifyAction,
  tenantToolSecret
} from './lib/operator-db.js';

// ── spoken formatting helpers ─────────────────────────────────────────────
const money = n => `$${(Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US')}`;
const timeLabel = iso => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const dayLabel = d => new Date(d).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
const first = n => String(n || '').split(' ')[0];

// Resolve which salon this operator session belongs to.
async function resolveTenant(body){
  if(body.tenant) return getTenantBySlug(body.tenant);
  const to = body.to || body.To || body.called_number || '';
  return getTenantByPhone(to);
}

function rangeFromArgs(args){
  const now = new Date();
  const r = String(args.range || '').toLowerCase();
  if(r === 'week'){ const f = new Date(now); f.setDate(f.getDate() - f.getDay()); return { from: f, to: now, label: 'this week' }; }
  if(r === 'month'){ const f = new Date(now.getFullYear(), now.getMonth(), 1); return { from: f, to: now, label: 'this month' }; }
  if(args.from && args.to) return { from: new Date(args.from), to: new Date(args.to), label: 'that range' };
  const d = resolveDate(args.date);
  return { from: d, to: d, label: args.date ? dayLabel(d) : 'today' };
}

// Build the "needs confirmation" response with a signed token binding the action.
function needConfirm(tenant, tool, k, speak){
  return { speak, needs_confirmation: true, confirm_token: signAction({ t: tenant.id, tool, k }) };
}
// Validate a confirm call. Returns the signed action payload `k`, or an error speak.
function takeConfirm(tenant, tool, args){
  const v = verifyAction(args.confirm_token);
  if(!v || v.t !== tenant.id || v.tool !== tool){
    return { error: "That confirmation expired — tell me what you'd like again." };
  }
  if(!pinOk(tenant, args.pin)){
    return { error: tenant.operator_pin_hash
      ? "That PIN doesn't match, so I didn't make any changes."
      : "No operator PIN is set up yet, so I can't make changes by voice." };
  }
  return { k: v.k };
}

// ── SKILL: read the day ───────────────────────────────────────────────────
async function whats_my_day(tenant, args){
  const date = resolveDate(args.date);
  const rows = await enrichBookings(tenant.id, await listBookings(tenant.id, { from: date, to: date }));
  if(!rows.length) return { speak: `Nothing on the books for ${dayLabel(date)} yet.`, count: 0, appointments: [] };
  const lines = rows.map(b =>
    `${timeLabel(b.starts_at)} ${b.service}${b.client_name ? ` for ${first(b.client_name)}` : ''}${b.stylist ? ` with ${b.stylist}` : ''}`
  );
  return { speak: `${rows.length} on ${dayLabel(date)}: ${lines.join('; ')}.`, count: rows.length, appointments: rows };
}

// ── SKILL: revenue ────────────────────────────────────────────────────────
async function find_revenue(tenant, args){
  const { from, to, label } = rangeFromArgs(args);
  const { total, count } = await revenueSummary(tenant.id, { from, to });
  return { speak: `${label}: ${money(total)} booked across ${count} appointment${count === 1 ? '' : 's'}.`, total, count };
}

// ── SKILL: who's due to rebook ────────────────────────────────────────────
async function who_is_due(tenant, args){
  const since = Number(args.since_days) || 42;
  const rows = await dueForRebooking(tenant.id, { sinceDays: since });
  if(!rows.length) return { speak: `No one's overdue past ${since} days — your book is tight.`, count: 0, clients: [] };
  const names = rows.slice(0, 8).map(c => c.name || 'a client').join(', ');
  return {
    speak: `${rows.length} due for rebooking: ${names}${rows.length > 8 ? ', and more' : ''}. Want me to text them?`,
    count: rows.length, clients: rows
  };
}

// ── SKILL: move an appointment (destructive) ──────────────────────────────
async function move_appointment(tenant, args){
  if(args.confirm){
    const r = takeConfirm(tenant, 'move_appointment', args);
    if(r.error) return { speak: r.error };
    const moved = await moveBooking(tenant.id, r.k.id, r.k.new_starts_at);
    if(!moved) return { speak: "I couldn't find that appointment to move." };
    return {
      speak: `Done — moved to ${dayLabel(r.k.new_starts_at)} at ${timeLabel(r.k.new_starts_at)}.${moved.external_source ? ` Heads up: it also lives in ${moved.external_source}, so update that too.` : ''}`,
      moved: true
    };
  }
  const matches = await findBooking(tenant.id, args);
  if(!matches.length) return { speak: "I don't see that appointment — which client and time?" };
  if(matches.length > 1){
    return { speak: `I see ${matches.length} that match — which one? ${matches.map(m => `${timeLabel(m.starts_at)} ${m.client_name || m.service}`).join(', ')}`, ambiguous: true };
  }
  const b = matches[0];
  const new_starts_at = computeNewStart(b.starts_at, args);
  return needConfirm(tenant, 'move_appointment', { id: b.id, new_starts_at },
    `Move ${b.client_name || b.service} from ${timeLabel(b.starts_at)} to ${timeLabel(new_starts_at)} on ${dayLabel(new_starts_at)}? Say your PIN and "confirm".`);
}

// ── SKILL: cancel an appointment (destructive) ────────────────────────────
async function cancel_appointment(tenant, args){
  if(args.confirm){
    const r = takeConfirm(tenant, 'cancel_appointment', args);
    if(r.error) return { speak: r.error };
    const cancelled = await cancelBooking(tenant.id, r.k.id);
    if(!cancelled) return { speak: "I couldn't find that appointment." };
    return { speak: `Cancelled ${r.k.label}. I can text them to rebook if you'd like.`, cancelled: true };
  }
  const matches = await findBooking(tenant.id, args);
  if(!matches.length) return { speak: "I don't see that one — which client and time?" };
  if(matches.length > 1){
    return { speak: `Which one? ${matches.map(m => `${timeLabel(m.starts_at)} ${m.client_name || m.service}`).join(', ')}`, ambiguous: true };
  }
  const b = matches[0];
  const label = `${b.client_name || b.service} at ${timeLabel(b.starts_at)}`;
  return needConfirm(tenant, 'cancel_appointment', { id: b.id, label },
    `Cancel ${label} on ${dayLabel(b.starts_at)}? Say your PIN and "confirm".`);
}

// ── SKILL: broadcast a text to a segment (destructive) ────────────────────
async function broadcast_text(tenant, args){
  if(args.confirm){
    const r = takeConfirm(tenant, 'broadcast_text', args);
    if(r.error) return { speak: r.error };
    // NOTE: sends inline up to the audience cap. For very large lists, route
    // through the existing jobs/worker queue instead of sending here.
    const audience = await broadcastAudience(tenant.id, { segment: r.k.segment, limit: 200 });
    let sent = 0;
    for(const cl of audience){
      try{ await sendSMS({ from: tenant.phone_number, to: cl.phone_number, text: r.k.message, tenantId: tenant.id }); sent++; }
      catch{ /* skip individual failures; report the rest */ }
    }
    return { speak: `Sent to ${sent} client${sent === 1 ? '' : 's'}.`, sent };
  }
  const segment = String(args.segment || 'all').toLowerCase();
  const message = String(args.message || '').trim();
  if(!message) return { speak: "What should the message say?" };
  const audience = await broadcastAudience(tenant.id, { segment, limit: 200 });
  if(!audience.length) return { speak: `No opted-in clients match "${segment}".`, count: 0 };
  return needConfirm(tenant, 'broadcast_text', { segment, message },
    `This texts ${audience.length} ${segment === 'all' ? 'clients' : segment + ' clients'}: "${message}". Say your PIN and "confirm" to send.`);
}

// ── SKILL: book for a client ──────────────────────────────────────────────
async function book_for_client(tenant, args){
  const { client_name, client_phone, service, date, time, stylist } = args;
  const svc = (tenant.services || []).find(s => s.name.toLowerCase().includes(String(service || '').toLowerCase()));
  let client = null;
  if(client_phone) client = await upsertClient(tenant.id, { phone: client_phone, name: client_name });
  const startsAt = computeNewStart(new Date().toISOString(), { new_date: date, new_time: time });
  const bk = await createBooking(tenant.id, {
    clientId: client?.id, service: svc?.name || service, stylist,
    startsAt, durationMin: svc?.durationMin || 60, price: svc?.price
  });
  if(!bk) return { speak: "I couldn't save that just now — try again in a moment." };
  return { speak: `Booked ${svc?.name || service}${client_name ? ` for ${first(client_name)}` : ''} on ${dayLabel(startsAt)} at ${timeLabel(startsAt)}.`, booked: true };
}

export const OPERATOR_SKILLS = {
  whats_my_day, find_revenue, who_is_due,
  move_appointment, cancel_appointment, broadcast_text, book_for_client
};

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-lola-operator-secret');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).json({ speak: 'Method not allowed' });

  // Gate 1: shared secret. Accept the legacy global secret (back-compat) OR
  // this tenant's derived secret (set per-tool at provision time), so a leaked
  // header only works for one salon.
  const provided = req.headers['x-lola-operator-secret'];
  const slug = (req.query && req.query.tenant) || '';
  const master = process.env.OPERATOR_TOOLS_SECRET;
  const ok = master && provided && (provided === master || (slug && provided === tenantToolSecret(slug)));
  if(!ok){
    return res.status(401).json({ speak: "I can't run owner commands from here." });
  }

  try{
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    // tool + tenant ride in the URL query (set at provision time); the model
    // fills the rest into the JSON body. Merge, with body winning on overlap.
    const args = { ...(req.query || {}), ...body };
    const tool = args.tool || args.function || args.skill;

    if(!tool || !OPERATOR_SKILLS[tool]){
      return res.status(200).json({
        speak: "I can check your day, find revenue, flag rebookings, move or cancel appointments, or text clients.",
        available_tools: Object.keys(OPERATOR_SKILLS)
      });
    }

    const tenant = await resolveTenant(args);
    if(!tenant?.id) return res.status(200).json({ speak: "I couldn't tell which salon this is." });

    // Soft signal for the assistant's phrasing (not an authorization).
    args._known_operator = isKnownOperator(tenant, args.from);

    const result = await OPERATOR_SKILLS[tool](tenant, args);
    return res.status(200).json(result);
  }catch(e){
    console.error('[operator-tools]', e);
    return res.status(200).json({ speak: "I hit a snag running that — try again in a moment.", _error: String(e) });
  }
}
