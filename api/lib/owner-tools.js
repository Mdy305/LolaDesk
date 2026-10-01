/**
 * api/lib/owner-tools.js — what Lola can DO for the salon owner.
 * ════════════════════════════════════════════════════════════════
 * The caller-facing SKILLS (book, price, upsell, take a message) serve a
 * client on the phone. These tools serve the OWNER in the dashboard:
 * run the day, text or call clients, move/cancel/no-show bookings, work the
 * waitlist, fill gaps, and read revenue. Every tool goes through the app's
 * existing engines — booking-repository, /api/calendar, the SMS funnel,
 * the call-callback originate path, fill-gap — never raw inserts.
 *
 * Anything that reaches a client (text, call, cancel, move, no-show, fill)
 * is two-step: the first call returns a preview and parks the action as
 * "pending"; it only runs when the owner says yes (see takePendingAction).
 */
import { db, e164 } from './db.js';
import { getBookingSettings, updateCanonicalBooking, addToWaitlist, listServices, listStaff } from './booking-repository.js';
import { dayBoundsUtc, localDateKey, zonedLocalToUtc } from './timezone.js';
import { sendSms } from './sms.js';
import { originateCallback } from './call-callback.js';
import { awayBrief } from './owner-brief.js';
import { learnBusiness, parseKnowledge } from './business-learn.js';
import { SEGMENTS, audience, createCampaign, startCampaign, campaignsWithStats, inSendingHours } from './marketing.js';
import { buildFillPlan, latestPlan, setPlanStatus } from './fill-plan.js';
import { askToConfirm, confirmationStatus } from './appointment-confirm.js';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SEND_CAP = 25; // max clients one segment text can reach
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ── tool declarations (OpenAI function format, used by Telnyx inference) ──
const clientArg = { type: 'string', description: 'Client name or phone number, e.g. "Sarah Lee" or "+13055551234".' };
const dateArg = { type: 'string', description: 'today, tomorrow, a weekday (friday), or YYYY-MM-DD.' };
const confirmedArg = { type: 'boolean', description: 'Leave false. The system confirms with the owner before anything is sent.' };
const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

export const OWNER_TOOLS = [
  fn('today_brief', "Summarize a day for the owner: bookings (who, when, what), open gaps, and today's calls. Use for 'catch me up', 'what's today', 'how's my day'.", { date: dateArg }),
  fn('revenue_report', 'Booked revenue for a period compared with the previous one.', { period: { type: 'string', enum: ['today', 'week', 'month'] } }),
  fn('find_client', 'Look up a client: phone, last visit, next booking.', { client: clientArg }, ['client']),
  fn('list_bookings', "List bookings for a day, or a client's upcoming bookings.", { date: dateArg, client: clientArg }),
  fn('text_client', 'Text one client from the salon line.', { client: clientArg, message: { type: 'string' }, confirmed: confirmedArg }, ['client', 'message']),
  fn('launch_campaign', 'Launch a marketing text campaign to a whole audience of any size (lapsed = not seen in N days, vip, recent = seen in the last 30 days, tomorrow = booked tomorrow, all). Sent in paced batches between 9am and 8pm with an opt-out line, nobody texted twice in a week, bookings it wins are tracked. Use this for marketing to groups.', {
    segment: { type: 'string', enum: ['lapsed', 'vip', 'recent', 'tomorrow', 'all'] }, days: { type: 'integer', description: 'For lapsed: days since last visit (default 60).' },
    message: { type: 'string', description: 'The text. Use {first_name} for personalization.' }, name: { type: 'string' }, confirmed: confirmedArg,
  }, ['segment', 'message']),
  fn('campaign_report', 'How recent marketing campaigns are doing: sent, bookings won, revenue.'),
  fn('fill_plan', "Lola's 30-day plan to keep the chairs full: open hours, slow days, who is due back, the campaign calendar and projected bookings. action 'show' explains it, 'rebuild' refreshes it with today's numbers, 'approve' starts it, 'pause' stops it, 'autopilot' lets it run without asking. Use for 'how do we fill next month', 'marketing plan', 'strategy', 'fill my chairs'.", {
    action: { type: 'string', enum: ['show', 'rebuild', 'approve', 'pause', 'autopilot'] }, confirmed: confirmedArg,
  }),
  fn('text_clients_segment', 'Text a small group of clients right now (25 max): lapsed = not seen in N days, vip, or tomorrow = everyone booked tomorrow. For marketing to a larger audience use launch_campaign.', {
    segment: { type: 'string', enum: ['lapsed', 'vip', 'tomorrow'] },
    days: { type: 'integer', description: 'For lapsed: days since last visit (default 60).' },
    message: { type: 'string' }, confirmed: confirmedArg,
  }, ['segment', 'message']),
  fn('call_client', 'Have Lola phone a client now from the salon line.', { client: clientArg, confirmed: confirmedArg }, ['client']),
  fn('cancel_booking', "Cancel a client's booking. The client gets the salon's cancellation text and the freed slot is offered to the waitlist.", { client: clientArg, date: dateArg, confirmed: confirmedArg }, ['client']),
  fn('reschedule_booking', "Move a client's booking to a new date and time (checks availability, texts the client the new time).", {
    client: clientArg, date: { ...dateArg, description: 'Current booking date if the client has several.' },
    new_date: dateArg, new_time: { type: 'string', description: 'e.g. 3pm or 15:00' }, confirmed: confirmedArg,
  }, ['client', 'new_date', 'new_time']),
  fn('mark_no_show', "Mark a client's booking as a no-show.", { client: clientArg, date: dateArg, confirmed: confirmedArg }, ['client']),
  fn('add_to_waitlist', 'Put a client on the waitlist for the next opening.', { client: clientArg, preferred_date: dateArg, service: { type: 'string' } }, ['client']),
  fn('fill_gap', 'Offer an open slot to waitlisted and lapsed clients by text.', { date: dateArg, time: { type: 'string' }, duration_minutes: { type: 'integer' }, confirmed: confirmedArg }, ['date', 'time']),
  fn('away_brief', "What happened while the owner was away: calls, who needs a call back, bookings made and cancelled. Use for 'what did I miss', 'anything I should know'.", { hours: { type: 'integer', description: 'How far back, in hours (default 12).' } }),
  fn('set_alerts', 'Turn owner text alerts on or off (Lola texts the owner when a caller asks for them, is unhappy or was missed, or a booking in the next 48h is cancelled), and/or set the phone they go to.', { enabled: { type: 'boolean' }, phone: { type: 'string', description: "Owner's mobile number for alerts." } }),
  fn('learn_business', "Read the salon's website and/or a menu the owner pastes, and learn services, prices, team, hours, FAQ, brand voice and marketing ideas. Use for 'learn my website', 'read my site', or when the owner pastes a price list.", { website: { type: 'string' }, notes: { type: 'string', description: 'Menu, prices or anything the owner pasted.' } }),
  fn('confirm_appointments', "Text every client booked on a day asking them to confirm (reply YES) or reschedule. Use for 'confirm tomorrow's appointments', 'send confirmations'.", { date: dateArg, confirmed: confirmedArg }),
  fn('confirmation_status', "Who has confirmed their appointment for a day and who hasn't. Use for 'who confirmed tomorrow', 'confirmations'.", { date: dateArg }),
  fn('open_page', 'Open a page of LolaDesk for the owner.', { page: { type: 'string', enum: ['calendar', 'dashboard', 'clients', 'calls', 'inbox', 'revenue', 'settings', 'growth', 'reviews', 'team', 'services', 'banking', 'pos', 'marketing'] } }, ['page']),
];
export const OWNER_TOOL_NAMES = new Set(OWNER_TOOLS.map(t => t.function.name));
const NEEDS_CONFIRM = new Set(['confirm_appointments', 'launch_campaign', 'text_client', 'text_clients_segment', 'call_client', 'cancel_booking', 'reschedule_booking', 'mark_no_show', 'fill_gap']);

