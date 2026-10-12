/**
 * api/lib/card-on-file.js — a card on file that protects the salon, honestly.
 * ════════════════════════════════════════════════════════════════════════
 * When the salon charges a no-show fee (Banking → Policies: No-show fee ON + "Auto-charge no-show fee"),
 * every booking is held with a card:
 *   • a deposit is due   → the deposit link also saves the card (Stripe, setup_future_usage).
 *   • no deposit         → the client gets ONE text with a secure Stripe page to add a card. The page shows
 *                          the salon's policy in plain words; nothing is charged then.
 * When the salon marks a visit "no-show", the fee is charged to that card off-session (the money goes to
 * the salon's connected Stripe account, exactly like deposits). If the bank asks for approval or declines,
 * the client gets the pay link instead — nothing is lost, nothing is charged twice.
 * Cards live on LolaDesk's Stripe account (customer per client per salon); LolaDesk never sees card numbers.
 */
import crypto from 'node:crypto';
import { db } from './db.js';
import { stripeApi, connectedDestination } from './stripe.js';
import { readSalonPolicies } from './salon-policies.js';

const appUrl = () => String(process.env.APP_URL || 'https://www.loladesk.com').replace(/\/+$/, '');
const keyRoot = () => String(process.env.STRIPE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY || '');

/** Does this salon hold bookings with a card? → { ask, fee_text } */
export async function cardPolicy(tenantId, c = db()) {
  if (!tenantId || !c || !process.env.STRIPE_SECRET_KEY) return { ask: false };
  try {
    const p = await readSalonPolicies(c, tenantId);
    const ns = p?.no_show || {};
    const ask = ns.enabled === true && p?.auto_charge?.no_show_fee === true;
    if (!ask) return { ask: false };
    const amt = Number(ns.amount) || 0;
    const fee = ns.type === 'percent' ? `${amt}% of the service` : ns.type === 'full' ? 'the full service price' : `$${amt.toFixed(amt % 1 ? 2 : 0)}`;
    return { ask: true, fee_text: fee, waive_first: ns.waive_first_offense === true };
  } catch (_) { return { ask: false }; }
}

/** The saved card for a client at this salon, or null. */
export async function savedCard(tenantId, clientId, c = db()) {
  if (!tenantId || !clientId || !c) return null;
  try {
    const { data } = await c.from('client_cards').select('*').eq('tenant_id', tenantId).eq('client_id', clientId).maybeSingle();
    return data && data.payment_method_id && data.status === 'active' ? data : null;
  } catch (_) { return null; }
}

