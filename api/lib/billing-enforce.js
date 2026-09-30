/**
 * api/lib/billing-enforce.js — the trial actually ends, and every lost
 * booking turns into a reason to subscribe. Fully automatic.
 *
 * Switch: BILLING_ENFORCE=1 (Vercel env). Off by default, so turning it on
 * is a deliberate act — mark your own salon active first (see launch doc).
 *
 * 1. gateNewBooking(tenant): uses billing-gate.js's rule (trial past its
 *    end with no active subscription, canceled, past_due, suspended).
 *    Wired into the paths that really book clients: Lola's phone tools
 *    (check-availability, book-appointment) and the public website widget
 *    (availability, hold, book). Waitlist, cancel and reschedule stay open.
 * 2. turnedAway(): the caller is told the salon will call them back — never
 *    about billing — and the owner gets one text right away: who wanted to
 *    book, and the link to keep Lola booking. At most one text per 4 hours,
 *    never 9 p.m.–8 a.m. salon time. Every turned-away booking is logged.
 * 3. runTrialReminders(): 3 days and 1 day before the trial ends, the owner
 *    gets what Lola did for them so far, and the same link. Once each.
 */
import { billingGate } from './billing-gate.js';
import { sendSms } from './sms.js';
import { e164 } from './db.js';
import { getBookingSettings } from './booking-repository.js';
import { isBillable, feePolicy } from './booking-fees.js';

const DAY = 864e5;
const OWNER_TEXT_GAP = 4 * 3600e3;

export function enforcing(env = process.env) {
  return /^(1|true|on|yes)$/i.test(String(env.BILLING_ENFORCE || '').trim());
}

/** null → book as normal. Otherwise the gate result (blocked, reason, speak lines). */
export function gateNewBooking(tenant) {
  if (!enforcing()) return null;
  const g = billingGate(tenant);
  return g.blocked ? g : null;
}

/** What Lola says to a caller she can't book. Never mentions billing. */
export const CALLER_LINE = "I can't lock that in for you right this second, but I've passed your request to the salon and they'll call you back shortly to get you booked.";
export const WIDGET_LINE = "Online booking is paused right now. Leave your number on the waitlist, or call the salon, and they'll get you booked.";

function appBase() { return String(process.env.APP_URL || 'https://www.loladesk.com').replace(/\/+$/, ''); }
export function keepLolaLink() { return `${appBase()}/subscription`; }

function localHour(date, tz) {
  try { return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(date)) % 24; } catch { return date.getUTCHours(); }
}
async function salonTz(tenant) {
  try { return (await getBookingSettings(tenant.id))?.timezone || 'America/New_York'; } catch { return 'America/New_York'; }
}
async function mem(c, tid, key) {
  try { const { data } = await c.from('client_memories').select('value').eq('tenant_id', tid).eq('client_phone', 'owner_alerts').eq('key', key).maybeSingle(); return data?.value ?? null; } catch { return null; }
}
async function setMem(c, tid, key, value) {
  try { await c.from('client_memories').upsert({ tenant_id: tid, client_phone: 'owner_alerts', key, value }, { onConflict: 'tenant_id,client_phone,key' }); } catch {}
}
function ownerPhone(t) {
  const to = e164(t.operator_phone || t.owner_phone || '');
  return to && to !== e164(t.phone_number || '') ? to : null;
}
function prettyPhone(p) {
  const d = String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (p || 'a caller');
}

/**
 * A booking Lola couldn't take. Logs it, texts the owner (rate-limited),
 * never throws. Returns { logged, texted }.
 */