const PAGES = {
  calendar: '/calendar', dashboard: '/dashboard', clients: '/clients', calls: '/calls', inbox: '/inbox',
  revenue: '/revenue', settings: '/settings', growth: '/growth-os', reviews: '/reviews', team: '/team',
  services: '/services', banking: '/banking', pos: '/pos', marketing: '/campaigns',
};

// ── owner-command detection: these skip the caller fast-paths in the brain ──
const OWNER_VERBS = /\b(text|sms|message|call|ring|phone|cancel|move|reschedule|push|no[- ]?show|didn'?t show|waitlist|fill|revenue|sales|made|brief|catch me up|summary|how'?s my|what'?s (on )?(today|tomorrow)|who'?s (coming|booked)|open the|go to|show me|find|look up|lookup|what did i miss|did i miss|while i was|alerts?|notify me|alert me|learn|read my|my website|my site|grow|campaign|marketing|promot\w*)\b/i;
export function isOwnerCommand(text) { return OWNER_VERBS.test(String(text || '')); }

const YES = /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|do it|send( it)?|go( ahead)?|confirm(ed)?|please do|absolutely|correct|that'?s right)\b[\s.!]*$/i;
const NO = /^\s*(no|nope|don'?t|cancel that|stop|never ?mind|wait|hold on|not now)\b/i;
export function isAffirmative(t) { return YES.test(String(t || '')); }
export function isNegative(t) { return NO.test(String(t || '')); }

export async function ownerSystemPrompt(tenant) {
  const tz = await tenantTz(tenant.id);
  const today = localDateKey(new Date(), tz);
  const wd = WEEKDAYS[new Date(`${today}T12:00:00Z`).getUTCDay()];
  return [
    `You are Lola, the AI front desk and marketing manager of ${tenant.name || 'this salon'}. You are speaking with the OWNER inside LolaDesk.`,
    `Today is ${wd} ${today} (salon timezone ${tz}).`,
    'When the owner asks you to do something, call the matching tool. Never claim you did something unless a tool result says it happened.',
    'Keep spoken replies short: one or two sentences, warm and plain.',
    'For texts, calls, cancellations, moves, no-shows and gap fills, call the tool with confirmed=false; the system shows the owner a preview and asks them to confirm.',
    'You are also their marketing manager: when they ask how to grow, give 2-3 specific moves for THIS business (who to text, what offer, when), then offer to send the text with text_clients_segment.',
    marketingBrief(tenant),
  ].filter(Boolean).join('\n');
}

function marketingBrief(tenant) {
  const k = parseKnowledge(tenant && tenant.knowledge);
  const m = k.marketing || {};
  const lines = [];
  if (k.summary) lines.push(`About the business: ${k.summary}`);
  if (k.positioning || k.tone) lines.push(`Brand: ${[k.positioning, k.tone].filter(Boolean).join(', ')}`);
  if (k.audience || m.ideal_client) lines.push(`Ideal client: ${m.ideal_client || k.audience}`);
  if (k.usp) lines.push(`What makes them special: ${k.usp}`);
  if (Array.isArray(m.opportunities) && m.opportunities.length) lines.push(`Growth ideas you already identified: ${m.opportunities.join(' | ')}`);
  if (m.first_campaign && m.first_campaign.message) lines.push(`Your suggested first campaign (${m.first_campaign.segment}): "${m.first_campaign.message}"`);
  return lines.length ? `WHAT YOU KNOW ABOUT THIS BUSINESS:\n${lines.join('\n')}` : '';
}

// ── pending actions: parked until the owner says yes ──
async function setPending(tenantId, action) {
  const c = db(); if (!c) return;
  await c.from('client_memories').upsert(
    { tenant_id: tenantId, client_phone: 'owner_pending', key: 'action', value: action ? { ...action, at: Date.now() } : null },
    { onConflict: 'tenant_id,client_phone,key' });
}
async function getPending(tenantId) {
  const c = db(); if (!c) return null;
  const { data } = await c.from('client_memories').select('value').eq('tenant_id', tenantId).eq('client_phone', 'owner_pending').eq('key', 'action').maybeSingle();
  const v = data?.value;
  if (!v || !v.name || Date.now() - (v.at || 0) > 10 * 60 * 1000) return null; // 10-minute window
  return v;
}

/** Called by the brain before anything else: a bare "yes"/"no" resolves the parked action. */
export async function takePendingAction({ tenant, text, req }) {
  if (!isAffirmative(text) && !isNegative(text)) return null;
  const pending = await getPending(tenant.id);
  if (!pending) return null;
  await setPending(tenant.id, null);
  if (isNegative(text)) return { ok: true, say: "Okay, I won't.", cancelled: true };
  return runOwnerTool({ tenant, name: pending.name, args: { ...pending.args, confirmed: true }, req });
}

// ── helpers ──
async function tenantTz(tenantId) {
  try { return (await getBookingSettings(tenantId))?.timezone || 'America/New_York'; } catch { return 'America/New_York'; }
}
function resolveDayKey(input, tz) {
  const today = localDateKey(new Date(), tz);
  const s = String(input || 'today').trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const add = (n) => { const [y, m, d] = today.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
  if (!s || s === 'today' || s === 'tonight') return today;
  if (s === 'tomorrow') return add(1);
  if (s === 'yesterday') return add(-1);
  const w = WEEKDAYS.findIndex(d => s.includes(d));
  if (w >= 0) {
    const todayW = new Date(`${today}T12:00:00Z`).getUTCDay();
    let diff = (w - todayW + 7) % 7; if (diff === 0 && s.includes('next')) diff = 7;
    return add(diff);
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? today : localDateKey(new Date(t), tz);
}
function parseTime(input) {
  const m = String(input || '').trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10); const min = m[2] ? parseInt(m[2], 10) : 0; const ap = m[3];
  if (ap && ap.startsWith('p') && h < 12) h += 12;
  if (ap && ap.startsWith('a') && h === 12) h = 0;
  if (!ap && h >= 1 && h <= 7) h += 12; // "at 3" in a salon means 3 PM
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
function timeLabel(iso, tz) {
  try { return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }); } catch { return iso; }
}
function dayLabel(key) {
  return new Date(`${key}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}
const clientName = (cl) => (cl && (cl.name || [cl.first_name, cl.last_name].filter(Boolean).join(' '))) || 'the client';
const firstName = (cl) => clientName(cl).split(' ')[0];

async function findClients(c, tenantId, query, limit = 5) {
  const q = String(query || '').trim();
  if (!q) return [];
  // A parked action stores the exact client id; resolve it directly.
  if (!/\s/.test(q)) {
    const { data: byId } = await c.from('clients').select('*').eq('tenant_id', tenantId).eq('id', q).limit(1);
    if (byId?.length) return byId;
  }
  const digits = q.replace(/\D/g, '');
  if (digits.length >= 7) {
    const phone = e164(q);
    const { data } = await c.from('clients').select('*').eq('tenant_id', tenantId).eq('phone', phone).limit(limit);
    if (data?.length) return data;
    const { data: loose } = await c.from('clients').select('*').eq('tenant_id', tenantId).ilike('phone', `%${digits.slice(-10)}%`).limit(limit);
    return loose || [];
  }
  const { data } = await c.from('clients').select('*').eq('tenant_id', tenantId).ilike('name', `%${q}%`).limit(limit);
  if (data?.length) return data;
  const first = q.split(/\s+/)[0];
  const { data: byFirst } = await c.from('clients').select('*').eq('tenant_id', tenantId).ilike('first_name', `${first}%`).limit(limit);
  return byFirst || [];
}
async function oneClient(c, tenantId, query) {
  const list = await findClients(c, tenantId, query, 5);
  if (!list.length) return { error: `I couldn't find a client matching "${query}".` };
  if (list.length > 1) {
    const exact = list.filter(x => clientName(x).toLowerCase() === String(query).toLowerCase());
    if (exact.length === 1) return { client: exact[0] };
    return { error: `I found ${list.length} clients matching "${query}": ${list.map(clientName).join(', ')}. Which one?` };
  }
  return { client: list[0] };
}
async function catalog(tenantId) {
  const [services, staff] = await Promise.all([listServices(tenantId, { activeOnly: false }).catch(() => []), listStaff(tenantId, { activeOnly: false }).catch(() => [])]);
  return { svc: Object.fromEntries(services.map(s => [s.id, s])), stf: Object.fromEntries(staff.map(s => [s.id, s])) };
}
async function findBooking(c, tenantId, tz, clientQuery, dateInput) {
  const found = await oneClient(c, tenantId, clientQuery);
  if (found.error) return found;
  let q = c.from('bookings').select('*').eq('tenant_id', tenantId).eq('client_id', found.client.id).eq('status', 'confirmed');
  if (dateInput) {
    const b = dayBoundsUtc(resolveDayKey(dateInput, tz), tz);
    q = q.gte('start_time', b.start).lt('start_time', b.end);
  } else {
    q = q.gte('start_time', new Date(Date.now() - 12 * 3600e3).toISOString());
  }
  const { data } = await q.order('start_time', { ascending: true }).limit(3);
  if (!data?.length) return { error: `${firstName(found.client)} has no upcoming confirmed booking${dateInput ? ' on ' + dayLabel(resolveDayKey(dateInput, tz)) : ''}.` };
  return { client: found.client, booking: data[0], more: data.length - 1 };
}

// Run another API handler in-process with the owner's own auth header.
function runHandler(fn, req) {
  return new Promise((resolve) => {
    let status = 200;
    const res = {
      setHeader() { return res; }, getHeader() { return undefined; },
      status(code) { status = code; return res; },
      json(body) { resolve({ status, body }); return res; },
      send(body) { resolve({ status, body }); return res; },
      end() { resolve({ status, body: null }); return res; },
    };
    Promise.resolve(fn(req, res)).catch(e => resolve({ status: 500, body: { ok: false, error: String(e?.message || e) } }));
  });
}
function ownerReq(req, body) {
  return { method: 'POST', headers: { ...(req?.headers || {}), 'content-type': 'application/json' }, query: {}, body };
}
function park(tenantId, name, args, say) {
  return setPending(tenantId, { name, args }).then(() => ({ ok: true, needs_confirmation: true, say }));
}

// ── the tools ──
export async function runOwnerTool({ tenant, name, args = {}, req }) {
  const c = db();
  if (!c) return { ok: false, say: "My database isn't connected right now." };
  const tz = await tenantTz(tenant.id);
  const confirmed = args.confirmed === true;
  try {
    switch (name) {
      case 'confirm_appointments': {
        const key = resolveDayKey(args.date || 'tomorrow', tz);
        const when = key === localDateKey(new Date(), tz) ? 'today' : dayLabel(key);
        if (!confirmed) {
          const p = await askToConfirm(c, tenant, { dayKey: key, tz, preview: true });
          if (!p.count) return { ok: true, say: `Everyone booked ${when} has already confirmed, or there's nobody to ask.` };
          return park(tenant.id, name, { ...args, date: key }, `I'll text ${p.count} client${p.count === 1 ? '' : 's'} booked ${when} (${p.names.slice(0, 4).join(', ')}${p.count > 4 ? '…' : ''}) to confirm or reschedule. Send?`);
        }
        const r = await askToConfirm(c, tenant, { dayKey: key, tz });
        return { ok: true, say: `Sent ${r.sent} confirmation text${r.sent === 1 ? '' : 's'}${r.failed ? ` (${r.failed} couldn't go out)` : ''}. I'll mark each one as they reply YES.` };
      }

      case 'confirmation_status': {
        const key = resolveDayKey(args.date || 'tomorrow', tz);
        const when = key === localDateKey(new Date(), tz) ? 'today' : dayLabel(key);
        const s = await confirmationStatus(c, tenant, { dayKey: key, tz });
        if (!s.total) return { ok: true, say: `Nothing is booked ${when}.` };
        const w = s.waiting.map(x => x.name.split(' ')[0]);
        return { ok: true, say: `${s.confirmed.length} of ${s.total} confirmed for ${when}.${w.length ? ` Still waiting on ${w.slice(0, 5).join(', ')}${w.length > 5 ? '…' : ''}.${s.waiting.some(x => !x.asked) ? ' Want me to text them?' : ''}` : ' Everyone is confirmed.'}`, ...s };
      }

      case 'open_page': {
        const path = PAGES[String(args.page || '').toLowerCase()];
        if (!path) return { ok: false, say: "I don't know that page." };
        return { ok: true, say: `Opening ${args.page}.`, ui: { navigate: path } };
      }

      case 'launch_campaign': {
        const seg = SEGMENTS[args.segment] ? args.segment : 'lapsed';
        const message = String(args.message || '').trim();
        if (!message) return { ok: false, say: 'What should the text say?' };
        if (!confirmed) {
          const a = await audience(c, tenant.id, seg, { days: args.days, tz });
          if (!a.recipients.length) return { ok: false, say: `Nobody in "${SEGMENTS[seg].label.toLowerCase()}" can be texted right now${a.capped ? ` (${a.capped} already got a campaign this week)` : ''}.` };
          const when = inSendingHours(new Date(), tz) ? 'starting now' : 'starting at 9am';
          return park(tenant.id, name, { ...args, segment: seg }, `That's ${plural(a.recipients.length, 'client')} (${SEGMENTS[seg].label.toLowerCase()}${seg === 'lapsed' ? `, ${a.days}+ days` : ''}). Message: "${message}". I'll send it in batches ${when}, with an opt-out line, and track the bookings it brings in. Launch it?`);
        }
        const made = await createCampaign(c, tenant, { name: args.name, segment: seg, days: args.days, message, createdBy: 'lola' });
        if (!made.ok) return { ok: false, say: made.error };
        const st = await startCampaign(c, tenant, made.campaign.id, { max: 15, deadline: Date.now() + 12000, tz });
        const first = st.batch?.sent || 0;
        return { ok: true, say: first >= made.total ? `Launched — all ${plural(made.total, 'text')} sent. I'll track who books.` : first ? `Launched. ${first} sent so far; the rest of the ${made.total} go out over the next few minutes. I'll track who books.` : `Launched for ${made.total} clients. ${st.batch?.reason === 'quiet_hours' ? 'Texts start at 9am.' : 'Sending now.'} I'll track who books.`, suggestions: ['How is my campaign doing?'] };
      }

      case 'fill_plan': {
        const act = args.action || 'show';
        let plan = await latestPlan(c, tenant.id).catch(() => null);
        if (act === 'rebuild' || !plan) {
          const r = await buildFillPlan(c, tenant, { reason: 'owner' });
          if (!r.ok) return { ok: false, say: r.error };
          plan = r.plan;
        }
        const st = plan.strategy || {}, items = plan.items || [];
        const next = items.filter(it => it.status === 'planned').sort((a, b) => a.send_on < b.send_on ? -1 : 1);
        const cal = next.slice(0, 4).map(it => `${new Date(it.send_on + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })}: ${it.name} (${plural(it.audience, 'client')})`).join('; ');
        if (act === 'approve' || act === 'autopilot') {
          if (!confirmed) return park(tenant.id, name, args, `${st.headline || ''} ${cal ? `First up — ${cal}.` : ''} ${act === 'autopilot' ? 'With Autopilot I send each campaign on its day without asking, and rebuild the plan every week.' : 'I send each campaign on its day, 10am–8pm, and skip any whose days have already filled.'} Start it?`.trim());
          const r = await setPlanStatus(c, tenant, plan.id, act === 'autopilot' ? 'autopilot_on' : 'approve');
          return r.ok ? { ok: true, say: `Done — the 30-day plan is live${act === 'autopilot' ? ' on Autopilot' : ''}. I'll report the bookings it brings in.`, actions: [{ navigate: '/campaigns' }] } : { ok: false, say: r.error };
        }
        if (act === 'pause') { const r = await setPlanStatus(c, tenant, plan.id, 'pause'); return { ok: r.ok, say: r.ok ? 'Paused. Nothing more goes out until you restart it.' : r.error }; }
        const lev = (st.levers || []).slice(0, 3).join(' ');
        return { ok: true, say: `${st.headline || ''} ${lev} ${cal ? `The calendar: ${cal}.` : ''} ${st.projected_bookings ? `I expect about ${plural(st.projected_bookings, 'booking')}${st.projected_revenue ? ` (~$${Number(st.projected_revenue).toLocaleString('en-US')})` : ''}.` : ''} ${plan.status === 'active' ? 'It’s running.' : 'Say "start the plan" and I’ll run it.'}`.replace(/\s+/g, ' ').trim(), suggestions: plan.status === 'active' ? ['How is my campaign doing?'] : ['Start the plan', 'Put it on autopilot'] };
      }

      case 'campaign_report': {
        const list = await campaignsWithStats(c, tenant.id, { limit: 5 });
        if (!list.length) return { ok: true, say: "You haven't run a campaign yet. Want me to plan one?" };
        const x = list[0];
        const more = list.length > 1 ? ` Across your last ${list.length} campaigns: ${list.reduce((s, k) => s + k.booked, 0)} bookings, $${list.reduce((s, k) => s + k.revenue, 0).toLocaleString('en-US')}.` : '';
        return { ok: true, say: `"${x.name}" (${x.status}): ${x.sent} of ${x.total} sent${x.failed ? `, ${x.failed} failed` : ''}. ${x.booked ? `${plural(x.booked, 'client')} booked — $${x.revenue.toLocaleString('en-US')}.` : 'No bookings from it yet.'}${more}` };
      }

      case 'learn_business': {
        if (!args.website && !args.notes) return { ok: false, say: 'Send me your website address, or paste your menu with prices, and I\u2019ll learn it.' };
        const out = await learnBusiness(c, tenant, { website: args.website, notes: args.notes });
        return { ok: !!out.ok, say: out.say, suggestions: out.suggestions, ui: out.ok && out.report && (out.report.services_added || out.report.team_added) ? { refresh: 'services' } : undefined };
      }

      case 'away_brief': {
        const hrs = Math.min(168, Math.max(1, Number(args.hours) || 12));
        const brief = await awayBrief(c, tenant, new Date(Date.now() - hrs * 3600e3).toISOString());
        return { ok: true, say: brief.notable ? brief.say.replace(/^While you were away/, `In the last ${plural(hrs, 'hour')}`) : `Nothing needs you from the last ${plural(hrs, 'hour')}.`, brief };
      }

      case 'set_alerts': {
        const patch = {};
        if (args.phone) {
          const ph = e164(args.phone);
          if (!ph || ph.replace(/\D/g, '').length < 10) return { ok: false, say: "That number doesn't look right. What's your mobile number?" };
          const { error } = await c.from('tenants').update({ operator_phone: ph }).eq('id', tenant.id);
          if (error) return { ok: false, say: "I couldn't save that number. You can set it in Settings, Call handling." };
          patch.phone = ph;
        }
        const on = args.enabled === undefined ? true : args.enabled !== false;
        await c.from('client_memories').upsert({ tenant_id: tenant.id, client_phone: 'owner_alerts', key: 'enabled', value: { on, at: new Date().toISOString() } }, { onConflict: 'tenant_id,client_phone,key' });
        const to = patch.phone || tenant.operator_phone || null;
        if (!on) return { ok: true, say: "Okay, I'll stop texting you alerts. You'll still see everything when you open LolaDesk." };
        if (!to) return { ok: true, say: "Alerts are on. What's your mobile number? I'll text you there when someone needs you." };
        return { ok: true, say: `Alerts are on. I'll text ${to} when a caller asks for you, sounds unhappy or I miss them, or a booking in the next 48 hours is cancelled. Never between 9pm and 8am.` };
      }

      case 'today_brief': {
        const key = resolveDayKey(args.date, tz);
        const b = dayBoundsUtc(key, tz);
        const [{ data: rows }, cat, { data: calls }] = await Promise.all([
          c.from('bookings').select('*').eq('tenant_id', tenant.id).gte('start_time', b.start).lt('start_time', b.end).order('start_time', { ascending: true }),
          catalog(tenant.id),
          c.from('calls').select('status,direction,created_at').eq('tenant_id', tenant.id).gte('created_at', b.start).lt('created_at', b.end),
        ]);
        const live = (rows || []).filter(x => !/^cancel/i.test(x.status || ''));
        const ids = [...new Set(live.map(x => x.client_id).filter(Boolean))];
        const { data: cls } = ids.length ? await c.from('clients').select('id,name,first_name,last_name').in('id', ids) : { data: [] };
        const byId = Object.fromEntries((cls || []).map(x => [x.id, x]));
        const items = live.map(x => ({
          time: timeLabel(x.start_time, tz), client: clientName(byId[x.client_id]),
          service: cat.svc[x.service_id]?.name || x.service || '', stylist: cat.stf[x.staff_id]?.name || x.stylist || '', status: x.status,
        }));
        const inbound = (calls || []).filter(x => (x.direction || 'inbound') === 'inbound');
        const booked = inbound.filter(x => /book/i.test(x.status || '')).length;
        const when = key === localDateKey(new Date(), tz) ? 'today' : 'on ' + dayLabel(key);
        let say = items.length
          ? `You have ${items.length} booking${items.length === 1 ? '' : 's'} ${when}. ${items.slice(0, 4).map(i => `${i.time} ${i.client}${i.service ? ' for ' + i.service : ''}`).join(', ')}${items.length > 4 ? `, and ${items.length - 4} more` : ''}.`
          : `Nothing is booked ${when} yet.`;
        if (inbound.length) say += ` I've answered ${inbound.length} call${inbound.length === 1 ? '' : 's'}${booked ? ` and booked ${booked}` : ''}.`;
        return { ok: true, say, date: key, bookings: items, calls: inbound.length, calls_booked: booked };
      }

      case 'revenue_report': {
        const period = ['today', 'week', 'month'].includes(args.period) ? args.period : 'month';
        const todayKey = localDateKey(new Date(), tz);
        const [y, m, d] = todayKey.split('-').map(Number);
        const key = (dt) => dt.toISOString().slice(0, 10);
        let startKey, prevStartKey, prevEndKey;
        if (period === 'today') { startKey = todayKey; prevStartKey = key(new Date(Date.UTC(y, m - 1, d - 7))); prevEndKey = key(new Date(Date.UTC(y, m - 1, d - 6))); }
        else if (period === 'week') { startKey = key(new Date(Date.UTC(y, m - 1, d - 6))); prevStartKey = key(new Date(Date.UTC(y, m - 1, d - 13))); prevEndKey = startKey; }
        else { startKey = key(new Date(Date.UTC(y, m - 1, 1))); prevStartKey = key(new Date(Date.UTC(y, m - 2, 1))); prevEndKey = key(new Date(Date.UTC(y, m - 2, d + 1))); }
        const endKey = key(new Date(Date.UTC(y, m - 1, d + 1)));
        const sum = async (a, b) => {
          const { data } = await c.from('bookings').select('total_amount,status').eq('tenant_id', tenant.id)
            .gte('start_time', zonedLocalToUtc(a, '00:00:00', tz)).lt('start_time', zonedLocalToUtc(b, '00:00:00', tz));
          const live = (data || []).filter(x => !/^cancel|no-?show/i.test(x.status || ''));
          return { total: live.reduce((s, x) => s + Number(x.total_amount || 0), 0), count: live.length };
        };
        const [now, prev] = await Promise.all([sum(startKey, endKey), sum(prevStartKey, prevEndKey)]);
        const fmt = (n) => '$' + Math.round(n).toLocaleString('en-US');
        const label = period === 'today' ? 'Today' : period === 'week' ? 'The last 7 days' : 'This month so far';
        const cmp = period === 'today' ? 'same day last week' : period === 'week' ? 'the 7 days before' : 'the same point last month';
        const delta = prev.total ? Math.round((now.total - prev.total) / prev.total * 100) : null;
        const say = `${label}: ${fmt(now.total)} booked across ${now.count} appointment${now.count === 1 ? '' : 's'}` +
          (delta === null ? '.' : `, ${delta >= 0 ? 'up' : 'down'} ${Math.abs(delta)}% from ${cmp} (${fmt(prev.total)}).`);
        return { ok: true, say, period, booked_total: now.total, bookings: now.count, previous_total: prev.total, change_pct: delta };
      }

      case 'find_client': {
        const list = await findClients(c, tenant.id, args.client, 5);
        if (!list.length) return { ok: false, say: `I couldn't find "${args.client}".` };
        const cl = list[0];
        const { data: next } = await c.from('bookings').select('start_time,status').eq('tenant_id', tenant.id).eq('client_id', cl.id)
          .eq('status', 'confirmed').gte('start_time', new Date().toISOString()).order('start_time', { ascending: true }).limit(1);
        const nb = next?.[0];
        const last = cl.last_visit ? new Date(cl.last_visit).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: tz }) : null;
        const say = `${clientName(cl)}${cl.phone ? ', ' + cl.phone : ''}.` +
          (last ? ` Last visit ${last}.` : '') +
          (nb ? ` Next booking ${dayLabel(localDateKey(new Date(nb.start_time), tz))} at ${timeLabel(nb.start_time, tz)}.` : ' No upcoming booking.') +
          (list.length > 1 ? ` I also found ${list.slice(1).map(clientName).join(', ')}.` : '');
        return { ok: true, say, client: { id: cl.id, name: clientName(cl), phone: cl.phone }, ui: { client_id: cl.id } };
      }

      case 'list_bookings': {
        if (args.client && !args.date) {
          const found = await oneClient(c, tenant.id, args.client);
          if (found.error) return { ok: false, say: found.error };
          const { data } = await c.from('bookings').select('start_time,status').eq('tenant_id', tenant.id).eq('client_id', found.client.id)
            .eq('status', 'confirmed').gte('start_time', new Date().toISOString()).order('start_time', { ascending: true }).limit(5);
          if (!data?.length) return { ok: true, say: `${firstName(found.client)} has nothing booked.` };
          return { ok: true, say: `${firstName(found.client)} is booked ${data.map(x => `${dayLabel(localDateKey(new Date(x.start_time), tz))} at ${timeLabel(x.start_time, tz)}`).join('; ')}.` };
        }
        return runOwnerTool({ tenant, name: 'today_brief', args: { date: args.date }, req });
      }

      case 'text_client': {
        const found = await oneClient(c, tenant.id, args.client);
        if (found.error) return { ok: false, say: found.error };
        const msg = String(args.message || '').trim().slice(0, 600);
        if (!msg) return { ok: false, say: 'What should the text say?' };
        if (!found.client.phone || !/^\+?\d{7,}/.test(found.client.phone)) return { ok: false, say: `${firstName(found.client)} has no phone number on file.` };
        if (!confirmed) return park(tenant.id, name, { ...args, client: found.client.id }, `I'll text ${clientName(found.client)}: "${msg}". Should I send it?`);
        const r = await sendSms({ tenantId: tenant.id, to: found.client.phone, text: msg });
        if (r?.skipped) return { ok: false, say: r.reason === 'opted_out' ? `${firstName(found.client)} has opted out of texts.` : `I couldn't send it (${r.reason}).` };
        if (r?.errors?.length) return { ok: false, say: `The carrier rejected it: ${r.errors[0]?.detail || 'unknown error'}.` };
        return { ok: true, say: `Sent to ${firstName(found.client)}.` };
      }

      case 'text_clients_segment': {
        const msg = String(args.message || '').trim().slice(0, 600);
        if (!msg) return { ok: false, say: 'What should the message say?' };
        let rows = [], label = () => '';
        if (args.segment === 'lapsed') {
          const days = Math.max(14, Math.min(365, parseInt(args.days || 60, 10) || 60));
          const cut = new Date(Date.now() - days * 86400e3).toISOString();
          const { data } = await c.from('clients').select('*').eq('tenant_id', tenant.id).lt('last_visit', cut).order('last_visit', { ascending: false }).limit(200);
          rows = data || []; label = (n) => n === 1 ? `client who hasn't been in ${days}+ days` : `clients who haven't been in ${days}+ days`;
        } else if (args.segment === 'vip') {
          const { data } = await c.from('clients').select('*').eq('tenant_id', tenant.id).eq('is_vip', true).limit(200);
          rows = data || []; label = (n) => n === 1 ? 'VIP client' : 'VIP clients';
        } else if (args.segment === 'tomorrow') {
          const b = dayBoundsUtc(resolveDayKey('tomorrow', tz), tz);
          const { data: bk } = await c.from('bookings').select('client_id').eq('tenant_id', tenant.id).eq('status', 'confirmed').gte('start_time', b.start).lt('start_time', b.end);
          const ids = [...new Set((bk || []).map(x => x.client_id).filter(Boolean))];
          const { data } = ids.length ? await c.from('clients').select('*').in('id', ids) : { data: [] };
          rows = data || []; label = (n) => n === 1 ? 'client booked tomorrow' : 'clients booked tomorrow';
        } else return { ok: false, say: 'Which group: lapsed, VIP, or tomorrow?' };
        const reach = rows.filter(r => r.phone && /^\+?\d{7,}/.test(r.phone) && !/opted_out/i.test(r.status || '')).slice(0, SEND_CAP);
        if (!reach.length) return { ok: true, say: `There's nobody in that group I can text right now.` };
        if (!confirmed) return park(tenant.id, name, args, `That's ${reach.length} ${label(reach.length)}${rows.length > SEND_CAP ? ` (capped at ${SEND_CAP})` : ''}. Message: "${msg}". Should I send it?`);
        let sent = 0, skipped = 0;
        for (const r of reach) {
          const text = msg.replace(/\{first_?name\}/gi, firstName(r));
          const out = await sendSms({ tenantId: tenant.id, to: r.phone, text }).catch(() => ({ skipped: true }));
          if (out?.skipped || out?.errors?.length) skipped++; else sent++;
        }
        return { ok: true, say: `Sent to ${sent} client${sent === 1 ? '' : 's'}${skipped ? `; ${skipped} couldn't be reached` : ''}.`, sent, skipped };
      }

      case 'call_client': {
        let found = await oneClient(c, tenant.id, args.client);
        // A caller who isn't a client yet (e.g. from the away brief): call the number itself.
        const rawDigits = String(args.client || '').replace(/\D/g, '');
        if (found.error && rawDigits.length >= 10 && rawDigits.length <= 11) {
          const ph = e164(args.client);
          found = { client: { id: ph, phone: ph, name: ph.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3') } };
        }
        if (found.error) return { ok: false, say: found.error };
        if (!found.client.phone || !/^\+?\d{7,}/.test(found.client.phone)) return { ok: false, say: `${firstName(found.client)} has no phone number on file.` };
        if (!confirmed) return park(tenant.id, name, { ...args, client: found.client.id }, `I'll call ${clientName(found.client)} now from the salon line. Go ahead?`);
        const r = await originateCallback(c, tenant, e164(found.client.phone));
        if (!r?.ok) return { ok: false, say: `I couldn't place the call: ${r?.error || 'unknown error'}.` };
        return { ok: true, say: `Calling ${/^\(\d{3}\)/.test(clientName(found.client)) ? clientName(found.client) : firstName(found.client)} now.` };
      }

      case 'cancel_booking':
      case 'mark_no_show': {
        const f = await findBooking(c, tenant.id, tz, args.client, args.date);
        if (f.error) return { ok: false, say: f.error };
        const when = `${dayLabel(localDateKey(new Date(f.booking.start_time), tz))} at ${timeLabel(f.booking.start_time, tz)}`;
        const verb = name === 'cancel_booking' ? 'cancel' : 'mark as a no-show';
        if (!confirmed) return park(tenant.id, name, { ...args, booking_id: f.booking.id },
          `${clientName(f.client)}'s booking is ${when}. Should I ${verb} it?${name === 'cancel_booking' ? ` ${firstName(f.client)} gets the cancellation text, and I'll offer the slot to your waitlist.` : ''}`);
        if (name === 'cancel_booking') {
          if (req?.headers?.authorization) {
            const { default: calendar } = await import('../calendar.js');
            const out = await runHandler(calendar, ownerReq(req, { action: 'cancel', booking_id: args.booking_id || f.booking.id, channel: 'lola_owner', reason: 'owner_request' }));
            if (out.status >= 300 || out.body?.ok === false) return { ok: false, say: `I couldn't cancel it: ${out.body?.error || out.status}.` };
            const wl = out.body?.waitlist_matches?.count || 0;
            return { ok: true, say: `Cancelled ${firstName(f.client)}'s ${timeLabel(f.booking.start_time, tz)}.${wl ? ` ${wl} waitlisted client${wl === 1 ? ' matches' : 's match'}, and the slot has been offered.` : ''}`, ui: { refresh: 'bookings' } };
          }
          await updateCanonicalBooking(tenant.id, args.booking_id || f.booking.id, { status: 'cancelled' }, { source: 'lola_owner', reason: 'owner_request' });
          return { ok: true, say: `Cancelled ${firstName(f.client)}'s ${timeLabel(f.booking.start_time, tz)}.`, ui: { refresh: 'bookings' } };
        }
        await updateCanonicalBooking(tenant.id, args.booking_id || f.booking.id, { status: 'no-show' }, { source: 'lola_owner', reason: 'owner_marked_no_show' });
        return { ok: true, say: `Marked ${firstName(f.client)} as a no-show.`, ui: { refresh: 'bookings' } };
      }

      case 'reschedule_booking': {
        const f = await findBooking(c, tenant.id, tz, args.client, args.date);
        if (f.error) return { ok: false, say: f.error };
        const hhmm = parseTime(args.new_time);
        if (!hhmm) return { ok: false, say: 'What time should I move it to?' };
        const newKey = resolveDayKey(args.new_date, tz);
        const startsAt = zonedLocalToUtc(newKey, `${hhmm}:00`, tz);
        if (new Date(startsAt) <= new Date()) return { ok: false, say: "That time has already passed. Pick a later one?" };
        if (!confirmed) return park(tenant.id, name, { ...args, booking_id: f.booking.id },
          `Move ${clientName(f.client)} from ${dayLabel(localDateKey(new Date(f.booking.start_time), tz))} at ${timeLabel(f.booking.start_time, tz)} to ${dayLabel(newKey)} at ${timeLabel(startsAt, tz)}? ${firstName(f.client)} gets a text with the new time.`);
        if (!req?.headers?.authorization) return { ok: false, say: 'Open the calendar to move this one. I need your session to check availability.' };
        const { default: calendar } = await import('../calendar.js');
        const out = await runHandler(calendar, ownerReq(req, { action: 'reschedule', booking_id: args.booking_id || f.booking.id, starts_at: startsAt, channel: 'lola_owner' }));
        if (out.status >= 300 || out.body?.ok === false) {
          const raw = String(out.body?.error || out.body?.reason || '');
          const why = out.body?.conflict || !raw || /unavailable|taken|conflict|overlap|slot|closed|hours/i.test(raw) ? "that time isn't available" : raw;
          return { ok: false, say: `I couldn't move it: ${why}.` };
        }
        return { ok: true, say: `Moved ${firstName(f.client)} to ${dayLabel(newKey)} at ${timeLabel(startsAt, tz)} and texted them the new time.`, ui: { refresh: 'bookings' } };
      }

      case 'add_to_waitlist': {
        const found = await oneClient(c, tenant.id, args.client);
        if (found.error) return { ok: false, say: found.error };
        await addToWaitlist({
          tenantId: tenant.id, clientId: found.client.id, clientName: clientName(found.client), clientPhone: found.client.phone || null,
          serviceName: args.service || null, preferredDate: args.preferred_date ? resolveDayKey(args.preferred_date, tz) : null,
          notes: 'Added by Lola for the owner', source: 'dashboard',
        });
        return { ok: true, say: `${firstName(found.client)} is on the waitlist. I'll offer them the next opening.` };
      }

      case 'fill_gap': {
        const key = resolveDayKey(args.date, tz);
        const hhmm = parseTime(args.time);
        if (!hhmm) return { ok: false, say: 'Which time should I fill?' };
        const dur = Math.max(15, Math.min(240, parseInt(args.duration_minutes || 60, 10) || 60));
        if (!confirmed) return park(tenant.id, name, { ...args, date: key, time: hhmm, duration_minutes: dur },
          `I'll offer ${dayLabel(key)} at ${timeLabel(zonedLocalToUtc(key, `${hhmm}:00`, tz), tz)} to up to 3 waitlisted or lapsed clients by text. Go ahead?`);
        if (!req?.headers?.authorization) return { ok: false, say: 'Open the calendar to fill this gap.' };
        const { default: fillGap } = await import('../lola/fill-gap.js');
        const out = await runHandler(fillGap, ownerReq(req, { date: key, start_time: hhmm, duration_minutes: dur, max_candidates: 3 }));
        const d = out.body?.data || {};
        if (out.status >= 300 || out.body?.ok === false) return { ok: false, say: `I couldn't start it: ${out.body?.error || out.status}.` };
        if (d.reason === 'no_candidates' || !d.sent_count) return { ok: true, say: "Nobody on the waitlist fits that slot yet." };
        return { ok: true, say: `Texted ${d.sent_count} client${d.sent_count === 1 ? '' : 's'}. First to say yes gets it.` };
      }

      default:
        return { ok: false, say: "I can't do that one yet." };
    }
  } catch (e) {
    console.error('[owner-tools]', name, e?.message);
    return { ok: false, say: `Something went wrong: ${String(e?.message || e).slice(0, 120)}` };
  }
}

// exported for tests
export const __test = { resolveDayKey, parseTime };