// ── The link in the text: signed, never expires (a Stripe page is made fresh on each tap) ──
export const cardSig = (bookingId) => crypto.createHmac('sha256', keyRoot() + ':card-on-file').update(String(bookingId)).digest('base64url').slice(0, 22);
export const cardSigOk = (bookingId, sig) => {
  if (!sig || !keyRoot()) return false;
  const a = Buffer.from(String(sig)), b = Buffer.from(cardSig(bookingId));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
export const cardLink = (bookingId) => `${appUrl()}/api/card?b=${encodeURIComponent(bookingId)}&s=${cardSig(bookingId)}`;

/** The Stripe customer that holds this client's card at this salon (created once). */
export async function ensureCustomer(c, tenantId, client) {
  const { data: row } = await c.from('client_cards').select('*').eq('tenant_id', tenantId).eq('client_id', client.id).maybeSingle();
  if (row?.stripe_customer_id) return row.stripe_customer_id;
  const cus = await stripeApi('/customers', 'POST', {
    name: client.name || undefined, phone: client.phone && !String(client.phone).includes(':') ? client.phone : undefined, email: client.email || undefined,
    metadata: { tenant_id: tenantId, client_id: client.id, source: 'loladesk_card_on_file' },
  });
  await c.from('client_cards').upsert({ tenant_id: tenantId, client_id: client.id, stripe_customer_id: cus.id, status: 'pending', updated_at: new Date().toISOString() }, { onConflict: 'tenant_id,client_id' });
  return cus.id;
}

/** A fresh Stripe page (setup mode) for this booking's client. → { url } | { already } | { error } */
export async function startCardSetup(bookingId, c = db()) {
  const { data: bk } = await c.from('bookings').select('id,tenant_id,client_id,start_time,status').eq('id', bookingId).maybeSingle();
  if (!bk?.client_id) return { error: 'booking_not_found' };
  if (await savedCard(bk.tenant_id, bk.client_id, c)) return { already: true };
  const [{ data: tenant }, { data: client }] = await Promise.all([
    c.from('tenants').select('id,name').eq('id', bk.tenant_id).maybeSingle(),
    c.from('clients').select('id,name,phone,email').eq('tenant_id', bk.tenant_id).eq('id', bk.client_id).maybeSingle(),
  ]);
  if (!client) return { error: 'client_not_found' };
  const pol = await cardPolicy(bk.tenant_id, c);
  const customer = await ensureCustomer(c, bk.tenant_id, client);
  const salon = tenant?.name || 'the salon';
  const md = { kind: 'card_on_file', tenant_id: bk.tenant_id, client_id: client.id, booking_id: bk.id };
  const dest = await connectedDestination(bk.tenant_id);
  const policy = pol.ask
    ? `Your card holds your appointment at ${salon}. It is not charged now. If you miss the appointment without notice, ${salon} may charge a no-show fee of ${pol.fee_text}${pol.waive_first ? ' (your first miss is forgiven)' : ''}.`
    : `Your card holds your appointment at ${salon}. It is not charged now.`;
  const s = await stripeApi('/checkout/sessions', 'POST', {
    mode: 'setup', customer, currency: 'usd', payment_method_types: ['card'],
    success_url: `${appUrl()}/paid?card=1&salon=${encodeURIComponent(salon)}`,
    cancel_url: `${appUrl()}/paid?card=0&salon=${encodeURIComponent(salon)}`,
    metadata: md, setup_intent_data: { metadata: md, ...(dest ? { on_behalf_of: dest } : {}) },
    custom_text: { submit: { message: policy.slice(0, 1150) } },
  });
  return { url: s.url, id: s.id };
}

/** Store the card from a finished setup (Checkout setup mode) or a paid deposit that saved it. */
export async function saveCardFrom({ tenantId, clientId, customer, paymentMethodId }, c = db()) {
  if (!tenantId || !clientId || !paymentMethodId || !c) return { ok: false, skipped: true };
  let brand = null, last4 = null, exp_month = null, exp_year = null;
  try { const pm = await stripeApi('/payment_methods/' + encodeURIComponent(paymentMethodId), 'GET'); brand = pm?.card?.brand || null; last4 = pm?.card?.last4 || null; exp_month = pm?.card?.exp_month || null; exp_year = pm?.card?.exp_year || null; customer = customer || pm?.customer || null; } catch (_) {}
  if (!customer) return { ok: false, reason: 'no_customer' };
  const row = { tenant_id: tenantId, client_id: clientId, stripe_customer_id: customer, payment_method_id: paymentMethodId, brand, last4, exp_month, exp_year, status: 'active', updated_at: new Date().toISOString() };
  const { error } = await c.from('client_cards').upsert(row, { onConflict: 'tenant_id,client_id' });
  return error ? { ok: false, reason: error.message } : { ok: true, last4, brand };
}

/** Checkout finished in setup mode → the card is saved. */
export async function cardSetupCompleted(session, c = db()) {
  const md = session?.metadata || {};
  if (md.kind !== 'card_on_file') return { ok: false, skipped: true };
  let pmId = null;
  try { const si = typeof session.setup_intent === 'object' ? session.setup_intent : await stripeApi('/setup_intents/' + encodeURIComponent(session.setup_intent), 'GET'); pmId = typeof si?.payment_method === 'object' ? si.payment_method?.id : si?.payment_method; } catch (_) {}
  return saveCardFrom({ tenantId: md.tenant_id, clientId: md.client_id, customer: session.customer, paymentMethodId: pmId }, c);
}

/** A deposit link paid with "save my card" → keep that card for this client. */
export async function cardFromDepositPayment(session, c = db()) {
  const md = session?.metadata || {};
  if (!session?.customer || !session?.payment_intent || !md.tenant_id || !md.booking_id || md.save_card !== '1') return { ok: false, skipped: true };
  const { data: bk } = await c.from('bookings').select('client_id').eq('tenant_id', md.tenant_id).eq('id', md.booking_id).maybeSingle();
  if (!bk?.client_id) return { ok: false, skipped: true };
  let pmId = null;
  try { const pi = await stripeApi('/payment_intents/' + encodeURIComponent(session.payment_intent), 'GET'); pmId = typeof pi?.payment_method === 'object' ? pi.payment_method?.id : pi?.payment_method; } catch (_) {}
  return saveCardFrom({ tenantId: md.tenant_id, clientId: bk.client_id, customer: session.customer, paymentMethodId: pmId }, c);
}

/**
 * Charge the saved card off-session (no-show fee). Money to the salon's connected account.
 * → { ok:true, id, last4 } | { ok:false, reason, needs_link }
 */
export async function chargeSavedCard({ tenantId, clientId, amountCents, description, metadata = {}, idempotencyKey }, c = db()) {
  const card = await savedCard(tenantId, clientId, c);
  if (!card) return { ok: false, reason: 'no_card', needs_link: true };
  if (!(amountCents > 0)) return { ok: false, reason: 'zero_amount' };
  const dest = await connectedDestination(tenantId);
  if (!dest) return { ok: false, reason: 'salon_stripe_not_connected', needs_link: true };   // money only ever to the salon
  const body = {
    amount: Math.round(amountCents), currency: 'usd', customer: card.stripe_customer_id, payment_method: card.payment_method_id,
    off_session: true, confirm: true, description: description || 'Missed appointment fee',
    metadata: { tenant_id: tenantId, client_id: clientId, ...metadata },
  };
  body.transfer_data = { destination: dest }; body.on_behalf_of = dest;
  const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
  const cardError = (e) => Number(e?.status) === 402 || e?.type === 'card_error' || /authentication_required|card_declined|expired_card|incorrect_cvc|insufficient_funds/i.test(String(e?.code || '') + String(e?.decline_code || ''));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const pi = await stripeApi('/payment_intents', 'POST', body, headers);
      if (pi?.status === 'succeeded') return { ok: true, id: pi.id, last4: card.last4, brand: card.brand };
      if (pi?.status === 'processing') return { ok: false, uncertain: true, reason: 'processing', id: pi.id };
      await markCard(c, tenantId, clientId, 'declined');
      return { ok: false, reason: pi?.status || 'not_succeeded', id: pi?.id || null, needs_link: true };
    } catch (e) {
      // The bank said no (or wants the client to approve): their card can be replaced, and they get the pay link.
      if (cardError(e)) { await markCard(c, tenantId, clientId, 'declined'); return { ok: false, reason: String(e?.code || e?.message || e).slice(0, 160), needs_link: true }; }
      // Network / Stripe trouble: the charge MAY have gone through — retry once with the same key (Stripe
      // returns the same result), then stop. Never a pay link on top of a charge that may have happened.
      if (attempt === 1 || !idempotencyKey) return { ok: false, uncertain: true, reason: String(e?.message || e).slice(0, 160) };
    }
  }
  return { ok: false, uncertain: true, reason: 'unknown' };
}

