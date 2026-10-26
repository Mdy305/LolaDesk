/**
 * api/lib/terminal.js — the card reader at the front desk (Stripe Terminal, server-driven).
 * ════════════════════════════════════════════════════════════════════
 * Smart readers (Stripe Reader S700 / WisePOS E) talk to Stripe over Wi-Fi;
 * LolaDesk never touches card data. The salon pairs a reader once (the code
 * on its screen), then checkout sends each sale straight to it:
 *
 *   pairReader      → a Location for the salon (once) + the reader, tagged with the salon
 *   startReaderSale → PaymentIntent (card_present) whose money goes to the salon
 *                     (destination charge, LolaDesk's fee) + process it on the reader
 *   saleStatus      → paid / waiting / failed; marks the checkout row paid
 *
 * Readers and locations live on LolaDesk's Stripe account and carry
 * metadata.tenant_id; every action checks the reader belongs to the salon.
 */
import { stripeApi, connectedDestination } from './stripe.js';
import { feeFor } from './payments-fee.js';

const SLOT = 'payments';
async function getMem(c, tid, key) {
  try { const { data } = await c.from('client_memories').select('value').eq('tenant_id', tid).eq('client_phone', SLOT).eq('key', key).maybeSingle(); return data?.value ?? null; } catch { return null; }
}
async function setMem(c, tid, key, value) {
  try { await c.from('client_memories').upsert({ tenant_id: tid, client_phone: SLOT, key, value }, { onConflict: 'tenant_id,client_phone,key' }); } catch {}
}
export const testMode = () => /^sk_test_/.test(String(process.env.STRIPE_SECRET_KEY || ''));
const enc = encodeURIComponent;

export function readerView(r) {
  return { id: r.id, label: r.label || 'Card reader', status: r.status || 'offline', device: r.device_type || '', simulated: /simulated/.test(String(r.device_type || '')) };
}

export async function listReaders(c, tenant) {
  const out = [];
  let after = null;
  for (let i = 0; i < 5; i++) {
    const page = await stripeApi(`/terminal/readers?limit=100${after ? '&starting_after=' + enc(after) : ''}`, 'GET');
    for (const r of page?.data || []) if (r.metadata?.tenant_id === tenant.id) out.push(readerView(r));
    if (!page?.has_more || !page.data?.length) break;
    after = page.data[page.data.length - 1].id;
  }
  return out;
}

async function ownReader(tenant, readerId) {
  if (!/^tmr_[A-Za-z0-9]+$/.test(String(readerId || ''))) return null;
  try { const r = await stripeApi(`/terminal/readers/${enc(readerId)}`, 'GET'); return r?.metadata?.tenant_id === tenant.id && !r.deleted ? r : null; } catch { return null; }
}

/** The salon's Location (created once, with its address). */
async function ensureLocation(c, tenant, address) {
  const known = await getMem(c, tenant.id, 'terminal_location');
  if (known?.id) return known.id;
  const a = address || {};
  if (!a.line1 || !a.city || !a.state || !a.postal_code) { const e = new Error('address_needed'); e.code = 'address_needed'; throw e; }
  const loc = await stripeApi('/terminal/locations', 'POST', {
    display_name: String(tenant.name || 'Salon').slice(0, 100),
    address: { line1: a.line1, ...(a.line2 ? { line2: a.line2 } : {}), city: a.city, state: a.state, postal_code: a.postal_code, country: 'US' },
    metadata: { tenant_id: tenant.id },
  });
  await setMem(c, tenant.id, 'terminal_location', { id: loc.id });
  return loc.id;
}

/**
 * Pair a reader. code = the registration code on the reader's screen
 * ("simulated-wpe" pairs Stripe's simulated reader in test mode).
 */
export async function pairReader(c, tenant, { code, label, address } = {}) {
  const reg = String(code || '').trim().toLowerCase();
  if (!reg) return { ok: false, say: 'Enter the code shown on your reader.' };
  if (!(await connectedDestination(tenant.id))) return { ok: false, say: 'Turn on payments first, so card money goes to your bank.' };
  let location;
  try { location = await ensureLocation(c, tenant, address); }
  catch (e) { if (e.code === 'address_needed') return { ok: false, address_needed: true, say: 'Add your salon address once. Stripe needs it for in-person payments.' }; throw e; }
  const r = await stripeApi('/terminal/readers', 'POST', { registration_code: reg, label: String(label || 'Front desk').slice(0, 60), location, metadata: { tenant_id: tenant.id } });
  return { ok: true, reader: readerView(r), say: `${r.label || 'Your reader'} is paired.` };
}

export async function removeReader(tenant, readerId) {
  const r = await ownReader(tenant, readerId);
  if (!r) return { ok: false, say: 'That reader isn’t paired to your salon.' };
  await stripeApi(`/terminal/readers/${enc(r.id)}`, 'DELETE');
  return { ok: true };
}

