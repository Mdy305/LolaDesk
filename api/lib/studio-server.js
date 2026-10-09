/**
 * api/lib/studio-server.js — MMA Studio side effects: client record, Lola inbox, owner text,
 * deposit Checkout on the salon's own Stripe (Connect), install booking.
 */
import { db, e164, upsertClient, getOrStartConversation, logMessage, logUsage, createBooking } from './db.js';
import { sendSMS } from './sms.js';
import { connectAccount, stripePlatform } from './stripe.js';
import { STUDIO_DEPOSIT_CENTS, STUDIO_INSTALL_MINUTES, ownerText, inboxNote, lookLine, money, clientText } from './studio.js';

const LEAD_ALERT_EVERY_MS = 6 * 3600e3;

function salonHour(tenant, now = new Date()) {
  try { return Number(new Intl.DateTimeFormat('en-US', { timeZone: tenant.timezone || 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(now)) % 24; }
  catch { return now.getUTCHours(); }
}

/** Who gets the owner texts: STUDIO_ALERT_TO (e.g. +17864497058), else the salon's operator phone. */
export function alertNumber(tenant) {
  return e164(process.env.STUDIO_ALERT_TO || '') || e164(tenant?.operator_phone || '') || null;
}

const PHOTO_BUCKET = 'studio-orders';            // private; reached only through signed links
const PHOTO_LINK_SECONDS = 365 * 24 * 3600;      // the reference stays usable until the install and after

/** Save the client's color reference (order card, her photo, the try-on). Returns { paths, urls, links }. */
export async function saveStudioPhotos(tenant, v, now = Date.now()) {
  const c = db(); const kinds = Object.keys(v.photos || {});
  if (!c || !kinds.length) return { paths: {}, urls: {}, links: '' };
  const folder = `${tenant.id}/${new Date(now).toISOString().slice(0, 10)}/${v.phone.replace(/\D/g, '')}-${now.toString(36)}`;
  const paths = {}, urls = {};
  for (const k of kinds) {
    const path = `${folder}/${k}.jpg`;
    let { error } = await c.storage.from(PHOTO_BUCKET).upload(path, v.photos[k], { contentType: 'image/jpeg', upsert: true });
    if (error && /bucket/i.test(error.message || '')) {          // first order ever: create the private bucket
      await c.storage.createBucket(PHOTO_BUCKET, { public: false }).catch(() => null);
      ({ error } = await c.storage.from(PHOTO_BUCKET).upload(path, v.photos[k], { contentType: 'image/jpeg', upsert: true }));
    }
    if (error) { console.error('[studio] photo', k, error.message); continue; }
    paths[k] = path;
  }
  Object.assign(urls, await signStudioPhotos(paths));
  const label = { card: 'Order card', before: 'Her photo', after: 'Try-on' };
  const links = Object.keys(urls).length ? '\n' + Object.entries(urls).map(([k, u]) => `${label[k]}: ${u}`).join('\n') : '';
  return { paths, urls, links };
}

export async function signStudioPhotos(paths = {}) {
  const c = db(); const urls = {};
  if (!c) return urls;
  for (const [k, path] of Object.entries(paths)) {
    if (!path) continue;
    const { data } = await c.storage.from(PHOTO_BUCKET).createSignedUrl(path, PHOTO_LINK_SECONDS).catch(() => ({ data: null }));
    if (data?.signedUrl) urls[k] = data.signedUrl;
  }
  return urls;
}

export async function textOwner(tenant, text, { quietHours = false, mediaUrls = null } = {}) {
  const to = alertNumber(tenant);
  if (!to) return { texted: false, reason: 'no_alert_number' };
  const h = salonHour(tenant);
  if (quietHours && (h < 8 || h >= 21)) return { texted: false, reason: 'night' };   // it waits in the Lola inbox
  try {
    const r = await sendSMS({ to, text, tenantId: tenant.id, tenant, skipOptOut: true, mediaUrls });
    return { texted: !(r && r.skipped), reason: r && r.skipped ? r.reason : null };
  } catch (e) { return { texted: false, reason: 'send_failed' }; }
}

/** Client record + the client's thread in the Lola inbox, with the studio note. */
export async function recordStudio(tenant, v, extra = {}) {
  const client = await upsertClient(tenant.id, { phone: v.phone, name: v.name });
  const conv = await getOrStartConversation(tenant.id, { clientId: client?.id, channel: 'web', agent: 'studio' });
  if (conv?.id) await logMessage({ conversationId: conv.id, tenantId: tenant.id, role: 'user', agent: 'studio', content: inboxNote(v, extra) });
  await logUsage(tenant.id, v.event === 'lead' ? 'lead' : 'studio_' + v.event, 1, { source: 'mma-studio', name: v.name, phone: v.phone, look: v.look, install: v.install, photos: extra.paths || undefined });
  return { client, conv };
}

/** One lead text per client per 6 hours (a client may restart the try-on several times). */
export async function leadAlertedRecently(tenant, phone, now = Date.now()) {
  const c = db(); if (!c) return false;
  try {
    const { data } = await c.from('usage_events').select('created_at, metadata').eq('tenant_id', tenant.id).eq('kind', 'lead')
      .gte('created_at', new Date(now - LEAD_ALERT_EVERY_MS).toISOString()).limit(200);
    return (data || []).filter((r) => r?.metadata?.source === 'mma-studio' && r.metadata.phone === phone).length > 1;
  } catch { return false; }
}

/** $500 deposit through Stripe Checkout on the salon's connected account (Apple Pay included). */
export async function createDepositCheckout(tenant, v, { clientId = null, conversationId = null, cardPath = '' } = {}) {
  const acct = await connectAccount(tenant.id).catch(() => null);
  if (!acct?.stripe_account_id) return { url: null, reason: 'payments_not_connected' };
  const back = process.env.STUDIO_RETURN_URL || 'https://www.mmasalon.com/studio';
  const meta = {
    source: 'mma-studio', tenant_id: tenant.id, client_id: clientId || '', conversation_id: conversationId || '',
    name: v.name, phone: v.phone, look: lookLine(v).slice(0, 480),
    shade: v.look.shade, code: v.look.code || '', inches: String(v.look.inches), fullness: v.look.fullness,
    price_cents: String(v.look.priceCents), color_change: v.look.colorChange ? 'yes' : 'no',
    match: v.look.match || '', card_path: String(cardPath || '').slice(0, 480)
  };
  const session = await stripePlatform().raw.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: STUDIO_DEPOSIT_CENTS,
      product_data: { name: `Hair deposit · ${v.look.shade} ${v.look.inches}″ ${v.look.fullness}`, description: `Credited to your ${money(v.look.priceCents)} total. Balance due at your install.` } } }],
    success_url: back + (back.includes('?') ? '&' : '?') + 'studio=paid',
    cancel_url: back + (back.includes('?') ? '&' : '?') + 'studio=back',
    metadata: meta, payment_intent_data: { metadata: meta, description: 'MMA Studio hair deposit' }
  }, { stripeAccount: acct.stripe_account_id });
  return { url: session.url, id: session.id };
}

