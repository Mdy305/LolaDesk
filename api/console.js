/**
 * /api/console — LolaDesk Console: running the business (console.html, served at /console).
 * ════════════════════════════════════════════════════════════════
 * For the platform owner only — same gate as /api/admin: a Supabase session (Bearer) whose
 * email is in ADMIN_EMAILS. No session → 401, not on the list → 403. Every action.
 *
 *   GET  ?action=overview           → MRR, ARR, paying, trials (+ ending in 7 days), past due,
 *                                     churned / new in 30 days, tickets, cost + margin, weekly sign-ups
 *   GET  ?action=subscriptions      → every salon with its state, plan, MRR, dates, owner, line
 *   GET  ?action=tenant&id=…        → one salon: billing timeline (billing_events) + this month's usage/cost
 *   GET  ?action=tickets[&status=]  → the support inbox (unresolved first, urgent first, newest first)
 *                                     + which reply channels work
 *   GET  ?action=help               → requests salons sent from the app + the most common issues
 *   GET  ?action=analytics&days=7|30|90[&format=csv] → every platform-wide number, vs the previous period
 *                                     (lib/console-analytics.js); csv = the per-salon table
 *   POST { action:'suspend'|'activate'|'comp'|'unsuspend'|'uncomp', tenant_id } → same as POST /api/admin
 *   POST { action:'extend_trial', tenant_id, days }       → LolaDesk (no-card) trial: trial_ends_at += days
 *   POST { action:'ticket_update', id, status?, admin_note?, claim? }
 *   POST { action:'ticket_reply', id, message, via? }      → SMS from the support line, else email.
 *                                     Nothing configured → 400 with the reason. Never pretends to send.
 */
import { bearer, getUserFromToken, isAdminEmail } from './lib/auth.js';
import { db } from './lib/db.js';
import { ensureMigrations } from './lib/migrate.js';
import { platformSnapshot, setBillingStatus } from './lib/platform-admin.js';
import { costCents } from './lib/costs.js';
import { tolerantWrite } from './lib/setup-store.js';
import { careState, careOptedOut, SUPPORT_EMAIL } from './lib/customer-care.js';
import { sendSMS } from './lib/sms.js';
import { platformAnalytics, salonsCsv } from './lib/console-analytics.js';

const DAY = 864e5;
const TICKET_STATUSES = ['open', 'in_progress', 'resolved'];
const ms = (v) => { const n = Date.parse(v || ''); return Number.isFinite(n) ? n : NaN; };

function body(req) {
  const b = req.body;
  if (typeof b === 'string') { try { return JSON.parse(b || '{}'); } catch (_) { return {}; } }
  return b || {};
}

/** One word for where a salon stands: active · trialing · past_due · canceled · comped · suspended. */
export function subState(t) {
  const billing = String(t.billing_status || '').toLowerCase();
  const sub = String(t.subscription_status || '').toLowerCase();
  if (billing === 'suspended') return 'suspended';
  if (billing === 'active' || billing === 'comped' || billing === 'comp') return 'comped';
  if (sub === 'active' || sub === 'canceling') return 'active';
  if (sub === 'past_due' || sub === 'unpaid' || sub === 'incomplete_expired') return 'past_due';
  if (sub === 'canceled' || sub === 'cancelled') return 'canceled';
  return 'trialing';
}
const trialEnd = (t) => t.trial_ends_at || (String(t.subscription_status || '') === 'trialing' ? t.current_period_end : null) || null;
const isLolaTrial = (t) => ['', 'trial', 'incomplete'].includes(String(t.subscription_status || '').toLowerCase());

function emailConfigured(env = process.env) {
  return !!(env.SENDGRID_API_KEY || (env.AWS_SES_REGION && env.AWS_ACCESS_KEY_ID) || (env.MAILGUN_API_KEY && env.MAILGUN_DOMAIN));
}
async function replyChannels(c) {
  const care = await careState(c).catch(() => null);
  const smsFrom = care?.number && process.env.TELNYX_API_KEY ? care.number : null;
  return { sms: !!smsFrom, sms_from: smsFrom, email: emailConfigured(), email_from: process.env.EMAIL_FROM || SUPPORT_EMAIL };
}