export async function turnedAway(c, tenant, { channel = 'voice', caller = '', service = '', when = '', now = new Date() } = {}) {
  const out = { logged: false, texted: false };
  if (!c || !tenant?.id) return out;
  try {
    await c.from('usage_events').insert({ tenant_id: tenant.id, kind: 'paywall_turned_away', units: 1, metadata: { channel, caller: caller || null, service: service || null, when: when || null }, created_at: now.toISOString() });
    out.logged = true;
  } catch {}
  try {
    const to = ownerPhone(tenant);
    if (!to) return out;
    const h = localHour(now, await salonTz(tenant));
    if (h < 8 || h >= 21) return out;
    const last = Date.parse((await mem(c, tenant.id, 'paywall_texted'))?.at || '') || 0;
    if (now - last < OWNER_TEXT_GAP) return out;
    const who = caller ? prettyPhone(caller) : (channel === 'widget' ? 'A client on your website' : 'A caller');
    const what = [service, when].filter(Boolean).join(', ');
    const body = `Lola here. ${who} just tried to book${what ? ` (${what})` : ''} and I couldn't take it — your LolaDesk trial has ended. I told them you'd call back. Keep me booking for you: ${keepLolaLink()}`;
    const r = await sendSms({ tenant, to, body });
    if (r && !r.skipped && !r.error) {
      out.texted = true;
      await setMem(c, tenant.id, 'paywall_texted', { at: now.toISOString() });
    }
  } catch {}
  return out;
}

/** Trial-ending texts with proof of value. Called from the owner-alerts cron. */
export async function runTrialReminders(c, { now = new Date() } = {}) {
  const out = [];
  if (!enforcing() || !c) return out;
  let tenants = [];
  try { tenants = (await c.from('tenants').select('*').limit(5000)).data || []; } catch { return out; }
  const policy = { ...feePolicy(process.env), scope: 'lola' };
  for (const t of tenants) {
    try {
      const sub = String(t.subscription_status || '');
      if (!t.trial_ends_at || ['active', 'canceling', 'canceled', 'past_due'].includes(sub) || t.billing_status === 'suspended') continue;
      const end = Date.parse(t.trial_ends_at);
      if (!Number.isFinite(end) || end <= now) continue;
      const daysLeft = Math.ceil((end - now) / DAY);
      if (daysLeft !== 3 && daysLeft !== 1) continue;
      const to = ownerPhone(t);
      if (!to) { out.push({ tenant: t.id, skipped: 'no_owner_phone' }); continue; }
      const h = localHour(now, await salonTz(t));
      if (h < 10 || h >= 19) { out.push({ tenant: t.id, skipped: 'hours' }); continue; }
      const key = `trial_reminder_${daysLeft}`;
      if (await mem(c, t.id, key)) { out.push({ tenant: t.id, skipped: 'sent' }); continue; }

      const since = t.created_at || new Date(end - 14 * DAY).toISOString();
      const [callsR, bookingsR] = await Promise.all([
        c.from('calls').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id).gte('created_at', since),
        c.from('bookings').select('id,source,total_amount,status,external_id,external_provider').eq('tenant_id', t.id).gte('created_at', since).limit(5000),
      ]);
      const calls = callsR?.count || 0;
      const lolaBooked = (bookingsR?.data || []).filter((b) => !/^(cancel|no[-_ ]?show)/i.test(String(b.status || '')) && isBillable(b, policy));
      const dollars = Math.round(lolaBooked.reduce((s, b) => s + (Number(b.total_amount) || 0), 0));
      const proof = calls || lolaBooked.length
        ? `So far I've answered ${calls} call${calls === 1 ? '' : 's'} and booked ${lolaBooked.length} appointment${lolaBooked.length === 1 ? '' : 's'}${dollars ? ` ($${dollars.toLocaleString('en-US')})` : ''} for ${t.name || 'you'}.`
        : `I'm ready on your line whenever clients call.`;
      const when = daysLeft === 1 ? 'tomorrow' : 'in 3 days';
      const body = `Lola here. Your LolaDesk trial ends ${when}. ${proof} Keep me working: ${keepLolaLink()}`;
      const r = await sendSms({ tenant: t, to, body });
      if (r && !r.skipped && !r.error) {
        await setMem(c, t.id, key, { at: now.toISOString() });
        out.push({ tenant: t.id, sent: daysLeft });
      } else out.push({ tenant: t.id, skipped: r?.reason || 'sms_failed' });
    } catch (e) { out.push({ tenant: t.id, error: String(e?.message || e) }); }
  }
  return out;
}