/** Stripe webhook: a studio deposit was paid. Owner gets the "order the hair" text; client gets her confirmation. */
export async function studioDepositPaid(c, session) {
  const m = session?.metadata || {};
  if (m.source !== 'mma-studio' || !m.tenant_id) return { handled: false };
  const { data: tenant } = await c.from('tenants').select('*').eq('id', m.tenant_id).maybeSingle();
  if (!tenant) return { handled: false, reason: 'unknown_tenant' };
  const priceCents = Number(m.price_cents) || 0;
  const v = { event: 'order', name: m.name, phone: m.phone,
    look: { method: '', shade: m.shade, code: m.code, inches: Number(m.inches), fullness: m.fullness, grams: '', priceCents, colorChange: m.color_change === 'yes' } };
  if (m.conversation_id) await logMessage({ conversationId: m.conversation_id, tenantId: tenant.id, role: 'user', agent: 'studio',
    content: `MMA Studio: paid the ${money(STUDIO_DEPOSIT_CENTS)} deposit. ${m.look}.` }).catch(() => {});
  await logUsage(tenant.id, 'studio_deposit_paid', 1, { source: 'mma-studio', phone: m.phone, amount_cents: session.amount_total || STUDIO_DEPOSIT_CENTS }).catch(() => {});
  const card = m.card_path ? (await signStudioPhotos({ card: m.card_path })).card : null;
  await textOwner(tenant, `MMA Studio · DEPOSIT PAID ${money(session.amount_total || STUDIO_DEPOSIT_CENTS)}: ${m.name} ${m.phone}. ${m.look}.${m.match ? ' AI read: ' + m.match + '.' : ''} Order the hair now. Balance at install: ${money(priceCents - STUDIO_DEPOSIT_CENTS)}.${card ? ' Color reference attached.' : ''}`,
    { mediaUrls: card ? [card] : null });
  const first = String(m.name || '').split(/\s+/)[0] || 'there';
  await sendSMS({ to: m.phone, tenantId: tenant.id, tenant,
    text: `Bonjour ${first}, it's Lola from MMA Salon. Your ${m.shade} hair is ordered and your ${money(STUDIO_DEPOSIT_CENTS)} is credited to your total. I'll text you the moment it arrives.` }).catch(() => {});
  return { handled: true };
}

