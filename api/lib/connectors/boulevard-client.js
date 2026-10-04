/**
 * api/lib/connectors/boulevard-client.js — Lola books straight into Boulevard, live.
 * ════════════════════════════════════════════════════════════════════════════════
 * Boulevard's Client API (the same API its own booking widget uses):
 *   POST https://dashboard.boulevard.io/api/2020-01/<businessId>/client   (GraphQL)
 *   Authorization: Basic base64(<apiKey>:)
 * The salon connects once in Settings with its Business ID and the API key of its Boulevard app
 * (developers.joinblvd.com). Then, on every call, text and website chat:
 *   availability  → a Boulevard cart for the service (and stylist) → Boulevard's own bookable times
 *   booking       → reserve that exact time → client name / mobile / email → checkout
 *   verification  → the appointment is read back from Boulevard (id, time, state) before Lola says "booked"
 * Nothing is ever claimed that Boulevard didn't confirm. If Boulevard requires a card to book, Lola
 * says so and texts the salon's Boulevard link for the last step.
 */
import { db } from '../db.js';

export const PROVIDER = 'boulevard_client';
const BASE = { live: 'https://dashboard.boulevard.io/api/2020-01/', sandbox: 'https://sandbox.joinblvd.com/api/2020-01/' };
const TIMEOUT = 9000;

const CART = `fragment C on Cart { id expiresAt startTime endTime completedAt errors { code description message }
  clientInformation { firstName lastName email phoneNumber }
  summary { deposit depositAmount paymentMethodRequired subtotal total } }`;
const Q = {
  locations: `query { locations(first: 50) { edges { node { id name businessName tz address { line1 city state } } } } }`,
  createCart: `${CART} mutation CreateCart($input: CreateCartInput!) { createCart(input: $input) { cart { ...C } } }`,
  categories: `query Cart($id: ID!) { cart(id: $id) { availableCategories { id name disabled availableItems { __typename id name disabled
    ... on CartAvailableBookableItem { listDurationRange { min max } } listPriceRange { min max } } } } }`,
  staffVariants: `query Cart($cartId: ID!, $id: ID!) { cart(id: $cartId) { availableItem(id: $id) { ... on CartAvailableBookableItem {
    staffVariants { id duration price staff { id firstName lastName displayName nickname } } } } } }`,
  addItem: `${CART} mutation AddItem($input: AddCartSelectedBookableItemInput!) { addCartSelectedBookableItem(input: $input) { cart { ...C } } }`,
  dates: `query D($id: ID!, $searchRangeLower: Date, $searchRangeUpper: Date, $tz: Tz, $limit: Int) {
    cartBookableDates(id: $id, searchRangeLower: $searchRangeLower, searchRangeUpper: $searchRangeUpper, tz: $tz, limit: $limit) { date } }`,
  times: `query T($id: ID!, $searchDate: Date!, $tz: Tz) { cartBookableTimes(id: $id, searchDate: $searchDate, tz: $tz) { id score startTime } }`,
  reserve: `${CART} mutation R($input: ReserveCartBookableItemsInput!) { reserveCartBookableItems(input: $input) { cart { ...C } } }`,
  update: `${CART} mutation U($input: UpdateCartInput!) { updateCart(input: $input) { cart { ...C } } }`,
  checkout: `${CART} mutation K($input: CheckoutCartInput!) { checkoutCart(input: $input) { cart { ...C } appointments { appointmentId clientId forCartOwner } } }`,
  appointment: `query A($id: ID!, $cartId: ID) { appointment(id: $id, cartId: $cartId) { id state startAt endAt cancelled
    appointmentServices { service { name } staff { firstName lastName displayName } } } }`,
};

export class BoulevardError extends Error { constructor(msg, code) { super(msg); this.code = code || null; } }

/** One GraphQL call to Boulevard's Client API. */
export async function gql(creds, query, variables = {}, { timeoutMs = TIMEOUT } = {}) {
  if (!creds?.apiKey || !creds?.businessId) throw new BoulevardError('Boulevard isn’t connected', 'not_connected');
  const url = (creds.env === 'sandbox' ? BASE.sandbox : BASE.live) + encodeURIComponent(creds.businessId) + '/client';
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Basic ' + Buffer.from(creds.apiKey + ':').toString('base64') },
      body: JSON.stringify({ query, variables }) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403) throw new BoulevardError('Boulevard refused the API key or Business ID', 'auth');
    if (Array.isArray(j.errors) && j.errors.length) {
      const e = j.errors[0] || {};
      throw new BoulevardError(String(e.message || 'Boulevard error'), e.extensions?.code || e.code || null);
    }
    if (!r.ok) throw new BoulevardError('Boulevard answered HTTP ' + r.status, 'http_' + r.status);
    return j.data || {};
  } catch (e) {
    if (e instanceof BoulevardError) throw e;
    throw new BoulevardError(e?.name === 'AbortError' ? 'Boulevard didn’t answer in time' : String(e?.message || e), e?.name === 'AbortError' ? 'timeout' : 'network');
  } finally { clearTimeout(t); }
}
const cartErr = (cart) => (cart?.errors || []).find((e) => e && (e.code || e.message));

