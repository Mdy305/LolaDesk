import { randomBytes } from 'node:crypto';
import { randomInt } from 'node:crypto';
import { db } from './db.js';
import { sendSMS } from '../telnyx-sms.js';
import { cancelText, confirmText, calendarLinkFor } from './lola-persona.js';
import { requestDeposit } from './deposits.js';
import { whenForTenant } from './salon-time.js';
import { recordFeeFor, voidFee, moveFee } from './booking-fees.js';
import { localDateKey, dayBoundsUtc, zonedLocalToUtc } from './timezone.js';

// Short, human-friendly confirmation code for client self-cancel. 6 chars,
// unambiguous alphabet (no 0/O/1/I/L), crypto-random.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function makeConfirmationCode(){
  let out = '';
  for(let i = 0; i < 6; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

export async function sendConfirmationSMS({tenantId,clientId,serviceId,startTime,confirmationCode=null,verb='Booked'}){
  try{
    const db2 = db();
    if(!db2) return;
    const [{data:tenant},{data:client},{data:svc}] = await Promise.all([
      db2.from('tenants').select('name,phone_number').eq('id',tenantId).maybeSingle(),
      db2.from('clients').select('*').eq('id',clientId).maybeSingle(),
      db2.from('services').select('name').eq('id',serviceId).maybeSingle()
    ]);
    if(!client || !client.phone || !tenant || !tenant.phone_number) return { skipped: true, reason: 'missing_recipient' };
    const when = await whenForTenant(tenantId, startTime);
    // Add-to-calendar rides the Booked/Rescheduled texts (the ones that put
    // the visit ON the calendar); the cancel text removes it, so it stays
    // link-free. The link is client-owned (code + their phone) — never an
    // internal booking_id. A failure here must never break the text.
    const cal = verb!=='Cancelled'
      ? calendarLinkFor({ code: confirmationCode, phone: client.phone }) : null;
    const text = verb==='Cancelled'
      ? cancelText(tenant.name, when)
      : confirmText({ verb, salon: tenant.name, serviceName: svc && svc.name, when, code: confirmationCode, calendarUrl: cal });
    // A client who uses WhatsApp with a WhatsApp-ready salon gets it there — free text
    // inside 24h of their last WhatsApp message, otherwise the approved
    // booking_confirmation template. Anything else (or a refusal) → SMS as always.
    if(verb!=='Cancelled' && client.whatsapp_enabled){
      try{
        const { tenantWhatsAppReady, planWhatsApp } = await import('./whatsapp-setup.js');
        if(await tenantWhatsAppReady(db2, tenantId)){
          const first = String(client.name||'').trim().split(/\s+/)[0] || 'there';
          const plan = await planWhatsApp(db2, { tenantId, clientId, templateName: 'booking_confirmation', params: [first, (svc && svc.name) || 'salon', tenant.name || 'the salon', when] });
          if(plan){
            const w = await sendSMS({ from: tenant.phone_number, to: client.phone, text, tenantId, type: 'WHATSAPP', ...(plan.template ? { template: plan.template } : {}) });
            if(smsSent(w)) return { sent: true, text, channel: 'whatsapp' };
          }
        }
      }catch(_){ /* fall through to SMS */ }
    }
    const r = await sendSMS({ from: tenant.phone_number, to: client.phone, text, tenantId });
    // Report what Telnyx actually did — a rejection (opt-out, bad number,
    // 4xx) comes back as { skipped/failed/errors }, never as a throw.
    if(smsSent(r)) return { sent: true, text };
    return { sent: false, text, reason: smsFailReason(r) };
  }catch(e){ console.warn('[repo] SMS:', e.message); return { skipped: true, reason: String(e?.message||e) }; }
}

/** Did a sendSMS/sendSms result actually go out? (Telnyx success = { data: { id } }.) */
export function smsSent(r){
  if(!r || typeof r !== 'object') return false;
  if(r.skipped || r.failed || r.sent === false) return false;
  if(Array.isArray(r.errors) && r.errors.length && !r.data) return false;
  return true;
}
export function smsFailReason(r){
  if(!r) return 'no_response';
  return String(r.reason || r.errors?.[0]?.detail || r.errors?.[0]?.title || 'not_sent').slice(0, 200);
}

const CANCELED = new Set(['cancelled','canceled']);

export function iso(value){
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function addMinutes(value, minutes){
  const start = new Date(value);
  return new Date(start.getTime() + Number(minutes || 0) * 60000).toISOString();
}

export async function getBookingSettings(tenantId){
  const c = db();
  if(!c) return null;
  const { data } = await c.from('booking_settings').select('*').eq('tenant_id', tenantId).maybeSingle();
  return data || {
    tenant_id: tenantId,
    timezone: 'America/New_York',
    slot_interval_minutes: 15,
    minimum_notice_minutes: 120,
    booking_horizon_days: 90,
    cancellation_window_hours: 24,
    default_buffer_before_min: 0,
    default_buffer_after_min: 0,
    allow_staff_choice: true,
    allow_any_staff: true,
    allow_processing_overlap: true,
    public_booking_enabled: true,
    voice_booking_enabled: true
  };
}

export async function listServices(tenantId, { activeOnly=true } = {}){
  const c = db(); if(!c) return [];
  let q = c.from('services').select('*').eq('tenant_id', tenantId).order('name');
  if(activeOnly) q = q.eq('is_active', true);
  const { data, error } = await q;
  if(error) throw error;
  return data || [];
}

export async function listStaff(tenantId, { activeOnly=true } = {}){
  const c = db(); if(!c) return [];
  let q = c.from('staff').select('*').eq('tenant_id', tenantId).order('name');
  if(activeOnly) q = q.eq('is_active', true);
  const { data, error } = await q;
  if(error) throw error;
  return data || [];
}

// Which staff do which services (optional per-staff duration/price). Works
// with either schema variant and never breaks availability: a missing table
// or column just means "everyone does everything".
export async function getStaffServices(tenantId){
  const c = db(); if(!c) return [];
  const { data: staff } = await c.from('staff').select('id').eq('tenant_id', tenantId);
  const ids = (staff || []).map(s => s.id);
  if(!ids.length) return [];
  const { data, error } = await c.from('staff_services').select('*').in('staff_id', ids);
  if(error) return [];
  return data || [];
}

export async function getStaffSchedules(tenantId){
  const c = db(); if(!c) return [];
  const { data, error } = await c.from('staff_schedules').select('*').eq('tenant_id', tenantId);
  if(error) throw error;
  return data || [];
}

// Time off overlapping [from, to). The table uses starts_at/ends_at (older
// code expected start_time/end_time + approved); accept either, never throw.
export async function getStaffTimeOff(tenantId, from, to){
  const c = db(); if(!c) return [];
  const { data, error } = await c.from('staff_time_off').select('*').eq('tenant_id', tenantId);
  if(error) return [];
  const f = new Date(from).getTime(), t = new Date(to).getTime();
  return (data || []).filter(r => r.approved !== false).map(r => ({ ...r, start_time: r.start_time || r.starts_at, end_time: r.end_time || r.ends_at }))
    .filter(r => r.start_time && r.end_time && new Date(r.start_time).getTime() < t && new Date(r.end_time).getTime() > f);
}

// Blocked time (lunch, breaks, days off) recorded by the owner on the
// calendar. Rows are date-keyed (blocked_date) with optional local start/end
// times; a row with no times is an all-day block. The engine converts these
// into UTC windows per staff member. Degrades to [] when the table is absent
// (pre-20260901_inventory_ops.sql) so availability never breaks.
export async function getBlockedSlots(tenantId, dateKey){
  const c = db(); if(!c) return [];
  const { data, error } = await c.from('blocked_slots').select('*')
    .eq('tenant_id', tenantId).eq('blocked_date', dateKey);
  if(error) return [];
  return data || [];
}

/**
 * Blocked time (lunch, breaks, days off) for one stylist in [startIso, endIso),
 * keyed on the SALON-local date(s) with the block's local times converted to
 * instants in the salon's timezone — the availability engine's convention.
 * → the blocked salon-local date key, or null. (Shared by salon.js + calendar.js.)
 */
export async function blockedHitTz(c, tenantId, staffId, startIso, endIso, tz){
  if(!c) return null;
  const zone = tz || 'America/New_York';
  const s = new Date(startIso).getTime(), e = new Date(endIso).getTime();
  const keys = [...new Set([localDateKey(new Date(s), zone), localDateKey(new Date(Math.max(s, e - 1)), zone)])];
  for(const key of keys){
    const { data: bk } = await c.from('blocked_slots').select('*').eq('tenant_id', tenantId).eq('blocked_date', key);
    const day = dayBoundsUtc(key, zone);
    const hit = (bk || []).some(b => (!b.staff_id || !staffId || b.staff_id === staffId) &&
      s < new Date(b.end_time ? zonedLocalToUtc(key, b.end_time, zone) : day.end).getTime() &&
      new Date(b.start_time ? zonedLocalToUtc(key, b.start_time, zone) : day.start).getTime() < e);
    if(hit) return key;
  }
  return null;
}

export async function getBusinessHoursForTenant(tenantId){
  const c = db(); if(!c) return [];
  const { data: locations } = await c.from('locations').select('id,is_primary,timezone').eq('organization_id', tenantId);
  if(!locations?.length) return [];
  const primary = locations.find(x=>x.is_primary) || locations[0];
  const { data, error } = await c.from('business_hours').select('*').eq('location_id', primary.id).order('day_of_week');
  if(error) throw error;
  return (data || []).map(x=>({ ...x, location_id: primary.id, timezone: primary.timezone }));
}

export async function listBookings(tenantId, from, to, { staffId=null, clientId=null } = {}){
  const c = db(); if(!c) return [];
  let q = c.from('bookings').select('*').eq('tenant_id', tenantId).lt('start_time', to).gt('end_time', from);
  if(staffId) q = q.eq('staff_id', staffId);
  if(clientId) q = q.eq('client_id', clientId);
  const { data, error } = await q.order('start_time');
  if(error) throw error;
  return (data || []).filter(x=>!CANCELED.has(String(x.status||'').toLowerCase()));
}

export async function listActiveHolds(tenantId, from, to, { staffId=null } = {}){
  const c = db(); if(!c) return [];
  let q = c.from('availability_holds').select('*')
    .eq('tenant_id', tenantId).eq('status','active').gt('expires_at', new Date().toISOString())
    .lt('starts_at', to).gt('ends_at', from);
  if(staffId) q = q.eq('staff_id', staffId);
  const { data, error } = await q;
  if(error) throw error;
  return data || [];
}

// Hold lifetimes are short by design: a hold blocks a real chair for everyone else.
export const HOLD_TTL_MIN_S = 30, HOLD_TTL_MAX_S = 900;
const holdTtl = (ttlSeconds) => Math.min(HOLD_TTL_MAX_S, Math.max(HOLD_TTL_MIN_S, Number(ttlSeconds) || 300));
const ACTIVE_BOOKING = (b) => !CANCELED.has(String(b?.status||'').toLowerCase()) && !/^no[-_ ]?show$/i.test(String(b?.status||''));

// Raw insert (no conflict check). Kept for callers that already serialize;
// every engine path uses createHoldAtomic below.
export async function createHold({ tenantId, clientId=null, staffId, serviceId=null, startsAt, endsAt, channel='voice', conversationId=null, ttlSeconds=300, requester=null }){
  const c = db(); if(!c) throw new Error('database not configured');
  const expiresAt = new Date(Date.now() + holdTtl(ttlSeconds)*1000).toISOString();
  const row = {
    tenant_id: tenantId, client_id: clientId, staff_id: staffId, service_id: serviceId,
    starts_at: startsAt, ends_at: endsAt, channel, conversation_id: conversationId,
    expires_at: expiresAt, status:'active',
    // Same shape as the column default (encode(gen_random_bytes(18),'hex')), known before the round trip.
    hold_token: randomBytes(18).toString('hex'),
    ...(requester ? { requester } : {})
  };
  let { data, error } = await c.from('availability_holds').insert(row).select().single();
  if(error && requester && /requester/i.test(String(error.message||''))){
    // Pre-20261006 schema: no requester column yet — hold anyway (and self-heal).
    import('./booking-integrity.js').then(m => m.ensureBookingIntegritySchema()).catch(() => {});
    const { requester: _r, ...plain } = row;
    ({ data, error } = await c.from('availability_holds').insert(plain).select().single());
  }
  if(error) throw error;
  return data;
}

/**
 * The atomic "check then hold". Preferred path: Postgres lola_take_hold (per-stylist
 * advisory lock + re-check of bookings and active holds + insert, one transaction).
 * Fallback when the function isn't deployed (older DB, tests): insert, then
 * re-check — if another live hold or a booking the engine never saw overlaps,
 * the LATER claimant deletes its own hold and reports a conflict.
 *   windowStart/windowEnd — the span incl. buffers that must be free
 *   seenBookingIds        — bookings the availability engine already evaluated
 * → { ok:true, hold, atomic } | { ok:false, conflict:true, error:'slot_unavailable', reason }
 */
export async function createHoldAtomic({ tenantId, clientId=null, staffId, serviceId=null, startsAt, endsAt, windowStart=null, windowEnd=null, channel='voice', conversationId=null, ttlSeconds=300, excludeBookingId=null, seenBookingIds=[], requester=null }){
  const c = db(); if(!c) throw new Error('database not configured');
  const wS = windowStart || startsAt, wE = windowEnd || endsAt;
  const expiresAt = new Date(Date.now() + holdTtl(ttlSeconds)*1000).toISOString();
  const holdToken = randomBytes(18).toString('hex');
  const { takeHoldRpc } = await import('./booking-integrity.js');
  const rpc = await takeHoldRpc(c, { tenantId, staffId, startsAt, endsAt, windowStart: wS, windowEnd: wE, expiresAt, holdToken,
    clientId, serviceId, channel, conversationId, excludeBookingId, seenBookingIds, requester });
  if(rpc){
    if(rpc.ok) return { ok:true, hold: rpc.hold, atomic:true };
    return { ok:false, conflict:true, error:'slot_unavailable', reason: rpc.reason };
  }
  // ── fallback: insert, then re-check after insert ──
  // The LATER claimant yields. Insertion order is created_at; on an exact tie
  // nobody can tell who was first, so the tied claimants both step back and
  // retry after a short random pause (never two winners).
  const seen = new Set((seenBookingIds||[]).map(String));
  const ms = (v) => new Date(v).getTime();
  const sameChair = (x) => staffId ? x.staff_id === staffId : x.staff_id == null;
  for(let attempt = 0; attempt < 4; attempt++){
    const mine = await createHold({ tenantId, clientId, staffId, serviceId, startsAt, endsAt, channel, conversationId, ttlSeconds, requester });
    const nowMs = Date.now();
    let verdict = null;   // null = keep · 'hold' | 'booking' = yield for good · 'tie' = yield and retry
    try{
      let hq = c.from('availability_holds').select('*').eq('tenant_id', tenantId).eq('status','active')
        .lt('starts_at', wE).gt('ends_at', wS);
      hq = staffId ? hq.eq('staff_id', staffId) : hq;
      const { data: holds } = await hq;
      const mT = ms(mine.created_at || nowMs) || nowMs;
      const rivals = (holds||[]).filter(h => h.id !== mine.id && sameChair(h) && ms(h.expires_at) > nowMs);
      if(rivals.some(h => (ms(h.created_at) || 0) < mT)) verdict = 'hold';
      else if(rivals.some(h => (ms(h.created_at) || 0) === mT)) verdict = 'tie';
      if(!verdict){
        let bq = c.from('bookings').select('id,staff_id,status,start_time,end_time').eq('tenant_id', tenantId).lt('start_time', wE);
        bq = staffId ? bq.eq('staff_id', staffId) : bq;
        const { data: rows } = await bq;
        if((rows||[]).some(b => ACTIVE_BOOKING(b) && b.id !== excludeBookingId && !seen.has(String(b.id)) && sameChair(b)
          && ms(b.end_time || addMinutes(b.start_time, 60)) > ms(wS))) verdict = 'booking';
      }
    }catch(e){ console.warn('[repo] hold re-check failed:', String(e?.message||e).slice(0,120)); }
    if(!verdict) return { ok:true, hold: mine, atomic:false };
    try{ await c.from('availability_holds').delete().eq('id', mine.id).eq('tenant_id', tenantId); }
    catch(_){ try{ await releaseHold(tenantId, mine.hold_token, 'released'); }catch(__){} }
    if(verdict !== 'tie') return { ok:false, conflict:true, error:'slot_unavailable', reason: verdict };
    await new Promise(r => setTimeout(r, 5 + Math.floor(Math.random() * 35)));
  }
  return { ok:false, conflict:true, error:'slot_unavailable', reason:'contended' };
}

/**
 * Claim a hold for exactly ONE booking: conditional update active → converted
 * (still unexpired), returning the row. A retry, a double-click or a second
 * tab gets null and must not write a second booking. Pass holdToken or holdId.
 */
export async function claimHold(tenantId, { holdToken=null, holdId=null } = {}){
  const c = db(); if(!c) return null;
  if(!holdToken && !holdId) return null;
  let q = c.from('availability_holds').update({ status:'converted' })
    .eq('tenant_id', tenantId).eq('status','active').gt('expires_at', new Date().toISOString());
  q = holdToken ? q.eq('hold_token', holdToken) : q.eq('id', holdId);
  const { data, error } = await q.select().maybeSingle();
  if(error) return null;
  return data || null;
}

/** Undo a claim when the booking write itself failed (the time is still the client's). */
export async function unclaimHold(tenantId, hold){
  const c = db(); if(!c || !hold?.id) return null;
  try{
    const { data } = await c.from('availability_holds').update({ status:'active' })
      .eq('tenant_id', tenantId).eq('id', hold.id).eq('status','converted').select().maybeSingle();
    return data || null;
  }catch(_){ return null; }
}

export async function releaseHold(tenantId, holdToken, status='released'){
  const c = db(); if(!c) return null;
  const { data, error } = await c.from('availability_holds').update({ status })
    .eq('tenant_id', tenantId).eq('hold_token', holdToken).select().maybeSingle();
  if(error) throw error;
  return data;
}

export async function getHold(tenantId, holdToken){
  const c = db(); if(!c) return null;
  const { data } = await c.from('availability_holds').select('*')
    .eq('tenant_id', tenantId).eq('hold_token', holdToken).maybeSingle();
  return data || null;
}

// Auto-rebooking loop: the moment a client books a service, any open offer
// for them on that service flips to `booked` (see api/lib/rebooking.js —
// dynamic import avoids a static cycle through the availability engine).
async function markRebookingAcceptedSafe({ tenantId, clientId, serviceId }){
  if(!tenantId || !clientId || !serviceId) return;
  try{
    const { markRebookingAccepted } = await import('./rebooking.js');
    await markRebookingAccepted({ tenantId, clientId, serviceId });
  }catch{ /* offer bookkeeping never fails the booking */ }
}

/**
 * Write one booking. Options for callers that confirm/charge elsewhere:
 *   sendConfirmation:false — no confirmation text AND no deposit request (series, public page)
 *   skipDeposit:true       — the text goes out, but no deposit request (e.g. add-on segments
 *                            whose deposit is covered by the main booking)
 * A holdId that already produced a booking (bookings_hold_id_unique) throws
 * err.code === 'hold_already_used' — never a second booking from one hold.
 */
export async function createCanonicalBooking({ tenantId, clientId, serviceId=null, staffId=null, locationId=null, startTime, endTime, status='confirmed', totalAmount=0, notes=null, source='lola', conversationId=null, holdId=null, externalId=null, externalSource=null, sendConfirmation=true, skipDeposit=false, series=null }){
  const c = db(); if(!c) throw new Error('database not configured');
  const row = {
    tenant_id: tenantId, client_id: clientId, service_id: serviceId, staff_id: staffId,
    location_id: locationId, start_time: startTime, end_time: endTime, status,
    total_amount: totalAmount || 0, notes, source, conversation_id: conversationId, hold_id: holdId,
    external_id: externalId, external_provider: externalSource,
    confirmation_code: makeConfirmationCode(),
    // Recurring-series identity (20260902_booking_series.sql): null for plain
    // bookings; { id, pos, total, rule } for an occurrence.
    ...(series ? {
      series_id: series.id || null,
      series_pos: Number(series.pos) || null,
      series_total: Number(series.total) || null,
      series_rule: String(series.rule || '') || null
    } : {})
  };
  const { data, error } = await c.from('bookings').insert(row).select().single();
  if(error){
    if(holdId && (error.code === '23505' || /bookings_hold_id_unique|duplicate key/i.test(String(error.message||'')))){
      const e = new Error('hold_already_used'); e.code = 'hold_already_used'; throw e;
    }
    throw error;
  }
  await appendBookingHistory({ tenantId, bookingId:data.id, fromStatus:null, toStatus:status, source });
  // Recurring series suppress the per-occurrence text — the first occurrence
  // confirms once for the whole series (salon.js passes sendConfirmation:false).
  if(status==='confirmed' && sendConfirmation) sendConfirmationSMS({tenantId,clientId,serviceId,startTime,confirmationCode:row.confirmation_code}).catch(()=>{});
  // No-show protection: when the salon requires deposits, a fresh confirmed
  // booking gets its Payment Link request (same sendConfirmation contract —
  // series occurrences and suppressed texts never request deposits either).
  // Fire-and-forget: a deposit failure must never fail the booking.
  if(status==='confirmed' && sendConfirmation && !skipDeposit){
    requestDeposit({ tenantId, booking: data, policy: null }).catch(()=>{});
  }
  // Auto-rebooking: a confirmed booking for this client+service closes any
  // open offer (fire-and-forget — bookkeeping never fails the booking).
  if(status==='confirmed'){
    markRebookingAcceptedSafe({ tenantId, clientId, serviceId }).catch(()=>{});
  }
  // LolaDesk's per-appointment fee (ledger only; never fails the booking).
  recordFeeFor(c, data).catch(()=>{});
  return data;
}

/**
 * Turn a hold into exactly one booking: claim the hold first (active → converted,
 * conditional), THEN insert. A second request carrying the same hold (retry,
 * double tap, two tabs) gets { ok:false, conflict:true, error:'hold_expired' }.
 * If the insert itself fails the claim is undone so the client keeps the time.
 * `fields` are createCanonicalBooking's arguments (holdId is set here).
 */
export async function bookFromHold(tenantId, hold, fields){
  if(!hold?.id && !hold?.hold_token) return { ok:false, error:'hold_required' };
  const claimed = await claimHold(tenantId, hold.hold_token ? { holdToken: hold.hold_token } : { holdId: hold.id });
  if(!claimed) return { ok:false, conflict:true, error:'hold_expired' };
  try{
    const booking = await createCanonicalBooking({ ...fields, tenantId, holdId: claimed.id });
    return { ok:true, booking, hold: claimed };
  }catch(e){
    if(e?.code === 'hold_already_used') return { ok:false, conflict:true, error:'hold_expired' };
    await unclaimHold(tenantId, claimed);
    throw e;
  }
}

const sameInstant = (a, b) => {
  const x = new Date(a).getTime(), y = new Date(b).getTime();
  return Number.isFinite(x) && Number.isFinite(y) ? x === y : String(a||'') === String(b||'');
};

/**
 * Cancels / moves reach the salon's own booking system: when the booking was
 * written upstream (external_id) — or its create is still queued in the
 * outbox — queue the matching 'cancel' / 'update' op. Live providers that
 * book synchronously (Boulevard) have no cancel path yet: logged, skipped.
 */
async function queueUpstreamChange(c, before, after, op){
  try{
    const provider = after?.external_provider || before?.external_provider || null;
    const externalId = after?.external_id || before?.external_id || null;
    if(provider === 'boulevard_client'){
      console.warn('[repo] boulevard_client ' + op + ' not supported upstream — change kept in LolaDesk only:', before?.id);
      return { skipped: true, reason: 'boulevard_client_unsupported' };
    }
    let pendingCreate = false;
    if(!externalId){
      const { data: rows } = await c.from('booking_outbox').select('id,status,op').eq('booking_id', before.id).eq('op','create');
      pendingCreate = (rows||[]).some(r => ['pending','working','done'].includes(r.status));
      if(!pendingCreate) return { skipped: true, reason: 'not_upstream' };
    }
    if(provider === 'zapier') return { skipped: true, reason: 'zapier_handled_by_zap' };
    const { enqueueUpstream, afterResponse, processOutbox } = await import('./booking-outbox.js');
    const ctx = { externalId, provider, startsAt: after?.start_time || before?.start_time, endsAt: after?.end_time || before?.end_time,
      staffId: after?.staff_id || before?.staff_id || null, serviceId: before?.service_id || null };
    const q = await enqueueUpstream(c, { tenantId: before.tenant_id, bookingId: before.id, ctx, op, replace: op === 'update' });
    if(q?.ok) afterResponse(processOutbox(c, { bookingId: before.id }));
    return q;
  }catch(e){ console.warn('[repo] upstream ' + op + ' queue failed:', String(e?.message||e).slice(0,160)); return { ok:false }; }
}

export async function updateCanonicalBooking(tenantId, bookingId, patch, { source='lola', reason=null, sendCancellation=true, sendReschedule=true, upstream=true } = {}){
  const c = db(); if(!c) throw new Error('database not configured');
  const { data: row0 } = await c.from('bookings').select('*').eq('tenant_id',tenantId).eq('id',bookingId).maybeSingle();
  if(!row0) return null;
  const before = { ...row0 };   // a snapshot: the comparisons below must see the OLD values
  const toCancelled = CANCELED.has(String(patch.status||'').toLowerCase()) && !CANCELED.has(String(before.status||'').toLowerCase());
  const nowIso = new Date().toISOString();
  const full = { ...patch, updated_at: nowIso, ...(toCancelled && !patch.cancelled_at ? { cancelled_at: nowIso } : {}) };
  let { data, error } = await c.from('bookings').update(full)
    .eq('tenant_id', tenantId).eq('id', bookingId).select().single();
  if(error && full.cancelled_at && /cancelled_at/i.test(String(error.message||''))){
    // Pre-20261006 schema: no cancelled_at column — updated_at carries the moment
    // (and the migration self-applies for next time).
    import('./booking-integrity.js').then(m => m.ensureBookingIntegritySchema()).catch(() => {});
    const { cancelled_at: _c, ...rest } = full;
    ({ data, error } = await c.from('bookings').update(rest).eq('tenant_id', tenantId).eq('id', bookingId).select().single());
  }
  if(error) throw error;
  const timeChanged = !!(patch.start_time && before.start_time && !sameInstant(patch.start_time, before.start_time));
  const endChanged = !!(patch.end_time && before.end_time && !sameInstant(patch.end_time, before.end_time));
  const staffChanged = !!(patch.staff_id && patch.staff_id !== before.staff_id);
  if(patch.status && patch.status !== before.status){
    await appendBookingHistory({ tenantId, bookingId, fromStatus:before.status, toStatus:patch.status, source, reason });
  } else if(timeChanged || staffChanged){
    // A move is history too — recorded once, here (callers don't add their own).
    await appendBookingHistory({ tenantId, bookingId, fromStatus:before.status, toStatus:data?.status || before.status, source, reason: reason || 'rescheduled',
      metadata:{ from: before.start_time, to: data?.start_time || patch.start_time, ...(staffChanged ? { staff_from: before.staff_id, staff_to: patch.staff_id } : {}) } });
  }
  // When a confirmed booking's start time changes (reschedule from the widget
  // OR the dashboard) and the client stayed confirmed, re-text them the new
  // time — honoring the same confirmation text pattern. Never fires when only
  // status or another field changed. Instants are compared, not strings
  // ('…00.000Z' and '…00+00:00' are the same moment).
  if(timeChanged && sendReschedule && (patch.status === 'confirmed' || (before.status === 'confirmed' && !patch.status))){
    try{
      await sendConfirmationSMS({
        tenantId, clientId: before.client_id, serviceId: before.service_id,
        startTime: data.start_time || patch.start_time, confirmationCode: data.confirmation_code || before.confirmation_code,
        verb: 'Rescheduled'
      });
    }catch(e){ /* a failed confirmation text must never fail a reschedule */ }
  }
  // A CONFIRMED booking cancelled by the salon (or the client) must reach
  // the client — before this, cancellation was the one lifecycle moment with
  // no Telnyx wire. Drafts/pending rows never promised the client anything,
  // so they stay silent. Series-wide cancels pass sendCancellation:false per
  // occurrence and send exactly ONE text at the call site (same contract as
  // series creation's one confirmation).
  // Cancelled / no-show before it was billed → the salon owes nothing for it.
  // The per-booking fee follows the booking: void on cancel / no-show, re-dated when it moves.
  if(patch.status && /^(cancel|no[-_ ]?show)/i.test(String(patch.status))) await voidFee(c, bookingId, String(patch.status).toLowerCase()).catch(()=>{});
  else if(timeChanged) await moveFee(bookingId, data?.start_time || patch.start_time, c).catch(()=>{});
  const isCancellation = CANCELED.has(String(patch.status||'').toLowerCase())
    && String(before.status||'').toLowerCase() === 'confirmed';
  if(isCancellation && sendCancellation){
    try{
      await sendConfirmationSMS({
        tenantId, clientId: before.client_id, serviceId: before.service_id,
        startTime: before.start_time,
        confirmationCode: data.confirmation_code || before.confirmation_code,
        verb: 'Cancelled'
      });
    }catch(e){ /* a failed cancel text must never fail the cancellation */ }
  }
  // The salon's own booking system hears about it too (durable outbox).
  if(upstream){
    if(toCancelled) await queueUpstreamChange(c, before, data, 'cancel');
    else if((timeChanged || endChanged || staffChanged) && !CANCELED.has(String(data?.status||'').toLowerCase())) await queueUpstreamChange(c, before, data, 'update');
  }
  return data;
}

export async function appendBookingHistory({ tenantId, bookingId, fromStatus=null, toStatus, source='lola', actorId=null, reason=null, metadata={} }){
  const c = db(); if(!c) return null;
  const { data } = await c.from('booking_status_history').insert({
    tenant_id:tenantId, booking_id:bookingId, from_status:fromStatus, to_status:toStatus,
    source, actor_id:actorId, reason, metadata
  }).select().maybeSingle();
  return data;
}

export async function getProviderMapping(tenantId, provider, entityType, localId){
  const c = db(); if(!c) return null;
  const { data } = await c.from('provider_mappings').select('*')
    .eq('tenant_id',tenantId).eq('provider',provider).eq('entity_type',entityType).eq('local_id',localId).maybeSingle();
  return data || null;
}

export async function upsertProviderMapping({ tenantId, provider, entityType, localId, externalId, externalParentId=null, metadata={} }){
  const c = db(); if(!c) throw new Error('database not configured');
  const { data, error } = await c.from('provider_mappings').upsert({
    tenant_id:tenantId, provider, entity_type:entityType, local_id:localId,
    external_id:externalId, external_parent_id:externalParentId, metadata
  }, { onConflict:'tenant_id,provider,entity_type,local_id' }).select().single();
  if(error) throw error;
  return data;
}

// ── booking waitlist ─────────────────────────────────────────────────
// Makes Lola's "I'll add you to the priority waitlist" promise real. One
// tenant-scoped table fed by voice (booking-brain), the web widget, and the
// dashboard. When a slot frees up, findWaitlistMatches surfaces the people
// to offer it to — the revenue-recovery moment.

export async function addToWaitlist({ tenantId, clientId=null, clientName=null, clientPhone=null,
  serviceId=null, serviceName=null, staffId=null, preferredDate=null, preferredTime=null,
  notes=null, source='voice', smsConsent=false }){
  const c = db(); if(!c) throw new Error('database not configured');
  const { data, error } = await c.from('booking_waitlist').insert({
    tenant_id:tenantId, client_id:clientId, client_name:clientName || null,
    client_phone:clientPhone || null, service_id:serviceId || null, service_name:serviceName || null,
    staff_id:staffId || null, preferred_date:preferredDate || null, preferred_time:preferredTime || null,
    notes:notes || null, status:'active', sms_consent:!!smsConsent, source
  }).select().maybeSingle();
  if(error) throw error;
  return data || null;
}

export async function listWaitlist(tenantId, { status='active', limit=100 } = {}){
  const c = db(); if(!c) return [];
  let q = c.from('booking_waitlist').select('*').eq('tenant_id',tenantId).order('created_at',{ ascending:false });
  if(status) q = q.eq('status',status);
  if(limit) q = q.limit(limit);
  const { data, error } = await q;
  if(error) throw error;
  return data || [];
}

export async function removeFromWaitlist(tenantId, id, status='removed'){
  const c = db(); if(!c) return null;
  const { data, error } = await c.from('booking_waitlist')
    .update({ status })
    .eq('tenant_id',tenantId).eq('id',id)
    .select().maybeSingle();
  if(error) throw error;
  return data || null;
}

export async function markWaitlistOffered(tenantId, id){
  return removeFromWaitlist(tenantId, id, 'offered');
}

// Who is waiting for a just-freed slot? Matches on service (an entry with no
// specific service is a general standby and always matches), scoped to the
// tenant, newest first. Returns a count plus the top entries for the UI.
export async function findWaitlistMatches(tenantId, { serviceId=null, serviceName=null, staffId=null, limit=5 } = {}){
  const c = db(); if(!c) return { count:0, entries:[] };
  const { data, error } = await c.from('booking_waitlist').select('*')
    .eq('tenant_id',tenantId).eq('status','active')
    .order('created_at',{ ascending:true }).limit(limit);
  if(error) throw error;
  const rows = data || [];
  const nameMatch = String(serviceName||'').trim().toLowerCase();
  const entries = rows.filter(r => {
    if(!r.service_id && !r.service_name) return true; // general standby
    if(r.service_id && serviceId) return String(r.service_id) === String(serviceId);
    if(r.service_name && nameMatch) return r.service_name.toLowerCase().includes(nameMatch) || nameMatch.includes(r.service_name.toLowerCase());
    return false;
  });
  return { count: entries.length, entries };
}
