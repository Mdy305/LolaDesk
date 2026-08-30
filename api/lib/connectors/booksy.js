/**
 * Booksy connector — same contract as square.js / vagaro.js so aggregator.js,
 * booking-sync.js, integration-health.js and lola-tools.js need zero changes.
 *
 * Booksy's Public API is partner-gated and uses a DIFFERENT auth model than
 * the other connectors: there is no browser OAuth consent screen. Partners
 * hold an RSA key pair, sign a short-lived RS256 JWT assertion, and exchange
 * it at /token/ for a 5-minute access token + 3-day refresh token. All API
 * calls carry `Accept: application/json; version=0.3`.
 *
 * Because the partner credential is PLATFORM-level (shared across every
 * Booksy tenant), the per-tenant `integrations` row carries no OAuth token —
 * it only stores the tenant's Booksy business id in metadata.business_id. The
 * connector mints a fresh access token from BOOKSY_PRIVATE_KEY when needed and
 * scopes every call to /business/<business_id>/… for that tenant.
 *
 * Apply at https://docs.booksy.com/ — once approved set:
 *   BOOKSY_PRIVATE_KEY   (PEM private key, separate keys for sandbox + prod)
 *   BOOKSY_PARTNER_ID    (the partner UUID, used as the JWT `aud`)
 *   BOOKSY_PARTNER_NAME  (partner name, sent with the token exchange)
 *   BOOKSY_KEY_ID        (optional — JWT `kid` header)
 * and this connector goes live with no further code changes. BOOKSY_API_BASE /
 * BOOKSY_TOKEN_URL exist so a sandbox partner can point at staging.
 *
 * Auth reference (Booksy Public API):
 *   • JWT claims: iss=https://public-api.booksy.com, aud=<partner UUID>,
 *     iat, exp; JOSE header { typ: JWT, alg: RS256 }.
 *   • Exchange: POST {base}/token/ with { assertion, partner_name }.
 *   • Data paths: /business/<business_id>/appointment/ and
 *     /business/<business_id>/customer/, paginated with offset/limit and
 *     filtered by booked_from / booked_till.
 */

import crypto from 'crypto';

export const META = {
  name: 'Booksy',
  description: 'Appointments, clients, services, and staff from Booksy.',
  status: process.env.BOOKSY_PRIVATE_KEY && process.env.BOOKSY_PARTNER_ID ? 'available' : 'beta',
  docs: 'https://docs.booksy.com/'
};

const API_BASE   = process.env.BOOKSY_API_BASE  || 'https://us.booksy.com/public-api/us/';
const TOKEN_URL  = process.env.BOOKSY_TOKEN_URL || 'https://us.booksy.com/public-api/us/token/';
const ACCEPT     = 'application/json; version=0.3';
const ISSUER     = 'https://public-api.booksy.com';
const JWT_TTL_S  = 300;          // assertion is short-lived; access token lasts 5 minutes
const PAGE_SIZE  = 200;          // offset/limit pagination page size
const MAX_PAGES  = 10;           // safety bound so a runaway calendar can't stall the cron

// ── token cache (per serverless invocation) ────────────────────────────
// The access token is valid ~5 minutes. The sync cron touches every tenant on
// each tick, so minting a fresh assertion per tenant would hammer /token/ and
// burn rate limit (200/min). Cache the minted token for the lifetime of the
// invocation; a cold start simply mints again.
let _tokenCache = null; // { access_token, expires_at }

function base64url(input){
  return Buffer.from(input).toString('base64url');
}

/**
 * Sign an RS256 JWT assertion with the partner private key. Booksy validates
 * the signature against the partner's registered public key.
 */