async function markCard(c, tenantId, clientId, status) {
  try { await c.from('client_cards').update({ status, updated_at: new Date().toISOString() }).eq('tenant_id', tenantId).eq('client_id', clientId); } catch (_) {}
}

/** After a booking with no deposit: one text asking for a card to hold it (only when the salon charges no-show fees). */
export async function requestCardOnFile({ tenantId, booking, send = null }, c = db()) {
  if (!c || !booking?.id || !booking.client_id) return { ok: true, skipped: true, reason: 'no_client' };
  if (!booking.start_time || new Date(booking.start_time) <= new Date()) return { ok: true, skipped: true, reason: 'start_passed' };
  const pol = await cardPolicy(tenantId, c);
  if (!pol.ask) return { ok: true, skipped: true, reason: 'policy_off' };
  if (await savedCard(tenantId, booking.client_id, c)) return { ok: true, skipped: true, reason: 'card_on_file' };
  const [{ data: tenant }, { data: client }] = await Promise.all([
    c.from('tenants').select('name,phone_number').eq('id', tenantId).maybeSingle(),
    c.from('clients').select('id,name,phone').eq('tenant_id', tenantId).eq('id', booking.client_id).maybeSingle(),
  ]);
  const url = cardLink(booking.id);
  if (!client?.phone || String(client.phone).includes(':') || !tenant?.phone_number) return { ok: true, skipped: true, reason: 'no_phone', url };
  const first = String(client.name || '').split(' ')[0] || 'there';
  const text = `Hi ${first}, ${tenant.name || 'the salon'} holds every appointment with a card on file — it's NOT charged now, only under the salon's no-show policy (${pol.fee_text}). Add it securely here: ${url}  Reply STOP to opt out.`;
  try {
    const sender = send || (await import('./sms.js')).sendSMS;
    await sender({ from: tenant.phone_number, to: client.phone, tenantId, type: 'SMS', text });
  } catch (_) { return { ok: false, reason: 'text_failed', url }; }
  return { ok: true, sent: true, url };
}
