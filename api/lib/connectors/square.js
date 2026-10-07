import { createHash } from 'node:crypto';
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

// One Square call. Non-2xx THROWS (with .status) — an outage or an expired
// token must never look like "no appointments" (booking-sync would then wipe
// the salon's busy time and Lola would double-book it).
async function sq(integration, path, { method = 'GET', body } = {}){
  const r = await fetch(`${API_BASE}${path}`, { method, headers: authHeaders(integration), ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await r.json().catch(() => ({}));
  if(!r.ok){
    const e = new Error(`Square ${method} ${path.split('?')[0]} ${r.status || ''}: ${data?.errors?.[0]?.detail || data?.errors?.[0]?.code || 'request failed'}`.trim());
    e.status = r.status; e.code = data?.errors?.[0]?.code || null;
    throw e;
  }
  return data || {};
}

async function locationId(integration){
  const pinned = integration?.metadata?.location_id || integration?.metadata?.square_location_id;
  if(pinned) return pinned;
  const data = await sq(integration, '/v2/locations');
  const loc = (data.locations || []).find(l => String(l.status || 'ACTIVE').toUpperCase() === 'ACTIVE') || (data.locations || [])[0];
  if(!loc?.id){ const e = new Error('No Square location on this account'); e.code = 'config'; throw e; }
  return loc.id;
}

const DAY_MS = 864e5, MAX_WINDOW_MS = 31 * DAY_MS;   // Square: start_at_max - start_at_min ≤ 31 days

export async function listAppointments(integration, { from, to } = {}){
  const start = from || new Date(Date.now()-7*864e5).toISOString();
  const end = to || new Date(Date.now()+30*864e5).toISOString();
  const locId = await locationId(integration);
  const out = [];
  // GET /v2/bookings (ListBookings) — there is no /v2/bookings/search endpoint.
  for(let s = new Date(start).getTime(), e = new Date(end).getTime(); s < e; s += MAX_WINDOW_MS){
    const chunkEnd = Math.min(e, s + MAX_WINDOW_MS);
    let cursor = null, pages = 0;
    do{
      const q = new URLSearchParams({ location_id: locId, start_at_min: new Date(s).toISOString(), start_at_max: new Date(chunkEnd).toISOString(), limit: '100' });
      if(cursor) q.set('cursor', cursor);
      const data = await sq(integration, `/v2/bookings?${q}`);
      out.push(...(data.bookings || []));
      cursor = data.cursor || null;
    }while(cursor && ++pages < 50);
  }
  const seen = new Set();
  return out.filter(b => b?.id && !seen.has(b.id) && seen.add(b.id)).map(normalize);
}
function normalize(b){
  const segs = b.appointment_segments || [];
  const seg = segs[0] || {};
  const dur = segs.reduce((t, x) => t + (Number(x.duration_minutes) || 0), 0) || 60;
  return { id:b.id, version:b.version ?? null, starts_at:b.start_at, ends_at:new Date(new Date(b.start_at).getTime()+dur*60000).toISOString(), duration_min:dur, client:{name:b.customer_id?`Customer ${b.customer_id.slice(0,6)}`:'Walk-in'}, service:'Service', stylist:seg.team_member_id||null, status:(b.status||'confirmed').toLowerCase(), raw:b };
}

// local id → Square id through provider_mappings (tenant from the integration row).
async function mapped(integration, entityType, localId){
  if(!localId || !integration?.tenant_id) return null;
  try{
    const { getProviderMapping } = await import('../booking-repository.js');
    return (await getProviderMapping(integration.tenant_id, 'square', entityType, localId))?.external_id || null;
  }catch(_){ return null; }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// An id the caller passed is Square's only if it isn't simply LolaDesk's own id echoed back.
const external = (id, localId) => !!id && String(id) !== String(localId || '') && !UUID.test(String(id));
const configError = (msg) => { const e = new Error(msg); e.code = 'config'; return e; };
const stableKey = (...parts) => createHash('sha256').update(parts.map(x => String(x ?? '')).join('|')).digest('hex').slice(0, 40);

async function findOrCreateCustomer(integration, appt){
  const fromMap = await mapped(integration, 'client', appt.local_client_id);
  if(fromMap) return fromMap;
  if(external(appt.customer_id, appt.local_client_id)) return appt.customer_id;
  const phone = appt.client_phone || appt.client?.phone || null;
  const email = appt.client?.email || appt.client_email || null;
  if(phone){
    const found = await sq(integration, '/v2/customers/search', { method:'POST', body:{ limit: 1, query:{ filter:{ phone_number:{ exact: phone } } } } });
    if(found.customers?.[0]?.id) return found.customers[0].id;
  }
  if(!phone && !email) return null;
  const [given, ...rest] = String(appt.client_name || appt.client?.name || '').trim().split(/\s+/);
  const created = await sq(integration, '/v2/customers', { method:'POST', body:{
    idempotency_key: 'lola-cust-' + stableKey(integration.tenant_id, phone, email),
    given_name: given || undefined, family_name: rest.join(' ') || undefined,
    phone_number: phone || undefined, email_address: email || undefined,
    note: 'Added by Lola (LolaDesk)'
  } });
  const id = created.customer?.id || null;
  if(id && appt.local_client_id && integration?.tenant_id){
    try{ const { upsertProviderMapping } = await import('../booking-repository.js'); await upsertProviderMapping({ tenantId: integration.tenant_id, provider:'square', entityType:'client', localId: appt.local_client_id, externalId: id }); }catch(_){}
  }
  return id;
}

async function teamMemberFor(integration, appt, locId){
  const fromMap = await mapped(integration, 'staff', appt.local_staff_id);
  if(fromMap) return fromMap;
  if(external(appt.team_member_id, appt.local_staff_id)) return appt.team_member_id;
  // No stylist mapping: Square still needs a team member — the first active,
  // bookable one at this location.
  const data = await sq(integration, '/v2/team-members/search', { method:'POST', body:{ limit: 10, query:{ filter:{ location_ids:[locId], status:'ACTIVE' } } } });
  const tm = (data.team_members || [])[0];
  if(!tm?.id) throw configError('No active Square team member to book with — map your stylists in Settings → Integrations');
  return tm.id;
}

export async function createAppointment(integration, appt){
  const locId = await locationId(integration);
  const variationId = appt.service_variation_id
    || await mapped(integration, 'service', appt.local_service_id)
    || (external(appt.service_id, appt.local_service_id) ? appt.service_id : null);
  if(!variationId) throw configError(`The service "${appt.service || 'this service'}" isn't mapped to a Square service — map it in Settings → Integrations`);
  // The real catalog version (Square rejects a stale/hard-coded one).
  const obj = await sq(integration, `/v2/catalog/object/${encodeURIComponent(variationId)}`);
  const version = obj.object?.version;
  const [customerId, teamMemberId] = await Promise.all([findOrCreateCustomer(integration, appt), teamMemberFor(integration, appt, locId)]);
  // Stable across retries: the outbox can re-run this commit any number of
  // times and Square creates exactly one booking.
  const idempotency_key = 'lola-' + (appt.local_booking_id ? String(appt.local_booking_id) : stableKey(integration.tenant_id, appt.starts_at, variationId, appt.client_phone || appt.client?.name));
  const data = await sq(integration, '/v2/bookings', { method:'POST', body:{ idempotency_key, booking:{
    start_at: new Date(appt.starts_at).toISOString(), location_id: locId,
    ...(customerId ? { customer_id: customerId } : {}),
    customer_note: appt.notes || undefined,
    appointment_segments:[{ duration_minutes: appt.duration_min || 60, service_variation_id: variationId, team_member_id: teamMemberId,
      ...(version != null ? { service_variation_version: version } : {}) }]
  } } });
  return normalize(data.booking);
}

// Cancel needs the booking's current version (optimistic concurrency).
export async function cancelAppointment(integration, { id }){
  if(!id) throw new Error('Square cancel: missing booking id');
  const cur = await sq(integration, `/v2/bookings/${encodeURIComponent(id)}`);
  const b = cur.booking || {};
  if(String(b.status || '').toUpperCase().startsWith('CANCELLED')) return normalize(b);
  const data = await sq(integration, `/v2/bookings/${encodeURIComponent(id)}/cancel`, { method:'POST', body:{ idempotency_key: 'lola-cancel-' + stableKey(id, b.version), booking_version: b.version } });
  return normalize(data.booking || b);
}

export async function updateAppointment(integration, { id, starts_at, duration_min, team_member_id }){
  if(!id) throw new Error('Square update: missing booking id');
  const cur = await sq(integration, `/v2/bookings/${encodeURIComponent(id)}`);
  const b = cur.booking || {};
  const segs = (b.appointment_segments || []).map((x, i) => ({ ...x,
    // One-segment bookings take the new length; multi-segment ones keep theirs.
    ...(i === 0 && Number(duration_min) > 0 && (b.appointment_segments || []).length === 1 ? { duration_minutes: Number(duration_min) } : {}),
    ...(team_member_id && !UUID.test(String(team_member_id)) ? { team_member_id } : {}) }));
  const data = await sq(integration, `/v2/bookings/${encodeURIComponent(id)}`, { method:'PUT', body:{
    idempotency_key: 'lola-update-' + stableKey(id, b.version, starts_at, duration_min, team_member_id),
    booking:{ version: b.version, start_at: new Date(starts_at || b.start_at).toISOString(), ...(segs.length ? { appointment_segments: segs } : {}) }
  } });
  return normalize(data.booking || b);
}
export async function listClients(integration, { limit=100 } = {}){
  const r = await fetch(`${API_BASE}/v2/customers?limit=${limit}`, { headers:authHeaders(integration) });
  const data = await r.json();
  if(!r.ok) return [];
  return (data.customers||[]).map(c => ({ id:c.id, name:[c.given_name,c.family_name].filter(Boolean).join(' ')||'Unknown', phone:c.phone_number||null, email:c.email_address||null, raw:c }));
}
