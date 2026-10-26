/**
 * api/lib/money.js — "How much money is mine, and can I have it now?"
 * ════════════════════════════════════════════════════════════════════
 * One read of a salon's money, shared by the Payments home, Lola's
 * money_today / pay_me_now tools and /api/money:
 *
 *   ready_cents        what can go to the bank right now
 *                       (instant amount AFTER LolaDesk's instant-payout fee
 *                        when the salon has an instant-eligible card/bank,
 *                        else the normal available balance)
 *   instant            true when ready_cents can arrive in ~30 minutes
 *   today              what Lola brought in today: deposits, no-show fees,
 *                       front-desk card sales, and how many clients paid
 *   next_payout        the next automatic payout already on its way
 *
 * payOut() sends ready_cents: instant when possible, otherwise standard.
 * Uses net_available (Stripe's amount after the platform's instant-payout
 * pricing), so a payout never asks for more than the salon can receive.
 */
import { db } from './db.js';
import { stripe as stripeClient } from './stripe.js';

const sum = (arr, cur = 'usd') => (arr || []).filter((f) => !f.currency || f.currency === cur).reduce((n, f) => n + (Number(f.amount) || 0), 0);
export const usd = (cents) => '$' + (Math.round(Number(cents) || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export async function connectedAccount(c, tenantId) {
  try {
    const { data } = await c.from('stripe_connect_accounts').select('*').eq('tenant_id', tenantId).maybeSingle();
    return data || null;
  } catch { return null; }
}

/** Pure: Stripe balance → what's ready and how. Exported for tests. */
export function readyFromBalance(bal) {
  const available = sum(bal?.available);
  const pending = sum(bal?.pending);
  // Best instant destination: the largest net amount (after LolaDesk's instant fee).
  let best = null, gross = 0;
  for (const ia of bal?.instant_available || []) {
    if (ia.currency && ia.currency !== 'usd') continue;
    gross = Math.max(gross, Number(ia.amount) || 0);
    for (const n of ia.net_available || []) {
      const amt = Number(n.amount) || 0;
      if (amt > 0 && (!best || amt > best.amount)) best = { amount: amt, destination: n.destination };
    }
  }
  if (best && best.amount >= 50) {
    return { ready_cents: best.amount, instant: true, destination: best.destination, instant_fee_cents: Math.max(0, gross - best.amount), available_cents: available, pending_cents: pending };
  }
  return { ready_cents: available, instant: false, destination: null, instant_fee_cents: 0, available_cents: available, pending_cents: pending };
}

function dayStartUtc(tz, now = new Date()) {
  // Midnight today in the salon's time zone, as a UTC ISO string.
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const g = (t) => Number(parts.find((p) => p.type === t)?.value);
    const sinceMidnight = ((g('hour') * 60 + g('minute')) * 60 + g('second')) * 1000;
    return new Date(Math.floor(now.getTime() / 1000) * 1000 - sinceMidnight).toISOString();
  } catch { const d = new Date(now); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); }
}

async function rows(p) { try { const r = await p; return (r && !r.error && r.data) || []; } catch { return []; } }

/** What Lola collected today. Never throws. */
export async function collectedToday(c, tenantId, { tz = 'America/New_York', now = new Date() } = {}) {
  const since = dayStartUtc(tz, now);
  const [deps, fees, sales] = await Promise.all([
    rows(c.from('deposits').select('amount,status,booking_id,created_at').eq('tenant_id', tenantId).eq('status', 'paid').gte('created_at', since).limit(500)),
    rows(c.from('payments').select('amount,status,client_id,booking_id').eq('tenant_id', tenantId).eq('sub_kind', 'no_show_fee').eq('status', 'succeeded').gte('created_at', since).limit(500)),
    rows(c.from('pos_transactions').select('total_cents,tip_cents,client_id,client_name,status').eq('tenant_id', tenantId).eq('status', 'paid').gte('paid_at', since).limit(1000)),
  ]);
  // deposits.amount is dollars; payments.amount is cents (no-show scan writes cents).
  const deposits_cents = Math.round(deps.reduce((n, d) => n + (Number(d.amount) || 0), 0) * 100);
  const no_show_cents = fees.reduce((n, f) => n + (Number(f.amount) || 0), 0);
  const card_sales_cents = sales.reduce((n, s) => n + (Number(s.total_cents) || 0), 0);
  const clients = new Set([
    ...deps.map((d) => 'b' + (d.booking_id || Math.random())),
    ...fees.map((f) => 'c' + (f.client_id || f.booking_id || Math.random())),
    ...sales.map((s) => 's' + (s.client_id || s.client_name || Math.random())),
  ]).size;
  return { deposits_cents, no_show_cents, card_sales_cents, total_cents: deposits_cents + no_show_cents + card_sales_cents, clients };
}

