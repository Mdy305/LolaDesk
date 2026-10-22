import { createHash } from 'node:crypto';
export const META = { name:'Square', description:'Bookings, payments, and customers from Square.', status:'available', docs:'https://developer.squareup.com/reference/square',
  // LIVE: Lola asks Square itself for open times and books inside Square, then reads the booking back (lib/live-booking.js).
  live: true };
const ENV = (process.env.SQUARE_ENV || 'sandbox').toLowerCase();
const API_BASE = ENV === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';
const SQV = () => process.env.SQUARE_VERSION || '2024-12-18';
// Least privilege for what Lola really does (Square permissions reference):
//   seller-level bookings (APPOINTMENTS_ALL_*) so she sees EVERY booking the salon has — not only her own —
//   and never double-books a chair; booking profiles (business settings) and team members for stylists;
//   customers to name the client; catalog for the service menu; merchant profile for locations;
//   payments + orders, read-only, for the salon's revenue and marketing insights.
export const SCOPE_LIST = ['MERCHANT_PROFILE_READ','APPOINTMENTS_READ','APPOINTMENTS_WRITE','APPOINTMENTS_ALL_READ','APPOINTMENTS_ALL_WRITE',
  'APPOINTMENTS_BUSINESS_SETTINGS_READ','CUSTOMERS_READ','CUSTOMERS_WRITE','ITEMS_READ','EMPLOYEES_READ',
  // Read-only sales: Lola's revenue, marketing and money insights (what sold, who spends, who stopped coming).
  'PAYMENTS_READ','ORDERS_READ'];
const SCOPES = SCOPE_LIST.join('+');
export const redirectUrl = () => process.env.SQUARE_REDIRECT_URL || `${(process.env.APP_URL || 'https://www.loladesk.com').replace(/\/$/, '')}/api/oauth/callback`;
export function getAuthUrl(state){
  // Exactly the Redirect URL registered in the Square Developer Console (Square matches it exactly); the
  // provider rides in the sealed state, so the URL carries no query string.
  const redirect = redirectUrl();
  return `${API_BASE}/oauth2/authorize?client_id=${process.env.SQUARE_APP_ID}&scope=${SCOPES}&session=false&state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirect)}`;
}
export async function exchangeCode(code){
  const r = await fetch(`${API_BASE}/oauth2/token`, { method:'POST', headers:{'Content-Type':'application/json','Square-Version':SQV()}, body: JSON.stringify({ client_id:process.env.SQUARE_APP_ID, client_secret:process.env.SQUARE_APP_SECRET, code, grant_type:'authorization_code', redirect_uri: redirectUrl() }) });
  const data = await r.json();
  if(!r.ok) throw new Error(data.errors?.[0]?.detail || 'Square OAuth failed');
  return { access_token:data.access_token, refresh_token:data.refresh_token, expires_at:data.expires_at, merchant_id:data.merchant_id, raw:data };
}
export async function refreshToken(refresh_token){
  const r = await fetch(`${API_BASE}/oauth2/token`, { method:'POST', headers:{'Content-Type':'application/json','Square-Version':SQV()}, body: JSON.stringify({ client_id:process.env.SQUARE_APP_ID, client_secret:process.env.SQUARE_APP_SECRET, refresh_token, grant_type:'refresh_token' }) });
  return r.json();
}
/** Renew an expired Square token in place (and in the integrations row). Never throws. */
async function renewToken(integration){
  try{
    const t = await refreshToken(integration.refresh_token);
    if(!t?.access_token) return false;
    integration.access_token = t.access_token;
    if(t.refresh_token) integration.refresh_token = t.refresh_token;
    if(t.expires_at) integration.expires_at = t.expires_at;
    if(integration.id){
      const [{ db }, { encrypt }] = await Promise.all([import('../db.js'), import('../crypto.js')]);
      const c = db();
      if(c) await c.from('integrations').update({ access_token: encrypt(t.access_token), ...(t.refresh_token ? { refresh_token: encrypt(t.refresh_token) } : {}), ...(t.expires_at ? { expires_at: t.expires_at } : {}) }).eq('id', integration.id);
    }
    return true;
  }catch(_){ return false; }
}
function authHeaders(i){ return { 'Content-Type':'application/json','Square-Version':SQV(),'Authorization':`Bearer ${i.access_token}` }; }