/** The salon's Boulevard connection (Settings), or null. */
export async function boulevardCreds(tenantId, c = db()) {
  if (!c || !tenantId) return null;
  try {
    const { getTenantIntegrations } = await import('../db.js');
    const rows = await getTenantIntegrations(tenantId);
    const row = rows.find((r) => r.provider === PROVIDER);
    if (!row?.access_token) return null;
    const m = row.metadata || {};
    if (!m.business_id) return null;
    return { apiKey: row.access_token, businessId: m.business_id, locationId: m.location_id || null, tz: m.tz || null, env: m.env === 'sandbox' ? 'sandbox' : 'live', locationName: m.location_name || null };
  } catch (_) { return null; }
}

export async function listLocations(creds) {
  const d = await gql(creds, Q.locations);
  return (d.locations?.edges || []).map((e) => e.node).filter(Boolean);
}

// ── matching words people say to the salon's real menu and team ──
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !['a', 'an', 'the', 'and', 'with', 'for', 'my', 'service', 'appointment'].includes(w));
const stem = (w) => w.replace(/(ings?|es|s)$/, '');
export function matchItem(items, asked) {
  const q = words(asked).map(stem);
  if (!q.length) return null;
  let best = null, bestScore = 0;
  for (const it of items || []) {
    if (!it || it.disabled) continue;
    const n = words(it.name).map(stem);
    if (String(it.name).toLowerCase().trim() === String(asked).toLowerCase().trim()) return it;
    const hit = q.filter((w) => n.some((x) => x === w || (w.length > 3 && (x.startsWith(w) || w.startsWith(x))))).length;
    const score = hit / Math.max(q.length, 1) + hit / Math.max(n.length, 1) * 0.5;
    if (hit && score > bestScore) { best = it; bestScore = score; }
  }
  return best;
}
export function matchStaff(variants, asked) {
  const q = words(asked);
  if (!q.length) return null;
  return (variants || []).find((v) => {
    const s = v.staff || {};
    const names = words([s.displayName, s.nickname, s.firstName, s.lastName].filter(Boolean).join(' '));
    return q.some((w) => names.includes(w));
  }) || null;
}

/** A Boulevard cart holding the service (and the stylist, if asked). */
export async function startCart(creds, { service, stylist = null }) {
  let locationId = creds.locationId;
  if (!locationId) { const locs = await listLocations(creds); locationId = locs[0]?.id || null; }
  const created = await gql(creds, Q.createCart, { input: locationId ? { locationId } : {} });
  const cart = created.createCart?.cart;
  if (!cart?.id) throw new BoulevardError('Boulevard didn’t open a booking', 'no_cart');
  const cats = (await gql(creds, Q.categories, { id: cart.id })).cart?.availableCategories || [];
  const items = cats.filter((c) => !c.disabled).flatMap((c) => c.availableItems || []).filter((i) => !i.__typename || /Bookable/.test(i.__typename));
  const item = matchItem(items, service);
  if (!item) return { cartId: cart.id, item: null, menu: items.filter((i) => !i.disabled).map((i) => i.name).slice(0, 12) };
  let staffVariant = null, staffAsked = null;
  if (stylist && !/any|anyone|no preference|whoever/i.test(String(stylist))) {
    const v = (await gql(creds, Q.staffVariants, { cartId: cart.id, id: item.id })).cart?.availableItem?.staffVariants || [];
    staffVariant = matchStaff(v, stylist);
    staffAsked = stylist;
  }
  const added = (await gql(creds, Q.addItem, { input: { id: cart.id, itemId: item.id, itemStaffVariantId: staffVariant?.id || null } })).addCartSelectedBookableItem?.cart;
  const err = cartErr(added);
  if (err && !/MISSING_CLIENT|RESERVATION|NO_RESERVED|PAYMENT/i.test(String(err.code || ''))) throw new BoulevardError(err.message || err.description || 'Boulevard couldn’t add that service', err.code);
  const staffName = staffVariant ? (staffVariant.staff?.displayName || [staffVariant.staff?.firstName].filter(Boolean).join(' ')) : null;
  return { cartId: cart.id, item, staffVariant, staffName, staffMissing: !!(staffAsked && !staffVariant) };
}

