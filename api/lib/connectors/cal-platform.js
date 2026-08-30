/**
 * Cal.com (White-Label) connector — a scalable booking-mesh node.
 *
 * Same contract as square.js / booksy.js so aggregator.js, booking-sync.js,
 * integration-health.js and lola-tools.js need zero changes beyond
 * registration. It speaks Cal.com API v2 (https://api.cal.com/v2) with the
 * `cal-api-version: 2024-08-13` header and the {status, data} response
 * wrapper.
 *
 * TWO auth modes, both env-gated and resolved per request:
 *   1. API-key mode (works today, no Platform plan needed):
 *        CAL_COM_API_KEY = cal_... or cal_live_... key from Cal.com Settings.
 *      Every tenant integration row is optional; calls act on the key owner's
 *      Cal.com account. Connect a tenant by storing a row with
 *      metadata.cal_email (or just rely on the shared key).
 *   2. White-label Platform mode (existing Platform customers; new Platform
 *      signups are paused per Cal.com's Dec 2025 notice):
 *        CAL_COM_CLIENT_ID / CAL_COM_CLIENT_SECRET  (platform OAuth client)
 *      provisionManagedUser() creates a per-tenant managed user and returns
 *      access/refresh tokens to persist in the integration row (never log
 *      them). API calls then use Authorization: Bearer <managed access
 *      token>, refreshed via POST /v2/oauth/{clientId}/refresh.
 *
 * No browser OAuth consent screen exists for this flow, so getAuthUrl()
 * throws a descriptive config error (Booksy convention) instead of sending a
 * tenant to a broken consent screen.
 */
export const META = {
  name: 'Cal.com (White-Label)',
  description: 'Scalable white-label booking mesh — Cal.com Platform event types, slots, and bookings.',
  status: 'beta',
  docs: 'https://cal.com/docs/api-reference/v2/introduction'
};

const API_BASE = 'https://api.cal.com/v2';
const VERSION = process.env.CAL_COM_API_VERSION || '2024-08-13';
const DEFAULT_TZ = process.env.CAL_COM_TIME_ZONE || 'America/New_York';

function clientCreds(){
  const id = process.env.CAL_COM_CLIENT_ID;
  const secret = process.env.CAL_COM_CLIENT_SECRET;
  return id && secret ? { id, secret } : null;
}

/** Resolve the bearer token for a tenant integration row. */
function bearerToken(integration){
  return integration?.access_token || integration?.accessToken || process.env.CAL_COM_API_KEY || process.env.CAL_COM_ACCESS_TOKEN || null;
}

function headers(integration, { platform = false } = {}){
  const h = { 'Content-Type': 'application/json', 'cal-api-version': VERSION };
  const token = bearerToken(integration);
  if (token) h.Authorization = `Bearer ${token}`;
  const creds = clientCreds();
  if (platform && creds){ h['x-cal-client-id'] = creds.id; h['x-cal-secret-key'] = creds.secret; }
  return h;
}

async function parse(r, ctx){
  let data;
  try { data = await r.json(); }
  catch { throw new Error(`Cal.com ${ctx}: non-JSON response (HTTP ${r.status})`); }
  if (!r.ok || data?.status === 'error'){
    const msg = data?.error?.message || data?.message || `HTTP ${r.status}`;
    throw new Error(`Cal.com ${ctx} failed: ${msg}`);
  }
  return data?.data !== undefined ? data.data : data;
}

/** Normalize a Cal.com v2 booking to the mesh appointment shape. */
function normalizeBooking(b){
  const attendee = (b.attendees || [])[0] || {};
  const host = (b.hosts || [])[0] || {};
  const start = b.start || b.startTime;
  const end = b.end || b.endTime;
  const dur = b.duration || (start && end ? Math.round((new Date(end) - new Date(start)) / 60000) : 60);
  return {
    id: b.uid || String(b.id),
    starts_at: start,
    ends_at: end,
    duration_min: dur,
    client: { name: attendee.name || 'Guest', email: attendee.email || null, phone: attendee.phone || null },
    service: b.eventType?.slug || b.event_type?.slug || null,
    stylist: host.name || host.email || null,
    status: String(b.status || 'accepted').toLowerCase(),
    raw: b
  };
}