async function allTickets(c) {
  const r = await c.from('support_tickets').select('*').order('created_at', { ascending: false }).limit(1000);
  if (r?.error) return null;
  return r.data || [];
}
const statusOf = (t) => TICKET_STATUSES.includes(t.status) ? t.status : 'open';
function sortTickets(list) {
  const rank = { open: 0, in_progress: 1, resolved: 2 };
  return list.slice().sort((a, b) => (rank[statusOf(a)] - rank[statusOf(b)])
    || ((b.urgency === 'high') - (a.urgency === 'high'))
    || ((ms(b.created_at) || 0) - (ms(a.created_at) || 0)));
}

/** The most common issues: recent tickets grouped by their first words. No AI. */
export function commonIssues(tickets, { days = 90, top = 8 } = {}) {
  const since = Date.now() - days * DAY;
  const STOPW = new Set(['i', 'my', 'the', 'a', 'an', 'is', 'are', 'to', 'we', 'our', 'hi', 'hello', 'hey', 'please', 'can', 'you', 'it', 'and', 'of', 'for', 'on', 'in', 'not', 'how', 'do', 'does']);
  const groups = new Map();
  for (const t of tickets || []) {
    if (Number.isFinite(ms(t.created_at)) && ms(t.created_at) < since) continue;
    const words = String(t.issue || '').toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter((w) => w && !STOPW.has(w));
    const key = words.slice(0, 2).join(' ') || '(no details)';
    const g = groups.get(key) || { phrase: key, count: 0, urgent: 0, open: 0, last_at: null, example: '' };
    g.count++; if (t.urgency === 'high') g.urgent++; if (statusOf(t) !== 'resolved') g.open++;
    if (!g.last_at || ms(t.created_at) > ms(g.last_at)) { g.last_at = t.created_at || null; g.example = String(t.issue || '').slice(0, 140); }
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.urgent - a.urgent || (ms(b.last_at) || 0) - (ms(a.last_at) || 0)).slice(0, top);
}

function subscriptionRows(snap) {
  const raw = new Map((snap.raw || []).map((t) => [t.id, t]));
  return snap.tenants.map((r) => {
    const t = raw.get(r.id) || {};
    return {
      ...r, state: subState(t), trial_end: trialEnd(t), renews_at: r.current_period_end,
      stripe_customer_id: t.stripe_customer_id || null, past_due_since: t.past_due_since || null, canceled_at: t.canceled_at || null,
      can_extend_trial: isLolaTrial(t) && !['suspended'].includes(String(t.billing_status || '')),
    };
  });
}

async function overview(c) {
  const snap = await platformSnapshot(c);
  const rows = subscriptionRows(snap);
  const now = Date.now();
  const raw = snap.raw || [];
  const count = (f) => rows.filter(f).length;
  const churned = raw.filter((t) => {
    const s = String(t.subscription_status || '').toLowerCase();
    if (s !== 'canceled' && s !== 'cancelled') return false;
    const at = Number.isFinite(ms(t.canceled_at)) ? ms(t.canceled_at) : ms(t.current_period_end);
    return Number.isFinite(at) && at >= now - 30 * DAY && at <= now;
  }).length;
  const weeks = Array.from({ length: 8 }, () => 0);
  for (const t of raw) {
    const at = ms(t.created_at); if (!Number.isFinite(at)) continue;
    const w = Math.floor((now - at) / (7 * DAY));
    if (w >= 0 && w < 8) weeks[7 - w]++;
  }
  const tickets = await allTickets(c).catch(() => null);
  const open = tickets ? tickets.filter((t) => statusOf(t) !== 'resolved') : null;
  const m = snap.metrics;
  return {
    mrr_cents: m.mrr_cents, arr_cents: m.mrr_cents * 12, paying: m.paying, salons: m.tenants,
    trials: count((r) => r.state === 'trialing'),
    trials_ending_7d: count((r) => r.state === 'trialing' && Number.isFinite(ms(r.trial_end)) && ms(r.trial_end) >= now && ms(r.trial_end) <= now + 7 * DAY),
    past_due: count((r) => r.state === 'past_due'),
    comped: count((r) => r.state === 'comped'), suspended: count((r) => r.state === 'suspended'),
    churned_30d: churned,
    new_30d: raw.filter((t) => Number.isFinite(ms(t.created_at)) && ms(t.created_at) >= now - 30 * DAY).length,
    tickets_open: open ? open.length : null, tickets_urgent: open ? open.filter((t) => t.urgency === 'high').length : null,
    costs_cents: m.costs_cents, fees_cents: m.fees_cents, margin_cents: m.margin_cents, month_start: m.month_start,
    signups_weekly: weeks, roster_capped: raw.length >= 500,
    today: { bookings: m.bookings_today, messages: m.messages_today, calls: m.calls_today },
  };
}