/** Boulevard's own open times for a cart on a date (YYYY-MM-DD in the salon's time zone). */
export async function bookableTimes(creds, cartId, date, tz) {
  const d = await gql(creds, Q.times, { id: cartId, searchDate: date, tz: tz || creds.tz || 'America/New_York' });
  return (d.cartBookableTimes || []).filter((t) => t?.id && t.startTime);
}
export async function nextDates(creds, cartId, fromDate, tz, limit = 3) {
  const upper = new Date(Date.parse(fromDate + 'T12:00:00Z') + 21 * 864e5).toISOString().slice(0, 10);
  const d = await gql(creds, Q.dates, { id: cartId, searchRangeLower: fromDate, searchRangeUpper: upper, tz: tz || creds.tz || 'America/New_York', limit });
  return (d.cartBookableDates || []).map((x) => x.date).filter(Boolean);
}

/**
 * Availability, live from Boulevard.
 * → { ok, service, staffName, exact:<time|null>, times:[{id,startTime}], nextDate, nextTimes, menu? }
 */
export async function checkBoulevard(creds, { service, date, wantAt = null, stylist = null, tz }) {
  const cart = await startCart(creds, { service, stylist });
  if (!cart.item) return { ok: false, error: 'service_not_found', menu: cart.menu };
  let times = await bookableTimes(creds, cart.cartId, date, tz);
  const exact = wantAt ? times.find((t) => Math.abs(Date.parse(t.startTime) - Date.parse(wantAt)) < 60e3) || null : null;
  let nextDate = null, nextTimes = [];
  if (!times.length) {
    const dates = await nextDates(creds, cart.cartId, date, tz, 2).catch(() => []);
    nextDate = dates.find((d) => d > date) || null;
    if (nextDate) nextTimes = await bookableTimes(creds, cart.cartId, nextDate, tz).catch(() => []);
  }
  return { ok: true, service: cart.item.name, duration: cart.item.listDurationRange?.min || null, staffName: cart.staffName, staffMissing: cart.staffMissing, exact, times, nextDate, nextTimes, cartId: cart.cartId };
}

/** Pick the 3 times closest to what they asked (or spread through the day). */
export function pickOffers(times, wantAt = null, n = 3) {
  const list = [...(times || [])];
  if (wantAt) list.sort((a, b) => Math.abs(Date.parse(a.startTime) - Date.parse(wantAt)) - Math.abs(Date.parse(b.startTime) - Date.parse(wantAt)));
  else if (list.length > n) { const step = list.length / n; return Array.from({ length: n }, (_, i) => list[Math.floor(i * step)]); }
  return list.slice(0, n).sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
}

/**
 * Book in Boulevard and verify it. client: { firstName, lastName, phone, email }.
 * → { ok:true, appointmentId, startAt, service, staffName, state, verified:true }
 *   { ok:false, error:'taken', offers:[...] } | { ok:false, error:'card_required' } | { ok:false, error, message }
 */
export async function bookBoulevard(creds, { service, date, wantAt, stylist = null, tz, client, notes = 'Booked by Lola (LolaDesk)' }) {
  const cart = await startCart(creds, { service, stylist });
  if (!cart.item) return { ok: false, error: 'service_not_found', menu: cart.menu };
  const times = await bookableTimes(creds, cart.cartId, date, tz);
  const slot = times.find((t) => Math.abs(Date.parse(t.startTime) - Date.parse(wantAt)) < 60e3);
  if (!slot) return { ok: false, error: 'taken', offers: pickOffers(times, wantAt), service: cart.item.name, staffName: cart.staffName };
  let c1 = (await gql(creds, Q.reserve, { input: { id: cart.cartId, bookableTimeId: slot.id } })).reserveCartBookableItems?.cart;
  const rErr = cartErr(c1);
  if (rErr && /TIME|RESERV|UNAVAILABLE|TAKEN/i.test(String(rErr.code || rErr.message || ''))) return { ok: false, error: 'taken', offers: pickOffers(times.filter((t) => t.id !== slot.id), wantAt), service: cart.item.name };
  const info = { firstName: client.firstName, lastName: client.lastName || null, email: client.email || null, phoneNumber: client.phone || null };
  c1 = (await gql(creds, Q.update, { input: { id: cart.cartId, clientInformation: info, clientMessage: notes } })).updateCart?.cart || c1;
  if (c1?.summary?.paymentMethodRequired) return { ok: false, error: 'card_required', service: cart.item.name, startAt: slot.startTime };
  const out = (await gql(creds, Q.checkout, { input: { id: cart.cartId } })).checkoutCart || {};
  const kErr = cartErr(out.cart);
  const appt = (out.appointments || []).find((a) => a.forCartOwner !== false) || (out.appointments || [])[0];
  if (!appt?.appointmentId) {
    if (kErr && /PAYMENT|CARD/i.test(String(kErr.code || kErr.message))) return { ok: false, error: 'card_required', service: cart.item.name, startAt: slot.startTime };
    return { ok: false, error: 'checkout_failed', message: kErr?.message || kErr?.description || 'Boulevard didn’t confirm the booking' };
  }
  // Verify: read the appointment back from Boulevard before anyone hears "booked".
  let verified = null;
  try { verified = (await gql(creds, Q.appointment, { id: appt.appointmentId, cartId: cart.cartId })).appointment || null; } catch (_) { verified = null; }
  if (verified && verified.cancelled) return { ok: false, error: 'checkout_failed', message: 'Boulevard shows that appointment as cancelled' };
  const svc = verified?.appointmentServices?.[0];
  return {
    ok: true, verified: !!verified, appointmentId: appt.appointmentId, clientId: appt.clientId || null,
    startAt: verified?.startAt || slot.startTime, endAt: verified?.endAt || null, state: verified?.state || 'BOOKED',
    service: svc?.service?.name || cart.item.name,
    staffName: svc?.staff ? (svc.staff.displayName || svc.staff.firstName) : cart.staffName,
  };
}

