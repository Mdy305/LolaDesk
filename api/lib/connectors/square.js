import { createHash } from 'node:crypto';
export const META = { name:'Square', description:'Bookings, payments, and customers from Square.', status:'available', docs:'https://developer.squareup.com/reference/square',
  // LIVE: Lola asks Square itself for open times and books inside Square, then reads the booking back (lib/live-booking.js).
  live: true };
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
/** Renew an expired Square token in place (and in the integrations row). Never throws. */
async function renewToken(integration){
  try{
    const t = await refreshToken(integration.refresh_token);
    if(!t?.access_token) return false;
    integration.access_token = t.access_token;
    if(t.refresh_token) integration.refresh_token = t.refresh_token;
    if(integration.id){
      const [{ db }, { encrypt }] = await Promise.all([import('../db.js'), import('../crypto.js')]);
      const c = db();
      if(c) await c.from('integrations').update({ access_token: encrypt(t.access_token), ...(t.refresh_token ? { refresh_token: encrypt(t.refresh_token) } : {}), ...(t.expires_at ? { expires_at: t.expires_at } : {}) }).eq('id', integration.id);
    }
    return true;
  }catch(_){ return false; }
}
function authHeaders(i){ return { 'Content-Type':'application/json','Square-Version':'2024-12-18','Authorization':`Bearer ${i.access_token}` }; }

