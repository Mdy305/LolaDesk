/**
 * Vagaro connector — same shape as square.js so aggregator.js,
 * oauth/connect.js, oauth/callback.js, and lola-tools.js need zero changes.
 *
 * Vagaro's merchant API is partner-gated (apply at developer.vagaro.com).
 * Once approved you get an OAuth2 client id/secret; set VAGARO_CLIENT_ID /
 * VAGARO_CLIENT_SECRET and this connector goes live with no code changes.
 * VAGARO_API_BASE / VAGARO_AUTH_BASE exist so a sandbox tenant can point
 * at Vagaro's staging environment without a redeploy.
 */
export const META = {
  name: 'Vagaro',
  description: 'Appointments and clients from Vagaro.',
  status: process.env.VAGARO_CLIENT_ID ? 'available' : 'beta',
  docs: 'https://developer.vagaro.com'
};

const AUTH_BASE = process.env.VAGARO_AUTH_BASE || 'https://api.vagaro.com/v2/oauth';
const API_BASE  = process.env.VAGARO_API_BASE  || 'https://api.vagaro.com/v2';
const SCOPES = ['appointments.read','appointments.write','customers.read','customers.write'].join(' ');

function redirectUri(){
  return `${process.env.APP_URL || 'https://www.loladesk.com'}/api/oauth/callback?provider=vagaro`;
}

export function getAuthUrl(state){
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.VAGARO_CLIENT_ID || '',
    redirect_uri: redirectUri(),
    scope: SCOPES,
    state
  });
  return `${AUTH_BASE}/authorize?${p}`;
}

export async function exchangeCode(code){
  const r = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.VAGARO_CLIENT_ID || '',
      client_secret: process.env.VAGARO_CLIENT_SECRET || '',
      redirect_uri: redirectUri()
    })
  });
  const data = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error(data.error_description || data.error || 'Vagaro OAuth failed');
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_at: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null,
    merchant_id: data.business_id || null,
    raw: data
  };
}

export async function refreshToken(refresh_token){
  const r = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token,
      client_id: process.env.VAGARO_CLIENT_ID || '',
      client_secret: process.env.VAGARO_CLIENT_SECRET || ''
    })
  });
  return r.json();
}

function authHeaders(i){
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${i.access_token}` };
}

function normalize(a){
  const start = a.startDateTime || a.start_at || a.startTime;
  const end   = a.endDateTime   || a.end_at   || a.endTime;
  const dur = end && start ? Math.round((new Date(end) - new Date(start)) / 60000) : (a.duration || 60);
  return {
    id: String(a.id || a.appointmentId || ''),
    starts_at: start,
    ends_at: end || new Date(new Date(start).getTime() + dur * 60000).toISOString(),
    duration_min: dur,
    client: { name: a.customerName || [a.customerFirstName, a.customerLastName].filter(Boolean).join(' ') || 'Walk-in' },
    service: a.serviceTitle || a.serviceName || 'Service',
    stylist: a.serviceProviderName || a.employeeName || null,
    status: String(a.status || 'confirmed').toLowerCase(),
    raw: a
  };
}

export async function listAppointments(integration, { from, to } = {}){
  const start = from || new Date(Date.now() - 7 * 864e5).toISOString();
  const end   = to   || new Date(Date.now() + 30 * 864e5).toISOString();
  const r = await fetch(`${API_BASE}/appointments?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}`, { headers: authHeaders(integration) });
  const data = await r.json().catch(() => ({}));
  if(!r.ok) return [];
  const rows = data.appointments || data.data || data.items || [];
  return rows.map(normalize);
}

export async function createAppointment(integration, appt){
  const r = await fetch(`${API_BASE}/appointments`, {
    method: 'POST',
    headers: authHeaders(integration),
    body: JSON.stringify({
      startDateTime: appt.starts_at,
      duration: appt.duration_min || 60,
      customerId: appt.customer_id || undefined,
      customerName: appt.client_name || undefined,
      customerPhone: appt.client_phone || undefined,
      serviceId: appt.service_id || undefined,
      serviceProviderId: appt.team_member_id || undefined,
      notes: appt.notes || 'Booked by Lola (LolaDesk AI front desk)'
    })
  });
  const data = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error(data.message || data.error || 'Vagaro create failed');
  return normalize(data.appointment || data);
}

export async function listClients(integration, { limit = 100 } = {}){
  const r = await fetch(`${API_BASE}/customers?pageSize=${limit}`, { headers: authHeaders(integration) });
  const data = await r.json().catch(() => ({}));
  if(!r.ok) return [];
  const rows = data.customers || data.data || data.items || [];
  return rows.map(c => ({
    id: String(c.id || c.customerId || ''),
    name: c.name || [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unknown',
    phone: c.mobilePhone || c.phone || null,
    email: c.email || null,
    raw: c
  }));
}