/** Create the payment and send it to the reader. → { ok, payment_intent, reader } */
export async function startReaderSale(tenant, { readerId, amountCents, description, metadata = {} }) {
  const r = await ownReader(tenant, readerId);
  if (!r) return { ok: false, say: 'Pick a reader paired to your salon.' };
  const dest = await connectedDestination(tenant.id);
  if (!dest) return { ok: false, say: 'Turn on payments first, so card money goes to your bank.' };
  const amount = Math.round(Number(amountCents) || 0);
  if (amount < 50) return { ok: false, say: 'The total is too small for a card payment.' };
  const fee = feeFor(amount);
  const pi = await stripeApi('/payment_intents', 'POST', {
    amount, currency: 'usd', payment_method_types: ['card_present'], capture_method: 'automatic',
    description: String(description || 'Salon visit').slice(0, 200),
    transfer_data: { destination: dest }, on_behalf_of: dest,
    ...(fee > 0 ? { application_fee_amount: fee } : {}),
    metadata: { ...metadata, tenant_id: tenant.id, pos_sale: 'true', reader_id: r.id },
  });
  try {
    await stripeApi(`/terminal/readers/${enc(r.id)}/process_payment_intent`, 'POST', { payment_intent: pi.id });
  } catch (e) {
    try { await stripeApi(`/payment_intents/${enc(pi.id)}/cancel`, 'POST', {}); } catch (_) {}
    return { ok: false, say: /offline|unreachable|not reachable/i.test(String(e?.message)) ? 'The reader is offline. Check it’s on and connected to Wi-Fi.' : `The reader didn’t take it: ${String(e?.message || e).slice(0, 120)}` };
  }
  return { ok: true, payment_intent: pi.id, reader: r.id, fee_cents: fee };
}

/** Where a reader sale stands. Marks the checkout row paid once. */
export async function saleStatus(c, tenant, paymentIntentId) {
  if (!/^pi_[A-Za-z0-9]+$/.test(String(paymentIntentId || ''))) return { ok: false, status: 'unknown' };
  const pi = await stripeApi(`/payment_intents/${enc(paymentIntentId)}?expand[]=latest_charge`, 'GET');
  if (pi?.metadata?.tenant_id !== tenant.id) return { ok: false, status: 'unknown' };
  if (pi.status === 'succeeded') {
    await markPosPaid(c, pi);
    const ch = pi.latest_charge || {};
    const card = ch.payment_method_details?.card_present || {};
    return { ok: true, status: 'paid', amount_cents: pi.amount_received || pi.amount, brand: card.brand || null, last4: card.last4 || null };
  }
  if (pi.status === 'canceled') return { ok: true, status: 'canceled' };
  const err = pi.last_payment_error?.message;
  if (err) return { ok: true, status: 'declined', say: err };
  return { ok: true, status: 'waiting' };
}

export async function cancelReaderSale(tenant, { readerId, paymentIntentId }) {
  const r = await ownReader(tenant, readerId);
  if (r) { try { await stripeApi(`/terminal/readers/${enc(r.id)}/cancel_action`, 'POST', {}); } catch (_) {} }
  if (/^pi_/.test(String(paymentIntentId || ''))) {
    try {
      const pi = await stripeApi(`/payment_intents/${enc(paymentIntentId)}`, 'GET');
      if (pi?.metadata?.tenant_id === tenant.id && pi.status !== 'succeeded') await stripeApi(`/payment_intents/${enc(paymentIntentId)}/cancel`, 'POST', {});
    } catch (_) {}
  }
  return { ok: true };
}

/** Test mode only: tap a test card on Stripe's simulated reader. */
export async function simulateTap(tenant, readerId) {
  if (!testMode()) return { ok: false, say: 'Only available with Stripe test keys.' };
  const r = await ownReader(tenant, readerId);
  if (!r) return { ok: false, say: 'That reader isn’t paired to your salon.' };
  await stripeApi(`/test_helpers/terminal/readers/${enc(r.id)}/present_payment_method`, 'POST', {});
  return { ok: true };
}

/** Checkout row → paid (from saleStatus or the webhook). Safe to call twice. */
export async function markPosPaid(c, pi) {
  if (!c || !pi?.id) return;
  const ch = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
  try {
    await c.from('pos_transactions').update({ status: 'paid', paid_at: new Date().toISOString() }).eq('stripe_id', pi.id).neq('status', 'paid');
  } catch (_) {}
  try {
    await c.from('payments').upsert({
      tenant_id: pi.metadata?.tenant_id, stripe_id: pi.id, kind: 'charge', sub_kind: 'pos_card', status: 'succeeded',
      amount: pi.amount_received || pi.amount || 0, currency: pi.currency || 'usd', stripe_fee: pi.application_fee_amount || 0,
      card_brand: ch?.payment_method_details?.card_present?.brand || null, card_last4: ch?.payment_method_details?.card_present?.last4 || null,
      receipt_url: ch?.receipt_url || null, description: pi.description || null, client_id: pi.metadata?.client_id || null, metadata: pi.metadata || {}, at_risk: false,
    }, { onConflict: 'stripe_id' });
  } catch (_) {}
}