/** Settings → "Connect Boulevard": prove the keys work and find the location. */
export async function verifyConnection({ apiKey, businessId, env = 'live' }) {
  const creds = { apiKey: String(apiKey || '').trim(), businessId: String(businessId || '').trim(), env };
  const locs = await listLocations(creds);
  if (!locs.length) throw new BoulevardError('Boulevard answered, but this business has no locations open for online booking', 'no_locations');
  return { creds, locations: locs.map((l) => ({ id: l.id, name: l.name || l.businessName, tz: l.tz || null, city: l.address?.city || null })) };
}

// ═══ The standard LolaDesk connector contract (lib/aggregator.js) ═══════════════════════════════
// Every booking system plugs into Lola the same way; a "live" connector also answers availability
// and books + verifies synchronously (lib/live-booking.js). Boulevard connects with keys, not OAuth.
export const META = { name: 'Boulevard', description: 'Live: real availability, booked and verified in Boulevard.', status: 'available', live: true, connect: 'keys', docs: 'https://developers.joinblvd.com' };
export function credsFromIntegration(integration) {
  const m = integration?.metadata || {};
  if (!integration?.access_token || !m.business_id) return null;
  return { apiKey: integration.access_token, businessId: m.business_id, locationId: m.location_id || null, tz: m.tz || null, env: m.env === 'sandbox' ? 'sandbox' : 'live' };
}
export function getAuthUrl() { throw new Error('Boulevard connects with your Business ID and app API key (Settings → Boulevard).'); }
export async function exchangeCode() { return { ok: false, error: 'Boulevard connects with keys' }; }
export async function refreshToken() { return null; }
export async function listAppointments() { return []; }        // availability is read live, never from a copy
export async function listClients() { return []; }

/** { service, date:'YYYY-MM-DD', wantAt, stylist, tz } → normalized live availability. */
export async function liveAvailability(integration, args) {
  const creds = credsFromIntegration(integration);
  if (!creds) throw new BoulevardError('Boulevard isn’t connected', 'not_connected');
  return checkBoulevard(creds, { ...args, tz: args.tz || creds.tz });
}
/**
 * Generic payload (lib/booking-brain.js shape + live fields): { starts_at, date, service, stylist, timezone,
 * client:{ first_name, last_name, name, phone, email }, notes } → { id, verified, starts_at, ends_at, service, staff }.
 * Throws with .code = 'conflict' (and .offers) when the time is gone, 'card_required', 'service_not_found'.
 */
export async function createAppointment(integration, p) {
  const creds = credsFromIntegration(integration);
  if (!creds) throw new BoulevardError('Boulevard isn’t connected', 'not_connected');
  const tz = p.timezone || creds.tz || 'America/New_York';
  const date = p.date || new Date(p.starts_at).toLocaleDateString('en-CA', { timeZone: tz });
  const name = String(p.client?.name || p.client_name || '').trim().split(/\s+/);
  const r = await bookBoulevard(creds, { service: p.service || '', date, wantAt: p.starts_at, stylist: p.stylist || null, tz,
    client: { firstName: p.client?.first_name || name[0] || 'Client', lastName: p.client?.last_name || name.slice(1).join(' '), phone: p.client?.phone || p.client_phone || null, email: p.client?.email || null }, notes: p.notes });
  if (!r.ok) { const e = new BoulevardError(r.message || r.error, r.error === 'taken' ? 'conflict' : r.error); e.offers = r.offers || []; e.menu = r.menu || []; throw e; }
  return { id: r.appointmentId, external_id: r.appointmentId, verified: r.verified, starts_at: r.startAt, ends_at: r.endAt, service: r.service, staff: r.staffName, state: r.state };
}
