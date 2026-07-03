/**
 * Mindbody connector — same shape as square.js.
 *
 * Mindbody's Public API v6 authenticates with an Api-Key header plus a
 * staff OAuth bearer token from Mindbody Identity (signin.mindbodyonline.com),
 * scoped to a studio via a SiteId header. That SiteId is captured at connect
 * time (?siteId= on the connect link, or MINDBODY_SITE_ID as a default) and
 * stored in the integration's metadata alongside the encrypted tokens.
 *
 * Env: MINDBODY_CLIENT_ID, MINDBODY_CLIENT_SECRET, MINDBODY_API_KEY,
 *      MINDBODY_SITE_ID (optional default site).
 */
export const META = {
  name: 'Mindbody',
  description: 'Appointments and clients from Mindbody.',
  status: process.env.MINDBODY_API_KEY ? 'available' : 'beta',
  docs: 'https://developers.mindbodyonline.com'
};

const IDENTITY = process.env.MINDBODY_IDENTITY_BASE || 'https://signin.mindbodyonline.com';
const API_BASE = process.env.MINDBODY_API_BASE || 'https://api.mindbodyonline.com/public/v6';

function redirectUri(){
  return `${process.env.APP_URL || 'https://www.loladesk.com'}/api/oauth/callback?provider=mindbody`;
}

export function getAuthUrl(state){
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.MINDBODY_CLIENT_ID || '',
    redirect_uri: redirectUri(),
    scope: 'email profile openid offline_access Platform.Contracts.Api.Read Platform.Contracts.Api.Write',
    state,
    nonce: String(Date.now())
  });
  return `${IDENTITY}/connect/authorize?${p}`;
}

export async function exchangeCode(code){
  const r = await fetch(`${IDENTITY}/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.MINDBODY_CLIENT_ID || '',
      client_secret: process.env.MINDBODY_CLIENT_SECRET || '',
      redirect_uri: redirectUri()
    })
  });
  const data = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error(data.error_description || data.error || 'Mindbody OAuth failed');
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_at: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null,
    merchant_id: null,
    raw: data
  };
}

export async function refreshToken(refresh_token){
  const r = await fetch(`${IDENTITY}/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token,
      client_id: process.env.MINDBODY_CLIENT_ID || '',
      client_secret: process.env.MINDBODY_CLIENT_SECRET || ''
    })
  });
  return r.json();
}

function siteId(i){
  return i?.metadata?.site_id || i?.metadata?.siteId || process.env.MINDBODY_SITE_ID || '-99'; // -99 = Mindbody sandbox site
}

function authHeaders(i){
  return {
    'Content-Type': 'application/json',
    'Api-Key': process.env.MINDBODY_API_KEY || '',
    'SiteId': String(siteId(i)),
    'Authorization': `Bearer ${i.access_token}`
  };
}

function normalize(a){
  const start = a.StartDateTime;
  const end = a.EndDateTime;
  const dur = end && start ? Math.round((new Date(end) - new Date(start)) / 60000) : (a.Duration || 60);
  return {
    id: String(a.Id || ''),
    starts_at: start,
    ends_at: end || new Date(new Date(start).getTime() + dur * 60000).toISOString(),
    duration_min: dur,
    client: { name: a.Client ? [a.Client.FirstName, a.Client.LastName].filter(Boolean).join(' ') : (a.ClientId ? `Client ${a.ClientId}` : 'Walk-in') },
    service: a.SessionType?.Name || a.SessionTypeName || 'Service',
    stylist: a.Staff ? [a.Staff.FirstName, a.Staff.LastName].filter(Boolean).join(' ') : (a.StaffId ? String(a.StaffId) : null),
    status: String(a.Status || 'confirmed').toLowerCase(),
    raw: a
  };
}

export async function listAppointments(integration, { from, to } = {}){
  const start = (from || new Date(Date.now() - 7 * 864e5).toISOString()).slice(0, 19);
  const end   = (to   || new Date(Date.now() + 30 * 864e5).toISOString()).slice(0, 19);
  const r = await fetch(`${API_BASE}/appointment/staffappointments?StartDate=${encodeURIComponent(start)}&EndDate=${encodeURIComponent(end)}&limit=200`, { headers: authHeaders(integration) });
  const data = await r.json().catch(() => ({}));
  if(!r.ok) return [];
  return (data.Appointments || []).map(normalize);
}

export async function createAppointment(integration, appt){
  const r = await fetch(`${API_BASE}/appointment/addappointment`, {
    method: 'POST',
    headers: authHeaders(integration),
    body: JSON.stringify({
      ClientId: appt.customer_id || undefined,
      StaffId: appt.team_member_id ? Number(appt.team_member_id) : undefined,
      SessionTypeId: appt.service_id ? Number(appt.service_id) : undefined,
      LocationId: appt.location_id ? Number(appt.location_id) : 1,
      StartDateTime: appt.starts_at,
      Duration: appt.duration_min || 60,
      Notes: appt.notes || 'Booked by Lola (LolaDesk AI front desk)',
      Test: false
    })
  });
  const data = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error(data.Error?.Message || data.Message || 'Mindbody create failed');
  return normalize(data.Appointment || data);
}

export async function listClients(integration, { limit = 100 } = {}){
  const r = await fetch(`${API_BASE}/client/clients?limit=${limit}`, { headers: authHeaders(integration) });
  const data = await r.json().catch(() => ({}));
  if(!r.ok) return [];
  return (data.Clients || []).map(c => ({
    id: String(c.Id || c.UniqueId || ''),
    name: [c.FirstName, c.LastName].filter(Boolean).join(' ') || 'Unknown',
    phone: c.MobilePhone || c.HomePhone || null,
    email: c.Email || null,
    raw: c
  }));
}
