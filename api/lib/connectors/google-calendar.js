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

// Google access tokens live ~1h. Refresh with the stored refresh token when the
// token has expired (or is about to), persist the new one (encrypted, like
// upsertIntegration), and use it for this call.
export async function ensureFreshToken(integration, { now = Date.now(), refresh = refreshToken } = {}){
  if(!integration) return integration;
  const exp = integration.expires_at ? new Date(integration.expires_at).getTime() : NaN;
  if(!integration.refresh_token || (Number.isFinite(exp) && exp - 60e3 > now) || (!Number.isFinite(exp) && integration.access_token)) return integration;
  const fresh = await refresh(integration.refresh_token);
  integration.access_token = fresh.access_token;
  integration.expires_at = fresh.expires_at;
  if(integration.tenant_id){
    try{
      const [{ db }, { encrypt }] = await Promise.all([import('../db.js'), import('../crypto.js')]);
      const c = db();
      if(c) await c.from('integrations').update({ access_token: encrypt(fresh.access_token), expires_at: fresh.expires_at, status: 'connected' })
        .eq('tenant_id', integration.tenant_id).eq('provider', 'google_calendar');
    }catch(e){ console.warn('[google-calendar] token persist failed:', String(e?.message || e).slice(0, 120)); }
  }
  return integration;
}

// One Google call; non-2xx THROWS (an expired token or outage must never look
// like an empty calendar). A 401 refreshes once and retries.
async function gcal(integration, url, init = {}, { retried = false } = {}){
  await ensureFreshToken(integration);
  const r = await fetch(url, { ...init, headers: authHeaders(integration) });
  if(r.status === 401 && !retried && integration.refresh_token){
    integration.expires_at = new Date(0).toISOString();
    return gcal(integration, url, init, { retried: true });
  }
  if(r.status === 204) return {};
  const data = await r.json().catch(() => ({}));
  if(!r.ok){ const e = new Error(`Google Calendar ${r.status || ''}: ${data?.error?.message || 'request failed'}`.trim()); e.status = r.status; throw e; }
  return data || {};
}
const eventsUrl = (calendarId, rest = '') => `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId || 'primary')}/events${rest}`;

export async function listAppointments(integration, { from, to, calendarId='primary' } = {}){
  const timeMin = from || new Date(Date.now()-7*864e5).toISOString();
  const timeMax = to || new Date(Date.now()+30*864e5).toISOString();
  const items = [];
  let pageToken = null, pages = 0;
  do{
    const params = new URLSearchParams({ timeMin, timeMax, singleEvents:'true', orderBy:'startTime', maxResults:'250' });
    if(pageToken) params.set('pageToken', pageToken);
    const data = await gcal(integration, eventsUrl(calendarId, `?${params}`));
    items.push(...(data.items || []));
    pageToken = data.nextPageToken || null;
  }while(pageToken && ++pages < 20);
  return items.map(normalize);
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
  const data = await gcal(integration, eventsUrl(calendarId), { method:'POST', body: JSON.stringify(event) });
  return normalize(data);
}
export async function cancelAppointment(integration, { id, calendarId='primary' }){
  if(!id) throw new Error('Google Calendar cancel: missing event id');
  try{ await gcal(integration, eventsUrl(calendarId, `/${encodeURIComponent(id)}`), { method:'DELETE' }); }
  catch(e){ if(e.status === 410 || e.status === 404) return { id, status:'cancelled' }; throw e; }  // already gone
  return { id, status:'cancelled' };
}
export async function updateAppointment(integration, { id, starts_at, ends_at, duration_min, timezone, calendarId='primary' }){
  if(!id) throw new Error('Google Calendar update: missing event id');
  const end = ends_at || new Date(new Date(starts_at).getTime() + (duration_min || 60) * 60000).toISOString();
  const tz = timezone || 'America/New_York';
  const data = await gcal(integration, eventsUrl(calendarId, `/${encodeURIComponent(id)}`), { method:'PATCH', body: JSON.stringify({ start:{ dateTime: starts_at, timeZone: tz }, end:{ dateTime: end, timeZone: tz } }) });
  return normalize(data);
}
export async function listClients(){ return []; }