async function tenantDetail(c, id) {
  const snap = await platformSnapshot(c);
  const row = subscriptionRows(snap).find((r) => r.id === id);
  if (!row) return null;
  const monthStart = snap.metrics.month_start;
  const [events, usage, tickets] = await Promise.all([
    c.from('billing_events').select('id,type,amount,currency,status,created_at').eq('tenant_id', id).order('created_at', { ascending: false }).limit(50)
      .then((r) => (r?.error ? null : r.data || []), () => null),
    c.from('usage_events').select('kind,units,metadata,created_at').eq('tenant_id', id).gte('created_at', monthStart).limit(5000)
      .then((r) => (r?.error ? null : r.data || []), () => null),
    c.from('support_tickets').select('id,issue,status,urgency,created_at').eq('tenant_id', id).order('created_at', { ascending: false }).limit(10)
      .then((r) => (r?.error ? [] : r.data || []), () => []),
  ]);
  let usageOut = null;
  if (usage) {
    const by = {};
    for (const e of usage) {
      const k = String(e.kind || 'other');
      const g = by[k] || (by[k] = { kind: k, count: 0, cost_cents: 0 });
      g.count++; g.cost_cents += costCents(e);
    }
    usageOut = Object.values(by).sort((a, b) => b.cost_cents - a.cost_cents || b.count - a.count);
  }
  return { tenant: row, events, usage: usageOut, tickets };
}

async function extendTrial(c, tenantId, daysIn) {
  const days = Math.round(Number(daysIn));
  if (!tenantId || !Number.isFinite(days) || days < 1 || days > 90) return { status: 400, body: { ok: false, error: 'extend_trial needs tenant_id and days (1–90)' } };
  const { data: t } = await c.from('tenants').select('*').eq('id', tenantId).maybeSingle();
  if (!t) return { status: 404, body: { ok: false, error: 'tenant not found' } };
  if (!isLolaTrial(t)) return { status: 409, body: { ok: false, error: 'This salon’s billing is run by Stripe — change its trial in Stripe.' } };
  const base = Math.max(Date.now(), Number.isFinite(ms(t.trial_ends_at)) ? ms(t.trial_ends_at) : 0);
  const next = new Date(base + days * DAY).toISOString();
  const { error } = await c.from('tenants').update({ trial_ends_at: next }).eq('id', tenantId);
  if (error) return { status: 500, body: { ok: false, error: 'Could not save the new trial end.' } };
  return { status: 200, body: { ok: true, tenant_id: tenantId, trial_ends_at: next } };
}

async function getTicket(c, id) {
  if (!id) return null;
  const { data } = await c.from('support_tickets').select('*').eq('id', id).maybeSingle();
  return data || null;
}
const saveTicket = (c, id, patch, required = []) =>
  tolerantWrite((p) => c.from('support_tickets').update(p).eq('id', id), patch, { required });