export function signAssertion(claims, privateKeyPem, keyId){
  const header = { typ: 'JWT', alg: 'RS256' };
  if(keyId) header.kid = keyId;
  const h = base64url(JSON.stringify(header));
  const p = base64url(JSON.stringify(claims));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${h}.${p}`);
  signer.end();
  const sig = signer.sign(privateKeyPem).toString('base64url');
  return `${h}.${p}.${sig}`;
}

export function isTokenFresh(access_token, expires_at){
  if(!access_token) return false;
  if(!expires_at) return true;          // no expiry info → assume usable
  return new Date(expires_at).getTime() > Date.now() + 15000; // 15s safety margin
}

/**
 * Exchange a signed JWT assertion for an access token. Booksy does not use
 * user-consent OAuth, so this is the connector's whole "auth".
 */
export async function getAccessToken(){
  const privateKey  = process.env.BOOKSY_PRIVATE_KEY;
  const partnerId   = process.env.BOOKSY_PARTNER_ID;
  const partnerName = process.env.BOOKSY_PARTNER_NAME || '';
  if(!privateKey || !partnerId){
    throw new Error('Booksy is partner-gated — set BOOKSY_PRIVATE_KEY + BOOKSY_PARTNER_ID');
  }
  const now = Math.floor(Date.now() / 1000);
  const assertion = signAssertion(
    { iss: ISSUER, aud: partnerId, iat: now, exp: now + JWT_TTL_S, jti: crypto.randomUUID() },
    privateKey,
    process.env.BOOKSY_KEY_ID || undefined
  );
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ assertion, partner_name: partnerName })
  });
  const data = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error(data.error_description || data.detail || data.error || `Booksy token exchange failed (${r.status})`);
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_at: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : new Date(Date.now() + JWT_TTL_S * 1000).toISOString(),
    raw: data
  };
}

/**
 * Resolve a usable bearer token for an integration. Order:
 *   1. the tenant's own access_token (if one exists and is fresh)
 *   2. the in-memory cached platform token
 *   3. mint a fresh platform token and cache it
 */
export async function ensureAccessToken(integration){
  if(integration?.access_token && isTokenFresh(integration.access_token, integration.expires_at)){
    return integration.access_token;
  }
  if(_tokenCache && isTokenFresh(_tokenCache.access_token, _tokenCache.expires_at)){
    return _tokenCache.access_token;
  }
  const t = await getAccessToken();
  _tokenCache = { access_token: t.access_token, expires_at: t.expires_at };
  return _tokenCache.access_token;
}

/** The tenant's Booksy business id lives in the integration metadata. */
function businessId(integration){
  const m = integration?.metadata || {};
  const id = m.business_id || m.businessId || m.merchant_id || integration?.merchant_id;
  if(!id) throw new Error('Booksy integration is missing metadata.business_id');
  return String(id);
}

async function authHeaders(integration){
  const token = await ensureAccessToken(integration);
  return { Accept: ACCEPT, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

function asList(data){
  return data?.results || data?.appointments || data?.customers || data?.data || data?.items || data || [];
}

// Booksy appointment status is a single-character code (see data-model):
// A Accepted · C Cancelled · D Declined · F Finished · M Modified ·
// N No-show · P Proposed · W Waiting for confirmation.
const STATUS_MAP = { A:'booked', C:'cancelled', D:'cancelled', F:'completed', M:'booked', N:'no_show', P:'booked', W:'booked' };

function normalize(a){
  const sub = (Array.isArray(a.subbookings) && a.subbookings[0]) || {};
  const start = a.start_datetime || a.start || a.starts_at || a.start_time || sub.start_datetime || sub.start;
  const end   = a.end_datetime   || a.end   || a.ends_at   || a.end_time   || sub.end_datetime   || sub.end;
  const dur = end && start ? Math.round((new Date(end) - new Date(start)) / 60000) : (a.duration_minutes || sub.duration_minutes || a.duration || 60);
  const name = a.customer_name || a.booked_for_name || a.client_name ||
    [a.customer_first_name, a.customer_last_name].filter(Boolean).join(' ') || 'Walk-in';
  return {
    id: String(a.id || a.appointment_id || ''),
    starts_at: start,
    ends_at: end || (start ? new Date(new Date(start).getTime() + dur * 60000).toISOString() : null),
    duration_min: dur,
    client: { name },
    service: a.service_name || sub.service_variant_name || sub.service_name || 'Service',
    stylist: sub.staffer_id || sub.resource_id || a.resource_name || a.staff_name || null,
    status: STATUS_MAP[String(a.status || '').toUpperCase()] || String(a.status || 'booked').toLowerCase(),
    raw: a
  };
}

/** Fetch one page of a business-scoped collection. */
async function fetchPage(integration, path, params){
  const h = await authHeaders(integration);
  const r = await fetch(`${API_BASE}${path}?${params}`, { headers: h });
  const data = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error(data.detail || data.message || data.error || `${path} failed (${r.status})`);
  return data;
}

export async function listAppointments(integration, { from, to } = {}){
  const bid = businessId(integration);
  const base = `business/${bid}/appointment/`;
  const start = from || new Date(Date.now() - 7 * 864e5).toISOString();
  const end   = to   || new Date(Date.now() + 30 * 864e5).toISOString();

  const all = [];
  for(let page = 0; page < MAX_PAGES; page++){
    const params = new URLSearchParams({ offset: String(page * PAGE_SIZE), limit: String(PAGE_SIZE) });
    if(start) params.set('booked_from', start);
    if(end)   params.set('booked_till', end);
    const data = await fetchPage(integration, base, params);
    const rows = asList(data);
    all.push(...rows.map(normalize));
    if(rows.length < PAGE_SIZE) break;
  }
  return all;
}

export async function createAppointment(integration, appt){
  const bid = businessId(integration);
  const h = await authHeaders(integration);
  const r = await fetch(`${API_BASE}business/${bid}/appointment/`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({
      start_datetime: appt.starts_at,
      duration_minutes: appt.duration_min || 60,
      booked_for_id: appt.customer_id || undefined,
      customer_name: appt.client_name || undefined,
      customer_phone: appt.client_phone || undefined,
      service_variant_id: appt.service_id || undefined,
      staffer_id: appt.team_member_id || undefined,
      notes: appt.notes || 'Booked by Lola (LolaDesk AI front desk)'
    })
  });
  const data = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error(data.detail || data.message || data.error || 'Booksy create failed');
  return normalize(data.appointment || data);
}

export async function listClients(integration, { limit = 100 } = {}){
  const bid = businessId(integration);
  const params = new URLSearchParams({ offset: '0', limit: String(limit) });
  const data = await fetchPage(integration, `business/${bid}/customer/`, params);
  return asList(data).map(c => ({
    id: String(c.id || c.customer_id || ''),
    name: c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Unknown',
    phone: c.phone || c.mobile || c.phone_number || null,
    email: c.email || null,
    raw: c
  }));
}

/**
 * No browser OAuth for Booksy. Returning a URL here would send the tenant to
 * a broken consent screen, so this throws a descriptive error instead. The
 * settings page special-cases Booksy and links to the partner application.
 */
export function getAuthUrl(){
  throw new Error('Booksy uses partner JWT auth (no browser OAuth) — request access at https://docs.booksy.com/');
}

// exchangeCode is kept for contract parity; the OAuth callback never reaches
// it for Booksy because getAuthUrl() already threw.
export async function exchangeCode(){
  return getAccessToken();
}

export async function refreshToken(refresh_token){
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token })
  });
  return r.json();
}
