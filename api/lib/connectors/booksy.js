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
 * Apply at https://docs.booksy.com/ — once approved set:
 *   BOOKSY_PRIVATE_KEY  (PEM private key)
 *   BOOKSY_PARTNER_ID   (the partner/client id, used as JWT iss + sub)
 *   BOOKSY_KEY_ID       (optional — JWT `kid` header)
 * and this connector goes live with no further code changes. BOOKSY_API_BASE /
 * BOOKSY_TOKEN_URL exist so a sandbox partner can point at staging.
 */

import crypto from 'crypto';

export const META = {
  name: 'Booksy',
  description: 'Appointments, clients, services, and staff from Booksy.',
  status: process.env.BOOKSY_PRIVATE_KEY && process.env.BOOKSY_PARTNER_ID ? 'available' : 'beta',
  docs: 'https://docs.booksy.com/'
};

const API_BASE   = process.env.BOOKSY_API_BASE  || 'https://us.booksy.com/public-api/us/';
const TOKEN_URL  = process.env.BOOKSY_TOKEN_URL || 'https://us.booksy.com/public-api/token/';
const ACCEPT     = 'application/json; version=0.3';
const JWT_TTL_S  = 300; // assertion is short-lived; the access token lasts 5 minutes

function base64url(input){
  return Buffer.from(input).toString('base64url');
}

/**
 * Sign an RS256 JWT assertion with the partner private key. Booksy validates
 * the signature against the partner's registered public key.
 */
export function signAssertion(claims, privateKeyPem, keyId){
  const header = { alg: 'RS256', typ: 'JWT' };
  if(keyId) header.kid = keyId;
  const h = base64url(JSON.stringify(header));
  const p = base64url(JSON.stringify(claims));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${h}.${p}`);
  signer.end();
  const sig = signer.sign(privateKeyPem).toString('base64url');
  return `${h}.${p}.${sig}`;
}

/**
 * Exchange a signed JWT assertion for an access token. Booksy does not use
 * user-consent OAuth, so this is the connector's whole "auth" — there is no
 * redirect URL to visit.
 */
export async function getAccessToken(){
  const privateKey = process.env.BOOKSY_PRIVATE_KEY;
  const partnerId  = process.env.BOOKSY_PARTNER_ID;
  if(!privateKey || !partnerId){
    throw new Error('Booksy is partner-gated — set BOOKSY_PRIVATE_KEY + BOOKSY_PARTNER_ID');
  }
  const now = Math.floor(Date.now() / 1000);
  const assertion = signAssertion(
    { iss: partnerId, sub: partnerId, aud: TOKEN_URL, iat: now, exp: now + JWT_TTL_S, jti: crypto.randomUUID() },
    privateKey,
    process.env.BOOKSY_KEY_ID || undefined
  );
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_assertion: assertion, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' })
  });
  const data = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error(data.error_description || data.error || `Booksy token exchange failed (${r.status})`);
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_at: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : new Date(Date.now() + JWT_TTL_S * 1000).toISOString(),
    merchant_id: data.business_id || null,
    raw: data
  };
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

function authHeaders(i){
  return { Accept: ACCEPT, 'Content-Type': 'application/json', Authorization: `Bearer ${i.access_token}` };
}

function asList(data){
  return data?.appointments || data?.customers || data?.data || data?.items || data?.results || data || [];
}

function normalize(a){
  const start = a.starts_at || a.start_at || a.startDateTime || a.start_time || a.start;
  const end   = a.ends_at   || a.end_at   || a.endDateTime   || a.end_time   || a.end;
  const dur = end && start ? Math.round((new Date(end) - new Date(start)) / 60000) : (a.duration_minutes || a.duration || 60);
  return {
    id: String(a.id || a.appointment_id || ''),
    starts_at: start,
    ends_at: end || (start ? new Date(new Date(start).getTime() + dur * 60000).toISOString() : null),
    duration_min: dur,
    client: { name: a.customer_name || [a.customer_first_name, a.customer_last_name].filter(Boolean).join(' ') || 'Walk-in' },
    service: a.service_name || a.service_title || 'Service',
    stylist: a.resource_name || a.staff_name || a.employee_name || null,
    status: String(a.status || 'confirmed').toLowerCase(),
    raw: a
  };
}

export async function listAppointments(integration, { from, to } = {}){
  const start = from || new Date(Date.now() - 7 * 864e5).toISOString();
  const end   = to   || new Date(Date.now() + 30 * 864e5).toISOString();
  const r = await fetch(`${API_BASE}appointments?starts_at=${encodeURIComponent(start)}&ends_at=${encodeURIComponent(end)}`, { headers: authHeaders(integration) });
  const data = await r.json().catch(() => ({}));
  if(!r.ok) return [];
  return asList(data).map(normalize);
}

export async function createAppointment(integration, appt){
  const r = await fetch(`${API_BASE}appointments`, {
    method: 'POST',
    headers: authHeaders(integration),
    body: JSON.stringify({
      starts_at: appt.starts_at,
      duration_minutes: appt.duration_min || 60,
      customer_id: appt.customer_id || undefined,
      customer_name: appt.client_name || undefined,
      customer_phone: appt.client_phone || undefined,
      service_id: appt.service_id || undefined,
      resource_id: appt.team_member_id || undefined,
      notes: appt.notes || 'Booked by Lola (LolaDesk AI front desk)'
    })
  });
  const data = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error(data.message || data.error || data.detail || 'Booksy create failed');
  return normalize(data.appointment || data);
}

export async function listClients(integration, { limit = 100 } = {}){
  const r = await fetch(`${API_BASE}customers?limit=${limit}`, { headers: authHeaders(integration) });
  const data = await r.json().catch(() => ({}));
  if(!r.ok) return [];
  return asList(data).map(c => ({
    id: String(c.id || c.customer_id || ''),
    name: c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Unknown',
    phone: c.phone || c.mobile || null,
    email: c.email || null,
    raw: c
  }));
}