/** The whole picture for one salon. Never throws; { connected:false } when Stripe isn't set up. */
export async function moneySnapshot(tenantId, { c = db(), api = null, tz = 'America/New_York', now = new Date() } = {}) {
  const acct = await connectedAccount(c, tenantId);
  if (!acct?.stripe_account_id) return { ok: true, connected: false };
  const out = { ok: true, connected: true, charges_enabled: !!acct.charges_enabled, payouts_enabled: !!acct.payouts_enabled };
  const s = api || stripeClient();
  try {
    const bal = await s.balance.retrieve({ expand: ['instant_available.net_available'] }, { stripeAccount: acct.stripe_account_id });
    Object.assign(out, readyFromBalance(bal));
  } catch (e) { Object.assign(out, readyFromBalance(null), { balance_error: String(e?.message || e).slice(0, 160) }); }
  try {
    const list = await s.payouts.list({ limit: 5 }, { stripeAccount: acct.stripe_account_id });
    const next = (list?.data || []).filter((p) => ['pending', 'in_transit'].includes(p.status)).sort((a, b) => (a.arrival_date || 0) - (b.arrival_date || 0))[0];
    out.next_payout = next ? { amount_cents: next.amount, arrives: new Date(next.arrival_date * 1000).toISOString(), method: next.method } : null;
  } catch { out.next_payout = null; }
  out.today = await collectedToday(c, tenantId, { tz, now });
  return out;
}

/**
 * Send what's ready to the salon's bank. Instant when the salon has an
 * instant-eligible card or bank, otherwise a standard payout.
 * → { ok, method, amount_cents, arrives, say } — never throws.
 */
export async function payOut(tenantId, { c = db(), api = null, idempotencyKey = null } = {}) {
  const acct = await connectedAccount(c, tenantId);
  if (!acct?.stripe_account_id) return { ok: false, say: 'Turn on payments first. It takes about 3 minutes on the Payments page.' };
  if (acct.payouts_enabled === false) return { ok: false, say: 'Stripe still needs a few details before it can send money to your bank. Open Payments to finish.' };
  const s = api || stripeClient();
  let snap;
  try { snap = readyFromBalance(await s.balance.retrieve({ expand: ['instant_available.net_available'] }, { stripeAccount: acct.stripe_account_id })); }
  catch (e) { return { ok: false, say: "I couldn't reach Stripe just now. Try again in a minute." }; }
  if (!(snap.ready_cents >= 100)) return { ok: false, amount_cents: snap.ready_cents, say: snap.pending_cents ? `Nothing's ready yet. ${usd(snap.pending_cents)} is still clearing.` : 'There’s nothing to send yet.' };
  const params = { amount: snap.ready_cents, currency: 'usd', method: snap.instant ? 'instant' : 'standard', ...(snap.instant && snap.destination ? { destination: snap.destination } : {}) };
  try {
    const p = await s.payouts.create(params, { stripeAccount: acct.stripe_account_id, ...(idempotencyKey ? { idempotencyKey } : {}) });
    const arrives = p.arrival_date ? new Date(p.arrival_date * 1000).toISOString() : null;
    return {
      ok: true, method: p.method, amount_cents: p.amount, arrives, payout_id: p.id,
      say: p.method === 'instant' ? `Done. ${usd(p.amount)} is on its way and usually lands in about 30 minutes.` : `Done. ${usd(p.amount)} is on its way to your bank.`,
    };
  } catch (e) {
    return { ok: false, say: `Stripe didn't send it: ${String(e?.message || e).slice(0, 140)}` };
  }
}