async function ticketUpdate(c, user, b) {
  const t = await getTicket(c, b.id);
  if (!t) return { status: 404, body: { ok: false, error: 'ticket not found' } };
  const patch = { updated_at: new Date().toISOString() };
  const required = [];
  if (b.status != null) {
    if (!TICKET_STATUSES.includes(b.status)) return { status: 400, body: { ok: false, error: 'status must be open|in_progress|resolved' } };
    patch.status = b.status; required.push('status');
    patch.resolved_at = b.status === 'resolved' ? new Date().toISOString() : null;
  }
  if (b.admin_note != null) { patch.admin_note = String(b.admin_note).slice(0, 4000); required.push('admin_note'); }
  if (b.claim === true) { patch.assigned_to = user.email; required.push('assigned_to'); if (statusOf(t) === 'open' && b.status == null) { patch.status = 'in_progress'; } }
  if (b.claim === false) { patch.assigned_to = null; required.push('assigned_to'); }
  if (Object.keys(patch).length === 1) return { status: 400, body: { ok: false, error: 'nothing to change' } };
  const r = await saveTicket(c, t.id, patch, required);
  if (r?.error) return { status: 500, body: { ok: false, error: /admin_note|assigned_to/.test(String(r.error.message || '')) ? 'Run sql/fixall-2026-10.sql once to turn on notes and assignment.' : 'Could not save the ticket.' } };
  return { status: 200, body: { ok: true, ticket: { ...t, ...patch } } };
}