// One Square call. Non-2xx THROWS (with .status) — an outage or an expired
// token must never look like "no appointments" (booking-sync would then wipe
// the salon's busy time and Lola would double-book it).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function sq(integration, path, { method = 'GET', body } = {}, retried = false, attempt = 0){
  const r = await fetch(`${API_BASE}${path}`, { method, headers: authHeaders(integration), ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await r.json().catch(() => ({}));
  // Square access tokens expire after 30 days: renew once with the refresh token and keep the new one.
  if(r.status === 401 && !retried && integration?.refresh_token && await renewToken(integration)) return sq(integration, path, { method, body }, true, attempt);
  // Rate limited / Square hiccup: back off and try again (every write carries an idempotency key).
  if((r.status === 429 || r.status >= 500) && attempt < 2){
    const ra = Number(r.headers?.get?.('retry-after')) || 0;
    await sleep(Math.min(4000, ra ? ra * 1000 : 400 * 2 ** attempt));
    return sq(integration, path, { method, body }, retried, attempt + 1);
  }
  if(!r.ok){
    const code = data?.errors?.[0]?.code || null;
    const e = new Error(`Square ${method} ${path.split('?')[0]} ${r.status || ''}: ${data?.errors?.[0]?.detail || code || 'request failed'}`.trim());
    e.status = r.status; e.code = code;
    // The salon disconnected LolaDesk in Square (or the token can't be renewed): say so — never keep failing silently.
    if(r.status === 401 || /^ACCESS_TOKEN_(REVOKED|EXPIRED)$/.test(String(code || ''))){ e.code = 'square_auth'; e.squareCode = code; await authProblem(integration, code || 'UNAUTHORIZED'); }
    throw e;
  }
  return data || {};
}

/** Mark the connection as needing the owner (revoked / expired) and tell them once. Never throws. */
export async function authProblem(integration, code = 'UNAUTHORIZED'){
  try{
    if(!integration?.id) return;
    const { db } = await import('../db.js');
    const c = db(); if(!c) return;
    const { data: row } = await c.from('integrations').select('id,status,metadata,tenant_id').eq('id', integration.id).maybeSingle();
    if(!row || row.status !== 'connected') return;
    const status = code === 'ACCESS_TOKEN_REVOKED' || code === 'revoked' ? 'revoked' : 'needs_reconnect';
    await c.from('integrations').update({ status, metadata: { ...(row.metadata || {}), auth_error: code, auth_error_at: new Date().toISOString() } }).eq('id', row.id);
    const { data: tenant } = await c.from('tenants').select('*').eq('id', row.tenant_id).maybeSingle();
    if(tenant){
      const { notifyOwner } = await import('../billing-enforce.js');
      const app = process.env.APP_URL || 'https://www.loladesk.com';
      await notifyOwner(tenant, `Lola: Square is disconnected from LolaDesk, so I can't see or book your Square calendar. Your existing appointments stay blocked. Reconnect in one tap: ${app}/settings.html#integrations`, { subject: 'Reconnect Square to LolaDesk' });
    }
  }catch(_){}
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
  const list = out.filter(b => b?.id && !seen.has(b.id) && seen.add(b.id));
  let names = {};
  try{ names = await namesFor(integration, list, locId); }catch(e){ if(e.code === 'square_auth') throw e; }
  return list.map((b) => normalize(b, names));
}
// Square booking statuses → LolaDesk's: a cancelled or declined Square booking frees the chair.
export function squareStatus(st){
  const v = String(st || '').toUpperCase();
  if(/^CANCELLED|^DECLINED/.test(v)) return 'cancelled';
  if(v === 'NO_SHOW') return 'no_show';
  if(v === 'PENDING') return 'pending';
  return 'confirmed';
}
const fullName = (c) => c ? ([c.given_name, c.family_name].filter(Boolean).join(' ').trim() || c.company_name || c.nickname || '') : '';
function normalize(b, names = {}){
  const segs = b.appointment_segments || [];
  const seg = segs[0] || {};
  const dur = segs.reduce((t, x) => t + (Number(x.duration_minutes) || 0), 0) || 60;
  const cust = b.customer_id ? names.customers?.get(b.customer_id) : null;
  const service = segs.map((x) => names.services?.get(x.service_variation_id)).filter(Boolean).join(' + ');
  return { id:b.id, version:b.version ?? null, starts_at:b.start_at, ends_at:new Date(new Date(b.start_at).getTime()+dur*60000).toISOString(), duration_min:dur,
    client:{ name: fullName(cust) || (b.customer_id ? 'Square client' : 'Walk-in'), phone: cust?.phone_number || null, email: cust?.email_address || null, square_id: b.customer_id || null },
    service: service || 'Service', stylist:seg.team_member_id||null, stylist_name: (seg.team_member_id && names.staff?.get(seg.team_member_id)) || null,
    status: squareStatus(b.status), raw:b };
}

// Names for a page of bookings: clients (bulk), services (catalog, cached 10 min), stylists (booking profiles, cached).
const nameCache = new Map();
async function cached(key, fn){
  const hit = nameCache.get(key);
  if(hit && Date.now() - hit.at < 10 * 60e3) return hit.v;
  const v = await fn(); nameCache.set(key, { v, at: Date.now() }); return v;
}
export function forgetNames(integration){ for(const k of [...nameCache.keys()]) if(k.startsWith((integration?.id || integration?.tenant_id || 'x') + ':')) nameCache.delete(k); }
async function namesFor(integration, bookings, locId){
  const base = (integration?.id || integration?.tenant_id || 'x') + ':';
  const customers = new Map();
  const ids = [...new Set(bookings.map((b) => b.customer_id).filter(Boolean))];
  for(let i = 0; i < ids.length; i += 100){
    try{
      const d = await sq(integration, '/v2/customers/bulk-retrieve', { method:'POST', body:{ customer_ids: ids.slice(i, i + 100) } });
      for(const [id, v] of Object.entries(d.responses || {})) if(v?.customer) customers.set(id, v.customer);
    }catch(e){ if(e.code === 'square_auth') throw e; break; }
  }
  const services = await cached(base + 'services', async () => {
    const m = new Map();
    try{ for(const x of await squareServices(integration)) m.set(x.variationId, x.name); }catch(e){ if(e.code === 'square_auth') throw e; }
    return m;
  });
  // Services retired from the menu still name their old bookings.
  const missing = [...new Set(bookings.flatMap((b) => (b.appointment_segments || []).map((x) => x.service_variation_id)).filter((id) => id && !services.has(id)))];
  if(missing.length){
    try{
      const d = await sq(integration, '/v2/catalog/batch-retrieve', { method:'POST', body:{ object_ids: missing.slice(0, 100), include_related_objects: true } });
      const items = new Map((d.related_objects || []).filter((o) => o.type === 'ITEM').map((o) => [o.id, o.item_data?.name]));
      for(const o of d.objects || []){ const vd = o.item_variation_data || {}; const n = items.get(vd.item_id) || vd.name; if(n) services.set(o.id, n); }
    }catch(_){}
  }
  const staff = await cached(base + 'staff:' + locId, async () => new Map((await bookableStaff(integration, locId)).map((x) => [x.id, x.name])));
  return { customers, services, staff };
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
    // Booking for the salon (seller-level) needs Square Appointments Plus or Premium on their account.
    if(/subscri|appointments plus|premium|INSUFFICIENT_SCOPES|FORBIDDEN/i.test(why) && err.code !== 'square_auth'){ const e = new Error('Square Appointments Plus or Premium is needed for Lola to book inside Square'); e.code = 'plan_required'; throw e; }
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


// ══ Connection lifecycle (Square App Marketplace requirements) ══

/** What this token may do, straight from Square: { ok, scopes, missing, expires_at, merchant_id }. */
export async function tokenStatus(integration){
  try{
    const r = await fetch(`${API_BASE}/oauth2/token/status`, { method:'POST', headers: authHeaders(integration), body: '{}' });
    const d = await r.json().catch(() => ({}));
    if(!r.ok) return { ok: false, status: r.status, code: d?.errors?.[0]?.code || null };
    const scopes = Array.isArray(d.scopes) ? d.scopes : [];
    return { ok: true, scopes, missing: SCOPE_LIST.filter((x) => !scopes.includes(x)), expires_at: d.expires_at || null, merchant_id: d.merchant_id || null };
  }catch(e){ return { ok: false, error: String(e?.message || e) }; }
}

/** Disconnect for real: revoke LolaDesk's access at Square (all of this seller's tokens). */
export async function revokeAccess(integration){
  try{
    const merchant = integration?.metadata?.merchant_id || null;
    const r = await fetch(`${API_BASE}/oauth2/revoke`, { method:'POST',
      headers:{ 'Content-Type':'application/json', 'Square-Version':SQV(), 'Authorization':`Client ${process.env.SQUARE_APP_SECRET}` },
      body: JSON.stringify({ client_id: process.env.SQUARE_APP_ID, ...(merchant ? { merchant_id: merchant } : { access_token: integration?.access_token }) }) });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok && d.success !== false, status: r.status };
  }catch(e){ return { ok: false, error: String(e?.message || e) }; }
}

/** Square: renew every 7 days or less, used or not. Renew when the 30-day token is more than 6 days old. */
export async function keepFresh(integration, { now = Date.now() } = {}){
  const exp = Date.parse(integration?.expires_at || '') || 0;
  if(exp && exp - now > 24 * 864e5) return { ok: true, refreshed: false, expires_at: integration.expires_at };
  if(!integration?.refresh_token) return { ok: false, refreshed: false, error: 'no_refresh_token' };
  const ok = await renewToken(integration);
  return { ok, refreshed: ok, expires_at: integration.expires_at || null };
}

/** Square webhook signature: base64(HMAC-SHA256(signature key, notification URL + raw body)). */
export async function verifyWebhook(raw, signature, { url, key } = {}){
  if(!key || !url || !signature || typeof raw !== 'string') return false;
  const { createHmac, timingSafeEqual } = await import('node:crypto');
  const want = Buffer.from(createHmac('sha256', key).update(url + raw).digest('base64'));
  const got = Buffer.from(String(signature));
  return want.length === got.length && timingSafeEqual(want, got);
}

/** The salon's location, time zone and name — saved when they connect. */
export async function describeAccount(integration){
  const d = await sq(integration, '/v2/locations');
  const locs = (d.locations || []).filter((l) => String(l.status || 'ACTIVE').toUpperCase() === 'ACTIVE');
  const loc = locs.find((l) => l.id === integration?.metadata?.location_id) || locs[0] || null;
  return { location_id: loc?.id || null, location_name: loc?.name || null, tz: loc?.timezone || null, business_name: loc?.business_name || null,
    locations: locs.map((l) => ({ id: l.id, name: l.name })).slice(0, 20) };
}

/**
 * Stylists and services, matched by name to the salon's LolaDesk team and menu (never created, never
 * overwritten): Square bookings land in the right stylist's column, and Lola books the right service.
 */
export async function autoMap(integration){
  const tenantId = integration?.tenant_id;
  if(!tenantId) return { ok: false, error: 'no tenant' };
  const repo = await import('../booking-repository.js');
  const locId = await locationId(integration);
  const out = { ok: true, staff: { mapped: 0, unmatched: [] }, services: { mapped: 0, unmatched: [] } };
  const [staff, services, sqStaff, sqServices] = await Promise.all([
    repo.listStaff(tenantId).catch(() => []), repo.listServices(tenantId).catch(() => []),
    bookableStaff(integration, locId), squareServices(integration).catch(() => [])]);
  const key = (x) => norm(x).replace(/\s+/g, ' ');
  for(const p of sqStaff){
    const n = key(p.name); if(!n) continue;
    const first = n.split(' ')[0];
    let hit = staff.filter((s) => key(s.name) === n);
    if(!hit.length){ const byFirst = staff.filter((s) => key(s.name).split(' ')[0] === first); if(byFirst.length === 1) hit = byFirst; }
    if(hit.length !== 1){ out.staff.unmatched.push(p.name); continue; }
    const had = await repo.getProviderMapping(tenantId, 'square', 'staff', hit[0].id).catch(() => null);
    if(had?.external_id) continue;
    try{ await repo.upsertProviderMapping({ tenantId, provider: 'square', entityType: 'staff', localId: hit[0].id, externalId: p.id }); out.staff.mapped++; }catch(_){}
  }
  for(const sv of services){
    const had = await repo.getProviderMapping(tenantId, 'square', 'service', sv.id).catch(() => null);
    if(had?.external_id) continue;
    const exact = sqServices.filter((x) => key(x.name) === key(sv.name) || key(x.name.split(' – ')[0]) === key(sv.name));
    if(exact.length !== 1){ out.services.unmatched.push(sv.name); continue; }
    try{ await repo.upsertProviderMapping({ tenantId, provider: 'square', entityType: 'service', localId: sv.id, externalId: exact[0].variationId }); out.services.mapped++; }catch(_){}
  }
  forgetNames(integration);
  return out;
}
export const squareCall = (integration, path, opts = {}) => sq(integration, path, opts);
