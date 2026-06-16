export const META = { name:'Google Calendar', description:'Two-way sync of bookings with your Google Calendar.', status:'available', docs:'https://developers.google.com/calendar/api/v3/reference' };
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export function getAuthUrl(state){
  const redirect = `${process.env.APP_URL || 'https://www.loladesk.com'}/api/oauth/callback?provider=google_calendar`;
  const params = new URLSearchParams({ client_id:process.env.GOOGLE_CLIENT_ID, redirect_uri:redirect, response_type:'code', scope:SCOPE, access_type:'offline', prompt:'consent', state });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}
export async function exchangeCode(code){
  const redirect = `${process.env.APP_URL || 'https://www.loladesk.com'}/api/oauth/callback?provider=google_calendar`;
  const r = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({ code, client_id:process.env.GOOGLE_CLIENT_ID, client_secret:process.env.GOOGLE_CLIENT_SECRET, redirect_uri:redirect, grant_type:'authorization_code' }) });
  const data = await r.json();
  if(!r.ok) throw new Error(data.error_description || 'Google OAuth failed');
  return { access_token:data.access_token, refresh_token:data.refresh_token, expires_at:new Date(Date.now()+(data.expires_in||3600)*1000).toISOString(), raw:data };
}
export async function refreshToken(refresh_token){
  const r = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({ client_id:process.env.GOOGLE_CLIENT_ID, client_secret:process.env.GOOGLE_CLIENT_SECRET, refresh_token, grant_type:'refresh_token' }) });
  const data = await r.json();
  if(!r.ok) throw new Error(data.error_description || 'Google refresh failed');
  return { access_token:data.access_token, expires_at:new Date(Date.now()+(data.expires_in||3600)*1000).toISOString() };
}
function authHeaders(i){ return { 'Content-Type':'application/json','Authorization':`Bearer ${i.access_token}` }; }
export async function listAppointments(integration, { from, to, calendarId='primary' } = {}){
  const timeMin = from || new Date(Date.now()-7*864e5).toISOString();
  const timeMax = to || new Date(Date.now()+30*864e5).toISOString();
  const params = new URLSearchParams({ timeMin, timeMax, singleEvents:'true', orderBy:'startTime', maxResults:'250' });
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`, { headers:authHeaders(integration) });
  const data = await r.json();
  if(!r.ok) return [];
  return (data.items||[]).map(normalize);
}
function normalize(ev){
  const s = ev.start?.dateTime || ev.start?.date;
  const e = ev.end?.dateTime || ev.end?.date;
  const dur = s && e ? Math.round((new Date(e)-new Date(s))/60000) : 60;
  return { id:ev.id, starts_at:s, ends_at:e, duration_min:dur, client:{name:ev.attendees?.[0]?.displayName||ev.attendees?.[0]?.email||'Calendar event'}, service:ev.summary||'Event', stylist:null, status:(ev.status||'confirmed').toLowerCase(), raw:ev };
}
export async function createAppointment(integration, appt){
  const calendarId = appt.calendarId || 'primary';
  const event = { summary:appt.service||appt.title||'LolaDesk booking', description:`${appt.client?.name||''}\n${appt.note||''}\nBooked by Lola.`, start:{ dateTime:appt.starts_at, timeZone:appt.timezone||'America/New_York' }, end:{ dateTime:appt.ends_at||new Date(new Date(appt.starts_at).getTime()+(appt.duration_min||60)*60000).toISOString(), timeZone:appt.timezone||'America/New_York' }, attendees:appt.client?.email?[{email:appt.client.email,displayName:appt.client.name}]:undefined };
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, { method:'POST', headers:authHeaders(integration), body: JSON.stringify(event) });
  const data = await r.json();
  if(!r.ok) throw new Error(data.error?.message || 'Google create failed');
  return normalize(data);
}
export async function listClients(){ return []; }