/**
 * No browser OAuth for Cal.com Platform — provisioning is server-side.
 * Throwing a descriptive error keeps the oauth/connect flow honest (Booksy
 * convention) instead of sending tenants to a consent screen that can't exist.
 */
export function getAuthUrl(){
  const creds = clientCreds();
  if (creds) throw new Error('Cal.com Platform provisions managed users server-side — no browser OAuth. Wire provisionManagedUser() per tenant, or set CAL_COM_API_KEY for API-key mode.');
  throw new Error('Cal.com mesh node is not configured: set CAL_COM_CLIENT_ID + CAL_COM_CLIENT_SECRET (Platform) or CAL_COM_API_KEY (API-key mode) in Vercel.');
}

// Kept for adapter-contract parity; the OAuth callback never reaches it
// because getAuthUrl() already threw.
export async function exchangeCode(){
  return { ok: false, error: 'Cal.com Platform has no browser OAuth code flow — use server-side managed-user provisioning (provisionManagedUser) or API-key mode.' };
}

/** Refresh a managed user's tokens. Returns {ok:false,error} gracefully when unconfigured. */
export async function refreshToken(refresh_token, { managed_user_id = null } = {}){
  const creds = clientCreds();
  if (!creds) return { ok: false, error: 'CAL_COM_CLIENT_ID/CAL_COM_CLIENT_SECRET not configured' };
  const body = { refreshToken: refresh_token };
  if (managed_user_id) body.managedUserId = managed_user_id;
  const r = await fetch(`${API_BASE}/oauth/${creds.id}/refresh`, {
    method: 'POST', headers: headers(null, { platform: true }), body: JSON.stringify(body)
  });
  const data = await parse(r, 'token refresh');
  return {
    ok: true,
    access_token: data.accessToken || data.access_token,
    refresh_token: data.refreshToken || data.refresh_token,
    expires_at: data.expiresAt || data.expires_at || null,
    raw: data
  };
}

/**
 * White-label provisioning: create a managed Cal.com user for a tenant using
 * the platform OAuth client credentials. Persist the returned tokens in the
 * integration row (access tokens last 60 min, refresh 1 year).
 */
export async function provisionManagedUser({ email, name, timeZone = DEFAULT_TZ } = {}){
  const creds = clientCreds();
  if (!creds) throw new Error('Cal.com Platform provisioning requires CAL_COM_CLIENT_ID + CAL_COM_CLIENT_SECRET');
  if (!email) throw new Error('provisionManagedUser requires an email');
  const r = await fetch(`${API_BASE}/oauth/${creds.id}/authorize`, {
    method: 'POST',
    headers: headers(null, { platform: true }),
    body: JSON.stringify({ email, name: name || email.split('@')[0] || 'Salon', timeZone })
  });
  const data = await parse(r, 'managed-user provisioning');
  return {
    ok: true,
    access_token: data.accessToken || data.access_token,
    refresh_token: data.refreshToken || data.refresh_token,
    managed_user_id: data.managedUserId || data.managed_user_id || data.id || null,
    email: data.email || email,
    raw: data
  };
}

/** List the connected account's event types (Lola service <-> Cal event type mesh). */
export async function listEventTypes(integration){
  const r = await fetch(`${API_BASE}/event-types`, { headers: headers(integration) });
  const data = await parse(r, 'event-types');
  return (data || []).map(e => ({
    id: e.id,
    slug: e.slug,
    title: e.title,
    length_in_minutes: e.lengthInMinutes || e.lengthInMinutesOptions?.[0] || 30
  }));
}

/** Create a Cal.com event type for a Lola service. */
export async function createEventType(integration, { title, slug, lengthInMinutes = 30, description = '' } = {}){
  if (!title) throw new Error('createEventType requires a title');
  const r = await fetch(`${API_BASE}/event-types`, {
    method: 'POST',
    headers: headers(integration),
    body: JSON.stringify({
      title, slug: slug || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
      lengthInMinutes, description,
      locations: [{ type: 'address', address: 'In-salon appointment', public: true }],
      bookingFields: [{ type: 'name', label: 'Your name' }, { type: 'email', label: 'Email address' }]
    })
  });
  const data = await parse(r, 'event-type create');
  return { id: data.id, slug: data.slug, title: data.title, length_in_minutes: data.lengthInMinutes };
}

/**
 * Check open slots for an event type. Flattens Cal's
 * {slots: {'2026-09-01': [{time, attendees}]}} into a simple time list.
 */