async function ticketReply(c, user, b) {
  const t = await getTicket(c, b.id);
  if (!t) return { status: 404, body: { ok: false, error: 'ticket not found' } };
  const text = String(b.message || '').trim().slice(0, 1200);
  if (!text) return { status: 400, body: { ok: false, error: 'Write a reply first.' } };
  const ch = await replyChannels(c);
  const canSms = ch.sms && !!t.phone, canEmail = ch.email && !!t.email;
  let via = b.via === 'email' ? 'email' : b.via === 'sms' ? 'sms' : (canSms ? 'sms' : canEmail ? 'email' : null);
  if (!via || (via === 'sms' && !canSms) || (via === 'email' && !canEmail)) {
    const why = [];
    if (!t.phone) why.push('no phone number on this ticket'); else if (!ch.sms) why.push('the LolaDesk support line isn’t set up (Command → LolaDesk support line)');
    if (!t.email) why.push('no email on this ticket'); else if (!ch.email) why.push('no email provider is configured (SENDGRID_API_KEY, Mailgun or SES)');
    return { status: 400, body: { ok: false, error: `Can’t reply from here: ${why.join('; ')}.`, channels: ch } };
  }
  let sent = false, reason = null, to = null;
  if (via === 'sms') {
    to = t.phone;
    if (await careOptedOut(c, to)) return { status: 409, body: { ok: false, error: 'They texted STOP to the support line — reply by email or call them.' } };
    const r = await sendSMS({ from: ch.sms_from, to, text, skipOptOut: true }).catch((e) => ({ skipped: true, reason: String(e?.message || e) }));
    sent = !!r && !r.skipped && !r.failed; reason = sent ? null : (r?.reason || 'not_sent');
  } else {
    to = t.email;
    try {
      const { SendEmail } = await import('./lib/lola-integrations.js');
      const r = await SendEmail({ to, subject: 'LolaDesk support', textContent: text, html: `<p>${text.replace(/[&<>]/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[x])).replace(/\n/g, '<br>')}</p><p>— LolaDesk support</p>`, from: ch.email_from });
      sent = !!(r && (r.success === true || r.sent === true || r.id || r.messageId)); reason = sent ? null : (r?.reason || 'not_sent');
    } catch (e) { reason = String(e?.message || e).slice(0, 160); }
  }
  if (!sent) return { status: 502, body: { ok: false, error: `Not sent (${via}): ${String(reason).slice(0, 160)}`, via } };
  const reply = { at: new Date().toISOString(), by: user.email, via, to, text };
  const replies = [...(Array.isArray(t.replies) ? t.replies : []), reply];
  const patch = { replies, updated_at: reply.at };
  if (statusOf(t) === 'open') patch.status = 'in_progress';
  if (!t.assigned_to) patch.assigned_to = user.email;
  const w = await saveTicket(c, t.id, patch);
  return { status: 200, body: { ok: true, sent: true, via, reply, logged: !w?.error, ticket: { ...t, ...patch } } };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await getUserFromToken(bearer(req)).catch(() => null);
  if (!user) return res.status(401).json({ ok: false, error: 'Not signed in' });
  if (!isAdminEmail(user.email)) return res.status(403).json({ ok: false, error: 'Not authorized' });

  const c = db();
  if (!c) return res.status(503).json({ ok: false, error: 'Database not configured' });
  try { await ensureMigrations(); } catch (_) {}

  const q = req.query || {};
  try {
    if (req.method === 'GET') {
      const action = String(q.action || 'overview');
      if (action === 'overview') return res.status(200).json({ ok: true, overview: await overview(c) });
      if (action === 'analytics') {
        const a = await platformAnalytics(c, { days: Number(q.days) || 30 });
        if (String(q.format || '') === 'csv') {
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="loladesk-salons-${a.range.days}d-${a.range.end.slice(0, 10)}.csv"`);
          const csv = salonsCsv(a);
          return typeof res.send === 'function' ? res.status(200).send(csv) : res.status(200).end(csv);
        }
        return res.status(200).json({ ok: true, analytics: a });
      }
      if (action === 'subscriptions') {
        const snap = await platformSnapshot(c);
        let rows = subscriptionRows(snap);
        if (q.status) rows = rows.filter((r) => r.state === String(q.status));
        if (q.q) { const s = String(q.q).toLowerCase(); rows = rows.filter((r) => [r.name, r.slug, r.owner_email, r.phone_number].join(' ').toLowerCase().includes(s)); }
        return res.status(200).json({ ok: true, subscriptions: rows });
      }
      if (action === 'tenant') {
        const d = await tenantDetail(c, String(q.id || ''));
        return d ? res.status(200).json({ ok: true, ...d }) : res.status(404).json({ ok: false, error: 'tenant not found' });
      }
      if (action === 'tickets' || action === 'help') {
        const list = await allTickets(c);
        if (!list) return res.status(200).json({ ok: true, ready: false, tickets: [], channels: await replyChannels(c), common: [] });
        const { data: ts } = await c.from('tenants').select('id,name,slug').limit(2000);
        const names = new Map((ts || []).map((t) => [t.id, t.name || t.slug]));
        const withSalon = list.map((t) => ({ ...t, status: statusOf(t), salon: t.tenant_id ? (names.get(t.tenant_id) || null) : null }));
        if (action === 'help') {
          return res.status(200).json({ ok: true, ready: true,
            app: sortTickets(withSalon.filter((t) => t.channel === 'app')).slice(0, 100),
            common: commonIssues(withSalon),
            by_urgency: { high: withSalon.filter((t) => t.urgency === 'high').length, normal: withSalon.filter((t) => t.urgency === 'normal').length, low: withSalon.filter((t) => t.urgency === 'low').length },
            by_channel: withSalon.reduce((a, t) => { const k = t.channel || 'other'; a[k] = (a[k] || 0) + 1; return a; }, {}) });
        }
        let out = sortTickets(withSalon);
        if (q.status) out = out.filter((t) => t.status === String(q.status));
        return res.status(200).json({ ok: true, ready: true, tickets: out.slice(0, 300), channels: await replyChannels(c) });
      }
      return res.status(400).json({ ok: false, error: 'unknown action' });
    }

    if (req.method === 'POST') {
      const b = body(req);
      const action = String(b.action || q.action || '');
      let r;
      if (['suspend', 'activate', 'comp', 'unsuspend', 'uncomp'].includes(action)) r = await setBillingStatus(c, b.tenant_id, action === 'comp' ? 'activate' : action);
      else if (action === 'extend_trial') r = await extendTrial(c, b.tenant_id, b.days);
      else if (action === 'ticket_update') r = await ticketUpdate(c, user, b);
      else if (action === 'ticket_reply') r = await ticketReply(c, user, b);
      else r = { status: 400, body: { ok: false, error: 'unknown action' } };
      return res.status(r.status).json(r.body);
    }
  } catch (e) {
    console.error('[console]', String(e?.message || e).slice(0, 200));
    return res.status(500).json({ ok: false, error: 'Console error — try again.' });
  }
  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}