// ── Transactions: every payment LolaDesk took for the salon, in detail ──────
const KIND_LABEL = { deposit: 'Booking deposit', no_show_fee: 'No-show fee', pos: 'Card at the front desk', link: 'Pay link', payment: 'Payment' };

/** Pure: one Stripe PaymentIntent (with latest_charge) → the row the salon sees. Exported for tests. */
export function txFromIntent(pi, { source = 'platform' } = {}) {
  const md = pi.metadata || {};
  const ch = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : {};
  const pmd = ch.payment_method_details || {};
  const card = pmd.card_present || pmd.card || pmd.interac_present || {};
  const wallet = pmd.card?.wallet?.type || null;
  const kind = md.pos_sale === 'true' ? (md.payment_method === 'link' ? 'link' : 'pos') : (md.kind === 'no_show_fee' ? 'no_show_fee' : md.kind === 'deposit' ? 'deposit' : 'payment');
  const amount = Number(pi.amount_received || (pi.status === 'succeeded' ? pi.amount : 0)) || 0;
  const refunded = Number(ch.amount_refunded) || 0;
  const fee = source === 'platform' ? (Number(pi.application_fee_amount) || 0) : 0;
  const tip = Number(md.tip_cents) || Number(pi.amount_details?.tip?.amount) || 0;
  const status = ch.disputed ? 'disputed' : refunded >= amount && amount > 0 ? 'refunded' : refunded > 0 ? 'partially_refunded'
    : pi.status === 'succeeded' ? 'paid' : pi.status === 'canceled' ? 'canceled' : pi.last_payment_error ? 'failed' : 'pending';
  return {
    id: pi.id, source, kind, kind_label: KIND_LABEL[kind] || 'Payment',
    created: new Date((pi.created || 0) * 1000).toISOString(), status,
    amount_cents: amount || Number(pi.amount) || 0, tip_cents: tip, fee_cents: fee, refunded_cents: refunded,
    net_cents: Math.max(0, amount - fee - refunded),
    card: card.last4 ? { brand: card.brand || null, last4: card.last4, wallet } : null,
    receipt_url: ch.receipt_url || null, description: pi.description || null,
    client_id: md.client_id || null, client_name: md.client_name || null, booking_id: md.booking_id || null,
    failure: pi.last_payment_error?.message || null,
  };
}

async function searchAll(fn, query, opts, max = 300) {
  const out = [];
  let page = null;
  for (let i = 0; i < 3 && out.length < max; i++) {
    const r = await fn({ query, limit: 100, expand: ['data.latest_charge'], ...(page ? { page } : {}) }, opts);
    out.push(...(r?.data || []));
    if (!r?.has_more || !r.next_page) break;
    page = r.next_page;
  }
  return out;
}

/**
 * Every payment for the salon since `since` (Date): deposits, no-show fees, front-desk
 * card sales, pay links — straight from Stripe, with client, service and stylist filled in.
 * Never throws. → { ok, rows, totals }
 */
