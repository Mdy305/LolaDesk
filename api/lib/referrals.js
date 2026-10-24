/**
 * api/lib/referrals.js — give a month, get a month.
 * ════════════════════════════════════════════════════════════════════
 * Salon owners talk to salon owners. Every salon has one link:
 *
 *     https://www.loladesk.com/r/<slug>      (vercel.json → /onboarding?ref=<slug>)
 *
 * 1. Signup with ?ref records who sent them (recordReferral). Not for a
 *    salon that already had a trial, and never for yourself.
 * 2. When the new salon pays its first real invoice (stripe-webhook
 *    invoice.paid), both salons get one month of their own plan credited to
 *    their Stripe balance (creditReferral). Stripe applies it to the next
 *    invoice automatically. Exactly once: an idempotency key per salon per
 *    side, plus a "credited" marker.
 * 3. A referrer who isn't paying yet keeps the month as "pending"; it is
 *    applied when they first pay (same invoice.paid path).
 *
 * Storage: client_memories (tenant_id, client_phone='referral', key, value),
 * the table owner-alerts already uses, so no migration is needed.
 */
import { planFor, normalizePlan } from './plans.js';

const SLOT = 'referral';
const appBase = () => String(process.env.APP_URL || 'https://www.loladesk.com').replace(/\/+$/, '');

export function cleanRef(ref) {
  const s = String(ref || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,80}$/.test(s) ? s : '';
}
export function referralLink(tenant) {
  return tenant?.slug ? `${appBase()}/r/${encodeURIComponent(tenant.slug)}` : '';
}
/** One month of this salon's own plan, in cents (annual plans: the annual monthly price). */
export function monthCents(tenant) {
  const p = planFor(normalizePlan(tenant?.plan) || 'starter');
  return String(tenant?.billing_interval || '') === 'annual' ? p.annualMonthlyCents : p.monthlyCents;
}

async function getMem(c, tid, key) {
  try {
    const { data } = await c.from('client_memories').select('value').eq('tenant_id', tid).eq('client_phone', SLOT).eq('key', key).maybeSingle();
    return data?.value ?? null;
  } catch { return null; }
}
async function setMem(c, tid, key, value) {
  try {
    const r = await c.from('client_memories').upsert({ tenant_id: tid, client_phone: SLOT, key, value }, { onConflict: 'tenant_id,client_phone,key' });
    return !r?.error;
  } catch { return false; }
}

/** What the Billing page shows the owner. */
export async function referralStatus(c, tenant) {
  const s = (await getMem(c, tenant.id, 'stats')) || {};
  return { link: referralLink(tenant), joined: s.joined || 0, months_earned: s.months_earned || 0, pending: s.pending || 0 };
}

/**
 * Record who referred a brand-new salon. Never throws.
 * → { recorded: true, referrer_id } | { recorded: false, reason }
 */
export async function recordReferral(c, tenant, ref, { trial = true } = {}) {
  const slug = cleanRef(ref);
  if (!c || !tenant?.id || !slug) return { recorded: false, reason: 'no_ref' };
  if (!trial) return { recorded: false, reason: 'trial_already_used' };
  let referrer = null;
  try { const { data } = await c.from('tenants').select('*').eq('slug', slug).limit(1); referrer = (data || [])[0] || null; } catch {}
  if (!referrer) return { recorded: false, reason: 'unknown_ref' };
  const same = (a, b) => a && b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  if (referrer.id === tenant.id || same(referrer.owner_email, tenant.owner_email)) return { recorded: false, reason: 'self' };
  if (await getMem(c, tenant.id, 'referred_by')) return { recorded: false, reason: 'already_recorded' };
  await setMem(c, tenant.id, 'referred_by', { tenant_id: referrer.id, slug, at: new Date().toISOString() });
  const s = (await getMem(c, referrer.id, 'stats')) || {};
  await setMem(c, referrer.id, 'stats', { ...s, joined: (s.joined || 0) + 1 });
  return { recorded: true, referrer_id: referrer.id };
}

async function credit(stripeApi, customer, cents, description, key) {
  if (!customer || !(cents > 0)) return false;
  await stripeApi(`/customers/${encodeURIComponent(customer)}/balance_transactions`, 'POST',
    { amount: -Math.round(cents), currency: 'usd', description },
    { 'Idempotency-Key': key });
  return true;
}

/**
 * A salon just paid a real invoice. Apply any month it is owed:
 *   · its own "joined through a referral" month (first payment only)
 *   · the referrer's month (credited now if the referrer pays, else pending)
 *   · months it earned as a referrer while it wasn't paying yet
 * deps: { stripeApi, notify? } — injected so tests never touch Stripe.
 * Never throws; returns what it did.
 */
export async function creditReferral(c, tenant, { stripeApi, notify } = {}) {
  const out = { referee: false, referrer: false, pending: false, own_pending: 0 };
  if (!c || !tenant?.id || !stripeApi) return out;
  try {
    // Months this salon earned as a referrer before it was paying.
    const mine = (await getMem(c, tenant.id, 'stats')) || {};
    if (mine.pending > 0 && tenant.stripe_customer_id) {
      const n = mine.pending;
      if (await credit(stripeApi, tenant.stripe_customer_id, monthCents(tenant) * n, `LolaDesk referral: ${n} free month${n === 1 ? '' : 's'}`, `referral-pending-${tenant.id}-${(mine.months_earned || 0) + n}`)) {
        await setMem(c, tenant.id, 'stats', { ...mine, pending: 0, months_earned: (mine.months_earned || 0) + n });
        out.own_pending = n;
      }
    }

    const by = await getMem(c, tenant.id, 'referred_by');
    if (!by?.tenant_id || by.credited_at) return out;

    // The new salon's month.
    out.referee = await credit(stripeApi, tenant.stripe_customer_id, monthCents(tenant), 'LolaDesk: a month on us for joining through a friend', `referral-referee-${tenant.id}`);
    await setMem(c, tenant.id, 'referred_by', { ...by, credited_at: new Date().toISOString() });

    // The referrer's month.
    let referrer = null;
    try { const { data } = await c.from('tenants').select('*').eq('id', by.tenant_id).maybeSingle(); referrer = data || null; } catch {}
    if (referrer) {
      const s = (await getMem(c, referrer.id, 'stats')) || {};
      const paying = ['active', 'canceling', 'past_due', 'trialing'].includes(String(referrer.subscription_status || '')) && referrer.stripe_customer_id;
      if (paying && await credit(stripeApi, referrer.stripe_customer_id, monthCents(referrer), `LolaDesk referral: ${tenant.name || 'a salon'} joined through you`, `referral-referrer-${tenant.id}`)) {
        await setMem(c, referrer.id, 'stats', { ...s, months_earned: (s.months_earned || 0) + 1 });
        out.referrer = true;
      } else {
        await setMem(c, referrer.id, 'stats', { ...s, pending: (s.pending || 0) + 1 });
        out.pending = true;
      }
      if (notify) {
        try { await notify(referrer, `Lola here. ${tenant.name || 'A salon you sent'} just joined LolaDesk through you. ${out.referrer ? 'Your next month is on us.' : 'A free month is waiting for you when you subscribe.'} Thank you.`, { subject: 'A month of LolaDesk, on us' }); } catch {}
      }
    }
  } catch (e) { out.error = String(e?.message || e); }
  return out;
}