// One Square call. Non-2xx THROWS (with .status) — an outage or an expired
// token must never look like "no appointments" (booking-sync would then wipe
// the salon's busy time and Lola would double-book it).
async function sq(integration, path, { method = 'GET', body } = {}, retried = false){
  const r = await fetch(`${API_BASE}${path}`, { method, headers: authHeaders(integration), ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await r.json().catch(() => ({}));
  // Square access tokens expire after 30 days: renew once with the refresh token and keep the new one.
  if(r.status === 401 && !retried && integration?.refresh_token && await renewToken(integration)) return sq(integration, path, { method, body }, true);
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


// ══ LIVE: Lola checks and books inside Square (same contract as Boulevard — lib/live-booking.js) ══
const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['a','an','the','and','with','for','my','i','want','like','get','some','please','appointment','service']);
const words = (x) => norm(x).split(' ').filter((w) => w && !STOP.has(w));

/** The salon's bookable Square services: [{ variationId, version, name, durationMin }]. */
async function squareServices(integration){
  const out = [];
  let cursor = null, pages = 0;
  do{
    const data = await sq(integration, '/v2/catalog/search-catalog-items', { method:'POST', body:{ product_types:['APPOINTMENTS_SERVICE'], limit: 100, ...(cursor ? { cursor } : {}) } });
    for(const item of data.items || []){
      const vars = item.item_data?.variations || [];
      for(const v of vars){
        const vd = v.item_variation_data || {};
        if(vd.available_for_booking === false) continue;
        const name = vars.length > 1 && vd.name && norm(vd.name) !== norm(item.item_data?.name) ? `${item.item_data?.name} – ${vd.name}` : (item.item_data?.name || vd.name || 'Service');
        out.push({ variationId: v.id, version: v.version, name, durationMin: Math.round((Number(vd.service_duration) || 3600000) / 60000) });
      }
    }
    cursor = data.cursor || null;
  }while(cursor && ++pages < 10);
  return out;
}
/** Best service for what the caller said ("balayage", "women's cut"). null when nothing fits. */
export function matchService(list, said){
  const want = words(said);
  if(!want.length) return null;
  let best = null, bestScore = 0;
  for(const s of list){
    const have = new Set(words(s.name));
    let score = want.filter((w) => have.has(w) || [...have].some((h) => h.startsWith(w) || w.startsWith(h))).length / want.length;
    if(norm(s.name) === norm(said)) score = 2;
    if(score > bestScore){ best = s; bestScore = score; }
  }
  return bestScore >= 0.5 ? best : null;
}
async function bookableStaff(integration, locId){
  try{
    const q = new URLSearchParams({ bookable_only: 'true', location_id: locId, limit: '100' });
    const data = await sq(integration, `/v2/bookings/team-member-booking-profiles?${q}`);
    return (data.team_member_booking_profiles || []).filter((p) => p.is_bookable !== false).map((p) => ({ id: p.team_member_id, name: p.display_name || '' }));
  }catch(_){ return []; }
}
function dayBounds(date, tz){
  // The salon's local midnight → UTC instants for one calendar day.
  const at = (d, h) => { const x = new Date(`${d}T${h}:00Z`); const off = new Date(x.toLocaleString('en-US', { timeZone: 'UTC' })) - new Date(x.toLocaleString('en-US', { timeZone: tz })); return new Date(x.getTime() + off); };
  const next = new Date(Date.parse(date + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10);
  return { start: at(date, '00:00'), end: at(next, '00:00') };
}
const localDay = (iso, tz) => new Date(iso).toLocaleDateString('en-CA', { timeZone: tz });
async function searchTimes(integration, { locId, svc, staffIds, from, to }){
  const start = new Date(Math.max(from.getTime(), Date.now() + 5 * 60e3));
  if(start >= to) return [];
  const data = await sq(integration, '/v2/bookings/availability/search', { method:'POST', body:{ query:{ filter:{
    start_at_range:{ start_at: start.toISOString(), end_at: to.toISOString() }, location_id: locId,
    segment_filters:[{ service_variation_id: svc.variationId, ...(staffIds?.length ? { team_member_id_filter:{ any: staffIds } } : {}) }] } } } });
  return (data.availabilities || []).map((a) => ({ startTime: a.start_at, teamMemberId: a.appointment_segments?.[0]?.team_member_id || null }));
}
function pick(times, wantAt, n = 3){
  const list = [...times];
  if(wantAt) list.sort((a, b) => Math.abs(Date.parse(a.startTime) - Date.parse(wantAt)) - Math.abs(Date.parse(b.startTime) - Date.parse(wantAt)));
  else if(list.length > n){ const step = list.length / n; return Array.from({ length: n }, (_, i) => list[Math.floor(i * step)]); }
  return list.slice(0, n).sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
}
async function resolve(integration, { service, stylist }){
  const locId = await locationId(integration);
  const [list, staff] = await Promise.all([squareServices(integration), bookableStaff(integration, locId)]);
  const svc = matchService(list, service);
  const nameOf = (id) => staff.find((x) => x.id === id)?.name || null;
  let staffIds = null, staffName = null, staffMissing = false;
  if(stylist){
    const w = norm(stylist).split(' ')[0];
    const hit = staff.find((x) => norm(x.name).split(' ').includes(w));
    if(hit){ staffIds = [hit.id]; staffName = hit.name; } else staffMissing = true;
  }
  return { locId, svc, list, staffIds, staffName, staffMissing, nameOf };
}

/** Live only when this Square account really takes appointments (a POS-only Square stays on LolaDesk's calendar). */
const readyCache = new Map();
export async function liveReady(integration){
  const key = integration?.id || integration?.tenant_id || 'x';
  const hit = readyCache.get(key);
  if(hit && Date.now() - hit.at < 10 * 60e3) return hit.ok;
  let ok = false;
  try{ ok = (await squareServices(integration)).length > 0; }catch(_){ ok = false; }
  readyCache.set(key, { ok, at: Date.now() });
  return ok;
}

export async function liveAvailability(integration, { service, date, wantAt = null, stylist = null, tz = 'America/New_York' } = {}){
  tz = integration?.metadata?.tz || tz;
  const r = await resolve(integration, { service, stylist });
  if(!r.svc) return { ok: false, error: 'service_not_found', menu: r.list.map((x) => x.name).slice(0, 8) };
  const { start, end } = dayBounds(date, tz);
  const times = await searchTimes(integration, { locId: r.locId, svc: r.svc, staffIds: r.staffIds, from: start, to: end });
  const exact = wantAt ? times.find((t) => Math.abs(Date.parse(t.startTime) - Date.parse(wantAt)) < 60e3) || null : null;
  let nextDate = null, nextTimes = [];
  if(!times.length){
    const later = await searchTimes(integration, { locId: r.locId, svc: r.svc, staffIds: r.staffIds, from: end, to: new Date(end.getTime() + 14 * 864e5) }).catch(() => []);
    if(later.length){ nextDate = localDay(later[0].startTime, tz); nextTimes = later.filter((t) => localDay(t.startTime, tz) === nextDate); }
  }
  return { ok: true, service: r.svc.name, duration: r.svc.durationMin, staffName: r.staffName || (exact ? r.nameOf(exact.teamMemberId) : null), staffMissing: r.staffMissing,
    exact, times, nextDate, nextTimes };
}

/** Book in Square, then read it back. Throws .code 'conflict' (+ .offers) / 'service_not_found' (+ .menu) / 'card_required'. */
export async function liveCreate(integration, p){
  const tz = p.timezone || integration?.metadata?.tz || 'America/New_York';
  const date = p.date || localDay(p.starts_at, tz);
  const r = await resolve(integration, { service: p.service, stylist: p.stylist });
  if(!r.svc){ const e = new Error('service not on the Square menu'); e.code = 'service_not_found'; e.menu = r.list.map((x) => x.name).slice(0, 8); throw e; }
  const { start, end } = dayBounds(date, tz);
  const times = await searchTimes(integration, { locId: r.locId, svc: r.svc, staffIds: r.staffIds, from: start, to: end });
  const slot = times.find((t) => Math.abs(Date.parse(t.startTime) - Date.parse(p.starts_at)) < 60e3);
  if(!slot){ const e = new Error('that time is no longer open in Square'); e.code = 'conflict'; e.offers = pick(times, p.starts_at); throw e; }
  const name = String(p.client?.name || [p.client?.first_name, p.client?.last_name].filter(Boolean).join(' ') || '').trim();
  const customerId = await findOrCreateCustomer(integration, { client_name: name, client_phone: p.client?.phone || null, client: { email: p.client?.email || null, name } });
  const idempotency_key = 'lola-live-' + stableKey(integration.tenant_id, slot.startTime, r.svc.variationId, p.client?.phone || name);
  let data;
  try{
    data = await sq(integration, '/v2/bookings', { method:'POST', body:{ idempotency_key, booking:{
      start_at: slot.startTime, location_id: r.locId, ...(customerId ? { customer_id: customerId } : {}),
      customer_note: p.notes || 'Booked by Lola (LolaDesk)',
      appointment_segments:[{ duration_minutes: r.svc.durationMin, service_variation_id: r.svc.variationId, team_member_id: slot.teamMemberId,
        ...(r.svc.version != null ? { service_variation_version: r.svc.version } : {}) }] } } });
  }catch(err){
    const why = String(err.code || '') + ' ' + String(err.message || '');
    if(/card/i.test(why)){ const e = new Error('Square needs a card on file'); e.code = 'card_required'; throw e; }
    if(/unavailable|conflict|not available|taken/i.test(why)){ const e = new Error('that time was just taken in Square'); e.code = 'conflict'; e.offers = pick(times.filter((t) => t !== slot), p.starts_at); throw e; }
    throw err;
  }
  const id = data.booking?.id;
  if(!id) throw new Error('Square returned no booking');
  // Verify: read it back from Square before anyone hears "booked".
  let check = null;
  try{ check = (await sq(integration, `/v2/bookings/${encodeURIComponent(id)}`)).booking || null; }catch(_){ check = null; }
  if(check && /CANCELLED|DECLINED|NO_SHOW/.test(String(check.status || ''))){ const e = new Error('Square shows that booking as ' + check.status); e.code = 'not_confirmed'; throw e; }
  const b = check || data.booking;
  const dur = (b.appointment_segments || []).reduce((t, x) => t + (Number(x.duration_minutes) || 0), 0) || r.svc.durationMin;
  return { id, external_id: id, verified: !!check, starts_at: b.start_at, ends_at: new Date(Date.parse(b.start_at) + dur * 60000).toISOString(), service: r.svc.name, staff: r.nameOf(slot.teamMemberId) || r.staffName, state: b.status };
}