export async function listTransactions(tenantId, { since = new Date(Date.now() - 864e5), c = db(), api = null } = {}) {
  const s = api || stripeClient();
  const after = Math.floor(since.getTime() / 1000);
  const q = `metadata['tenant_id']:'${String(tenantId).replace(/'/g, '')}' AND created>${after}`;
  const acct = await connectedAccount(c, tenantId);
  const [plat, direct] = await Promise.all([
    searchAll((p, o) => s.paymentIntents.search(p, o), q).catch(() => []),
    acct?.stripe_account_id ? searchAll((p, o) => s.paymentIntents.search(p, o), q, { stripeAccount: acct.stripe_account_id }).catch(() => []) : [],
  ]);
  let rows = [...plat.map((p) => txFromIntent(p, { source: 'platform' })), ...direct.map((p) => txFromIntent(p, { source: 'account' }))]
    .filter((r) => r.status !== 'pending' || Date.now() - Date.parse(r.created) < 3600e3)   // drop stale unpaid links
    .sort((a, b) => Date.parse(b.created) - Date.parse(a.created));

  // Who and what: bookings and clients from LolaDesk.
  const bIds = [...new Set(rows.map((r) => r.booking_id).filter(Boolean))];
  const bookings = bIds.length ? await rows_(c.from('bookings').select('id,client_id,service,stylist,start_time,service_id,staff_id').eq('tenant_id', tenantId).in('id', bIds)) : [];
  const byBooking = new Map(bookings.map((b) => [b.id, b]));
  const cIds = [...new Set([...rows.map((r) => r.client_id), ...bookings.map((b) => b.client_id)].filter(Boolean))];
  const clients = cIds.length ? await rows_(c.from('clients').select('*').eq('tenant_id', tenantId).in('id', cIds)) : [];
  const byClient = new Map(clients.map((x) => [x.id, x]));
  rows = rows.map((r) => {
    const b = r.booking_id ? byBooking.get(r.booking_id) : null;
    const cl = byClient.get(r.client_id || b?.client_id);
    const name = (cl && ([cl.first_name, cl.last_name].filter(Boolean).join(' ') || cl.name)) || r.client_name || null;
    return { ...r, client_id: r.client_id || b?.client_id || null, client_name: name && name !== 'Walk-in' ? name : (r.kind === 'pos' ? 'Walk-in' : name),
      booking: b ? { service: b.service || null, stylist: b.stylist || null, start_time: b.start_time || null } : null };
  });
  const paid = rows.filter((r) => ['paid', 'partially_refunded', 'disputed'].includes(r.status));
  const totals = {
    count: paid.length,
    gross_cents: paid.reduce((n, r) => n + r.amount_cents, 0),
    tips_cents: paid.reduce((n, r) => n + r.tip_cents, 0),
    fees_cents: paid.reduce((n, r) => n + r.fee_cents, 0),
    refunded_cents: rows.reduce((n, r) => n + r.refunded_cents, 0),
    net_cents: paid.reduce((n, r) => n + r.net_cents, 0),
  };
  return { ok: true, rows, totals };
}
async function rows_(p) { try { const r = await p; return (r && !r.error && r.data) || []; } catch { return []; } }

/** Refund one payment (whole amount). Platform charges pull the money back from the salon too. */
export async function refundTransaction(tenantId, paymentIntentId, { c = db(), api = null } = {}) {
  if (!/^pi_[A-Za-z0-9]+$/.test(String(paymentIntentId || ''))) return { ok: false, say: 'That payment wasn’t found.' };
  const s = api || stripeClient();
  const acct = await connectedAccount(c, tenantId);
  // Find it: on LolaDesk's account (deposits, reader sales) or on the salon's own (older pay links).
  let pi = null, opts = undefined;
  try { pi = await s.paymentIntents.retrieve(paymentIntentId); } catch (_) {}
  if (!pi && acct?.stripe_account_id) { try { opts = { stripeAccount: acct.stripe_account_id }; pi = await s.paymentIntents.retrieve(paymentIntentId, {}, opts); } catch (_) { pi = null; } }
  if (!pi || pi.metadata?.tenant_id !== tenantId) return { ok: false, say: 'That payment wasn’t found.' };
  if (pi.status !== 'succeeded') return { ok: false, say: 'Only paid payments can be refunded.' };
  try {
    const params = { payment_intent: pi.id, ...(pi.transfer_data?.destination ? { reverse_transfer: true } : {}), metadata: { tenant_id: tenantId, by: 'owner' } };
    const r = await s.refunds.create(params, { ...(opts || {}), idempotencyKey: 'owner_refund_' + pi.id });
    try { await c.from('pos_transactions').update({ status: 'refunded', refunded_at: new Date().toISOString(), refunded_amount_cents: r.amount }).eq('stripe_id', pi.id); } catch (_) {}
    return { ok: true, say: `Refunded ${usd(r.amount)}. It reaches the client's card in 5–10 days.` };
  } catch (e) { return { ok: false, say: `Stripe didn't refund it: ${String(e?.message || e).slice(0, 140)}` }; }
}