export async function bookInstall(tenant, v, { clientId, conversationId }) {
  return createBooking(tenant.id, { clientId, conversationId, service: null, stylist: null,
    startsAt: v.install.startsAt, durationMin: STUDIO_INSTALL_MINUTES, price: Math.round(v.look.priceCents / 100) });
}

export { ownerText };

/** Her own welcome text (daytime only, opt-out respected by the SMS funnel). */
export async function textClient(tenant, v, kind) {
  const h = salonHour(tenant);
  if (h < 9 || h >= 20) return { texted: false, reason: 'night' };
  try {
    const r = await sendSMS({ to: v.phone, text: clientText(v, kind), tenantId: tenant.id, tenant });
    return { texted: !(r && r.skipped), reason: r && r.skipped ? r.reason : null };
  } catch { return { texted: false, reason: 'send_failed' }; }
}

/**
 * Hourly: a client who started the try-on 20 to 30 hours ago and has not ordered, booked or paid
 * gets one gentle follow-up text, between 10am and 7pm salon time. Never twice.
 */
export async function studioFollowups(c, now = Date.now()) {
  const from = new Date(now - 30 * 3600e3).toISOString(), to = new Date(now - 20 * 3600e3).toISOString();
  const { data: leads = [] } = await c.from('usage_events').select('tenant_id, created_at, metadata')
    .eq('kind', 'lead').gte('created_at', from).lte('created_at', to).limit(500);
  const seen = new Set(); let sent = 0, skipped = 0;
  for (const l of leads || []) {
    const m = l.metadata || {};
    if (m.source !== 'mma-studio' || !m.phone) continue;
    const key = l.tenant_id + m.phone; if (seen.has(key)) continue; seen.add(key);
    const { data: after = [] } = await c.from('usage_events').select('kind, metadata').eq('tenant_id', l.tenant_id)
      .in('kind', ['studio_order', 'studio_booking', 'studio_deposit_paid', 'studio_followup'])
      .gte('created_at', new Date(now - 30 * 3600e3).toISOString()).limit(500);
    if ((after || []).some((r) => r?.metadata?.phone === m.phone)) { skipped++; continue; }
    const { data: tenant } = await c.from('tenants').select('*').eq('id', l.tenant_id).maybeSingle();
    if (!tenant) continue;
    const h = salonHour(tenant);
    if (h < 10 || h >= 19) { skipped++; continue; }                     // a later hourly run will catch her in the window
    const r = await sendSMS({ to: m.phone, text: clientText({ name: m.name, phone: m.phone }, 'followup'), tenantId: tenant.id, tenant }).catch(() => null);
    await logUsage(tenant.id, 'studio_followup', 1, { source: 'mma-studio', phone: m.phone, sent: !!(r && !r.skipped) }).catch(() => {});
    if (r && !r.skipped) sent++;
  }
  return { sent, skipped };
}
