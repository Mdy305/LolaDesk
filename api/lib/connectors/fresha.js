/**
 * Fresha connector — same shape as square.js.
 *
 * Fresha's partner API is invite-only (partners@fresha.com); until credentials
 * exist this connector reports status 'beta' so Settings shows it honestly as
 * "coming soon" rather than a Connect button that dead-ends. Once Fresha grants
 * a client id/secret, set FRESHA_CLIENT_ID / FRESHA_CLIENT_SECRET (and
 * FRESHA_API_BASE / FRESHA_AUTH_BASE if their staging URLs differ) and it goes
 * live — no code changes, exactly like the other connectors.
 */
export const META = {
  name: 'Fresha',
  description: 'Appointments and clients from Fresha (global).',
  status: process.env.FRESHA_CLIENT_ID ? 'available' : 'beta',
  docs: 'https://www.fresha.com/for-business'
};

const AUTH_BASE = process.env.FRESHA_AUTH_BASE || 'https://api.fresha.com/oauth';
const API_BASE  = process.env.FRESHA_API_BASE  || 'https://api.fresha.com/v1';

function redirectUri(){
  return `${process.env.APP_URL || 'https://www.loladesk.com'}/api/oauth/callback?provider=fresha`;
}

export function getAuthUrl(state){
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.FRESHA_CLIENT_ID || '',
    redirect_uri: redirectUri(),
    scope: 'appointments:read appointments:write clients:read clients:write',
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
      client_id: process.env.FRESHA_CLIENT_ID || '',
      client_secret: process.env.FRESHA_CLIENT_SECRET || '',
      redirect_uri: redirectUri()
    })
  });
  const data = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error(data.error_description || data.error || 'Fresha OAuth failed');
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_at: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null,
    merchant_id: data.location_id || null,
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
      client_id: process.env.FRESHA_CLIENT_ID || '',
      client_secret: process.env.FRESHA_CLIENT_SECRET || ''
    })
  });
  return r.json();
}

function authHeaders(i){
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${i.access_token}` };
}

function normalize(a){
  const start = a.starts_at || a.start_time || a.startTime;
  const end   = a.ends_at   || a.end_time   || a.endTime;
  const dur = end && start ? Math.round((new Date(end) - new Date(start)) / 60000) : (a.duration || 60);
  return {
    id: String(a.id || ''),
    starts_at: start,
    ends_at: end || new Date(new Date(start).getTime() + dur * 60000).toISOString(),
    duration_min: dur,
    client: { name: a.client?.name || [a.client?.first_name, a.client?.last_name].filter(Boolean).join(' ') || 'Walk-in' },
    service: a.service?.name || a.service_name || 'Service',
    stylist: a.employee?.name || a.staff_name || null,
    status: String(a.status || 'confirmed').toLowerCase(),
    raw: a
  };
}

export async function listAppointments(integration, { from, to } = {}){
  const start = from || new Date(Date.now() - 7 * 864e5).toISOString();
  const end   = to   || new Date(Date.now() + 30 * 864e5).toISOString();
  const r = await fetch(`${API_BASE}/appointments?from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}`, { headers: authHeaders(integration) });
  const data = await r.json().catch(() => ({}));
  if(!r.ok) return [];
  const rows = data.appointments || data.data || [];
  return rows.map(normalize);
}

export async function createAppointment(integration, appt){
  const r = await fetch(`${API_BASE}/appointments`, {
    method: 'POST',
    headers: authHeaders(integration),
    body: JSON.stringify({
      starts_at: appt.starts_at,
      duration: appt.duration_min || 60,
      client_id: appt.customer_id || undefined,
      client_name: appt.client_name || undefined,
      client_phone: appt.client_phone || undefined,
      service_id: appt.service_id || undefined,
      employee_id: appt.team_member_id || undefined,
      notes: appt.notes || 'Booked by Lola (LolaDesk AI front desk)'
    })
  });
  const data = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error(data.message || data.error || 'Fresha create failed');
  return normalize(data.appointment || data);
}

export async function listClients(integration, { limit = 100 } = {}){
  const r = await fetch(`${API_BASE}/clients?per_page=${limit}`, { headers: authHeaders(integration) });
  const data = await r.json().catch(() => ({}));
  if(!r.ok) return [];
  const rows = data.clients || data.data || [];
  return rows.map(c => ({
    id: String(c.id || ''),
    name: c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Unknown',
    phone: c.phone || c.mobile || null,
    email: c.email || null,
    raw: c
  }));
}
