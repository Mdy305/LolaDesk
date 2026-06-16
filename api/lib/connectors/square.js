export const META = { name:'Square', description:'Bookings, payments, and customers from Square.', status:'available', docs:'https://developer.squareup.com/reference/square' };
const ENV = (process.env.SQUARE_ENV || 'sandbox').toLowerCase();
const API_BASE = ENV === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';
const SCOPES = ['APPOINTMENTS_READ','APPOINTMENTS_WRITE','CUSTOMERS_READ','CUSTOMERS_WRITE','ITEMS_READ','MERCHANT_PROFILE_READ'].join('+');
export function getAuthUrl(state){
  const redirect = `${process.env.APP_URL || 'https://www.loladesk.com'}/api/oauth/callback?provider=square`;
  return `${API_BASE}/oauth2/authorize?client_id=${process.env.SQUARE_APP_ID}&scope=${SCOPES}&session=false&state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirect)}`;
}
export async function exchangeCode(code){
  const r = await fetch(`${API_BASE}/oauth2/token`, { method:'POST', headers:{'Content-Type':'application/json','Square-Version':'2024-12-18'}, body: JSON.stringify({ client_id:process.env.SQUARE_APP_ID, client_secret:process.env.SQUARE_APP_SECRET, code, grant_type:'authorization_code' }) });
  const data = await r.json();
  if(!r.ok) throw new Error(data.errors?.[0]?.detail || 'Square OAuth failed');
  return { access_token:data.access_token, refresh_token:data.refresh_token, expires_at:data.expires_at, merchant_id:data.merchant_id, raw:data };
}
export async function refreshToken(refresh_token){
  const r = await fetch(`${API_BASE}/oauth2/token`, { method:'POST', headers:{'Content-Type':'application/json','Square-Version':'2024-12-18'}, body: JSON.stringify({ client_id:process.env.SQUARE_APP_ID, client_secret:process.env.SQUARE_APP_SECRET, refresh_token, grant_type:'refresh_token' }) });
  return r.json();
}
function authHeaders(i){ return { 'Content-Type':'application/json','Square-Version':'2024-12-18','Authorization':`Bearer ${i.access_token}` }; }
export async function listAppointments(integration, { from, to } = {}){
  const start = from || new Date(Date.now()-7*864e5).toISOString();
  const end = to || new Date(Date.now()+30*864e5).toISOString();
  const locRes = await fetch(`${API_BASE}/v2/locations`, { headers:authHeaders(integration) });
  const locId = (await locRes.json()).locations?.[0]?.id;
  if(!locId) return [];
  const r = await fetch(`${API_BASE}/v2/bookings/search`, { method:'POST', headers:authHeaders(integration), body: JSON.stringify({ query:{ filter:{ location_id:locId, start_at_range:{ start_at:start, end_at:end } } } }) });
  const data = await r.json();
  if(!r.ok) return [];
  return (data.bookings||[]).map(normalize);
}
function normalize(b){
  const seg = (b.appointment_segments||[])[0]||{};
  const dur = seg.duration_minutes||60;
  return { id:b.id, starts_at:b.start_at, ends_at:new Date(new Date(b.start_at).getTime()+dur*60000).toISOString(), duration_min:dur, client:{name:b.customer_id?`Customer ${b.customer_id.slice(0,6)}`:'Walk-in'}, service:'Service', stylist:seg.team_member_id||null, status:(b.status||'confirmed').toLowerCase(), raw:b };
}
export async function createAppointment(integration, appt){
  const locRes = await fetch(`${API_BASE}/v2/locations`, { headers:authHeaders(integration) });
  const locId = (await locRes.json()).locations?.[0]?.id;
  if(!locId) throw new Error('No Square location');
  const r = await fetch(`${API_BASE}/v2/bookings`, { method:'POST', headers:authHeaders(integration), body: JSON.stringify({ idempotency_key:`lola-${Date.now()}`, booking:{ start_at:appt.starts_at, location_id:locId, customer_id:appt.customer_id, appointment_segments:[{ duration_minutes:appt.duration_min||60, service_variation_id:appt.service_variation_id, team_member_id:appt.team_member_id, service_variation_version:1 }] } }) });
  const data = await r.json();
  if(!r.ok) throw new Error(data.errors?.[0]?.detail || 'Square create failed');
  return normalize(data.booking);
}
export async function listClients(integration, { limit=100 } = {}){
  const r = await fetch(`${API_BASE}/v2/customers?limit=${limit}`, { headers:authHeaders(integration) });
  const data = await r.json();
  if(!r.ok) return [];
  return (data.customers||[]).map(c => ({ id:c.id, name:[c.given_name,c.family_name].filter(Boolean).join(' ')||'Unknown', phone:c.phone_number||null, email:c.email_address||null, raw:c }));
}