export async function getAvailability(integration, { eventTypeId, from, to, timeZone = DEFAULT_TZ } = {}){
  if (!eventTypeId) throw new Error('getAvailability requires eventTypeId');
  const q = new URLSearchParams({ eventTypeId: String(eventTypeId), startTime: from, endTime: to, timeZone });
  const r = await fetch(`${API_BASE}/slots/available?${q}`, { headers: headers(integration) });
  const data = await parse(r, 'slots');
  const slots = data?.slots || data;
  const out = [];
  if (Array.isArray(slots)){ for (const s of slots){ if (s?.time) out.push({ time: s.time, eventTypeId }); } }
  else if (slots && typeof slots === 'object'){
    for (const day of Object.values(slots)){
      for (const s of day || []) if (s?.time) out.push({ time: s.time, eventTypeId });
    }
  }
  return out.sort((a, b) => new Date(a.time) - new Date(b.time));
}

/** Read appointments across a date range into the mesh's normalized shape. */
export async function listAppointments(integration, { from, to } = {}){
  const token = bearerToken(integration);
  if (!token) throw new Error('Cal.com mesh node is not configured: set CAL_COM_API_KEY or CAL_COM_CLIENT_ID/CAL_COM_CLIENT_SECRET + a per-tenant managed-user token.');
  const q = new URLSearchParams({ take: '250' });
  if (from) q.set('afterStart', from);
  if (to) q.set('beforeEnd', to);
  const r = await fetch(`${API_BASE}/bookings?${q}`, { headers: headers(integration) });
  const data = await parse(r, 'bookings');
  const bookings = Array.isArray(data) ? data : (data?.bookings || []);
  return bookings.map(normalizeBooking);
}

/** Book an appointment on a Cal.com event type. */
export async function createAppointment(integration, appt){
  const token = bearerToken(integration);
  if (!token) throw new Error('Cal.com mesh node is not configured: set CAL_COM_API_KEY or CAL_COM_CLIENT_ID/CAL_COM_CLIENT_SECRET + a per-tenant managed-user token.');
  const eventTypeId = appt.event_type_id || appt.eventTypeId || appt.event_type;
  if (!eventTypeId) throw new Error('Cal.com createAppointment requires event_type_id (map the Lola service to a Cal.com event type via provider_mappings)');
  if (!appt.starts_at) throw new Error('Cal.com createAppointment requires starts_at');
  const client = appt.client || {};
  const email = client.email || (client.phone ? `${String(client.phone).replace(/\D/g, '')}@guest.loladesk.com` : 'guest@loladesk.com');
  const attendee = { name: client.name || 'Guest', email, timeZone: appt.timezone || DEFAULT_TZ };
  if (client.phone) attendee.phone = client.phone;
  const body = {
    eventTypeId: Number(eventTypeId),
    start: appt.starts_at,
    attendee,
    location: { type: 'phone' },
    metadata: { source: 'loladesk', ...(appt.metadata || {}) }
  };
  const r = await fetch(`${API_BASE}/bookings`, {
    method: 'POST', headers: headers(integration), body: JSON.stringify(body)
  });
  const data = await parse(r, 'booking create');
  return normalizeBooking(data);
}

/**
 * The Cal.com public API v2 has no customers endpoint, so the client list is
 * derived from booking attendees (same mesh shape as listClients elsewhere).
 */
export async function listClients(integration, { limit = 250 } = {}){
  const token = bearerToken(integration);
  if (!token) throw new Error('Cal.com mesh node is not configured: set CAL_COM_API_KEY or CAL_COM_CLIENT_ID/CAL_COM_CLIENT_SECRET + a per-tenant managed-user token.');
  const q = new URLSearchParams({ take: String(limit) });
  const r = await fetch(`${API_BASE}/bookings?${q}`, { headers: headers(integration) });
  const data = await parse(r, 'bookings');
  const bookings = Array.isArray(data) ? data : (data?.bookings || []);
  const seen = new Map();
  for (const b of bookings){
    for (const a of b.attendees || []){
      const key = a.email || a.name || 'guest';
      if (!seen.has(key)) seen.set(key, { id: a.email || key, name: a.name || 'Unknown', email: a.email || null, phone: a.phone || null });
    }
  }
  return [...seen.values()];
}
