/**
 * lib/booking-brain.js — the ONE smart-booking orchestration layer
 * ════════════════════════════════════════════════════════════════════
 * Every transport that books (Telnyx voice/SMS via MCP tools, the owner
 * "Jarvis"/LolaBrain line, and the web/chat tools) routes through here, so
 * there is exactly one booking path: resolve → hold → commit → remember.
 *
 *   • SMART: delegates slot math to availability-engine-v2 (service phases,
 *     buffers, processing overlap, minimum notice) and writes through
 *     booking-repository (canonical schema + holds + status history).
 *   • TENANT-ISOLATED: every read/write is scoped by tenant_id — same
 *     guarantee as the rest of the platform.
 *   • REMEMBERS: maintains per-tenant memory (getTenantMemory/setTenantMemory
 *     in db.js) — booking events, learned facts, preferences — and injects
 *     it into prompts via tenantMemoryBlock(). Lola recalls what she's done
 *     for THIS salon, never another's.
 *
 * Legacy compatibility: canonical rows also receive the legacy columns
 * (service, stylist, starts_at, duration_min, price) so the older
 * operator-db read path keeps working while tenants migrate.
 */

import { db, getTenantMemory, setTenantMemory, getTenantIntegrations } from './db.js';
import * as repo from './booking-repository.js';
import { resolveBookingRequest } from './booking-resolver.js';
import { getAvailability, holdAvailability } from './availability-engine-v2.js';
import * as crm from './lola-crm.js';
import { writeAppointment, getConnector } from './aggregator.js';
import { listBookings, enrichBookings, resolveDateKey, to24, moveBooking } from './operator-db.js';
import { salonTz, fmtSalon } from './salon-time.js';
import { localDateKey, zonedLocalToUtc } from './timezone.js';
import { sendConfirmationSMS } from './booking-repository.js';
import { requestDeposit } from './deposits.js';
import { bookingGateResponse, BLOCKED_BOOKING_ACTIONS } from './billing-gate.js';
import { offerFreedSlot } from './booking-reminders.js';

// Providers Lola can WRITE appointments to. boulevard (partner sandbox) and
// shopify (retail only) deliberately excluded; google_calendar is a sync
// target, not a booking source of truth, so committing there would duplicate.
// cal_platform is a first-class write target when the owner selects it as
// booking_provider — the Cal.com mesh node takes the appointment.
const BOOKING_PROVIDERS = ['boulevard_client', 'square', 'vagaro', 'mindbody', 'fresha', 'booksy', 'cal_platform'];

// Normalize the owner's booking_provider choice ("cal" -> "cal_platform").
async function preferredBookingProvider(tenantId){
  try{
    const { data: t } = await db().from('tenants').select('booking_provider, booking_platform').eq('id', tenantId).maybeSingle();
    const raw = String(t?.booking_provider || t?.booking_platform || '').toLowerCase();
    return raw === 'cal' ? 'cal_platform' : raw;
  }catch{ return ''; }
}

// ── external commit ("bookings land on Square/Vagaro") ──────────────
// After the LOCAL hold is taken, push the appointment to the tenant's
// connected booking provider. Provider-specific ids are resolved through
// provider_mappings (local -> external); where a mapping is missing we pass
// the local id as best-effort and let the connector decide. Outcomes:
//   { ok:true,  external:{id,provider} }  -> committed upstream
//   { ok:false, conflict:true }           -> provider says slot taken (409)
//   { ok:false, skipped:true }            -> no provider connected (normal)
//   { ok:false, conflict:false }          -> transient failure (auth/network)
const CONFLICT_RE = /(conflict|409|already (booked|taken|reserved)|(not|no longer) available|unavailable|double.?book|slot.*(taken|filled|gone)|taken|filled up)/i;

export async function commitToExternalProvider(tenantId, ctx){
  let integrations = [];
  try{ integrations = await getTenantIntegrations(tenantId); }
  catch(e){ return { ok:false, skipped:true, error:`integrations unavailable: ${e?.message||e}` }; }
  const targets = integrations.filter(i => BOOKING_PROVIDERS.includes(i.provider));
  if(!targets.length) return { ok:false, skipped:true };
  // Honor the owner's selected booking provider (e.g. cal_platform) over the
  // first-connected default, so a Cal.com tenant's bookings land on Cal.com.
  let provider = targets[0].provider;
  const pref = await preferredBookingProvider(tenantId);
  if(pref){
    const preferred = targets.find(i => i.provider === pref);
    if(preferred) provider = preferred.provider;
  }

  const mapId = async (entityType, localId) => {
    if(!localId) return null;
    try{ const m = await repo.getProviderMapping(tenantId, provider, entityType, localId); return m?.external_id || null; }catch{ return null; }
  };
  const [customerId, serviceId, teamMemberId] = await Promise.all([
    mapId('client', ctx.client?.id),
    mapId('service', ctx.service?.id),
    mapId('staff', ctx.staff?.id)
  ]);

  const payload = {
    starts_at: ctx.startsAt,
    ends_at: ctx.endsAt,
    duration_min: ctx.durationMin,
    customer_id: customerId || undefined,
    client_name: ctx.client?.name || null,
    client_phone: ctx.client?.phone || null,
    client: { name: ctx.client?.name || null, email: ctx.client?.email || null },
    service_id: serviceId || ctx.service?.id || undefined,
    service: ctx.service?.name || null,
    team_member_id: teamMemberId || ctx.staff?.id || undefined,
    // LolaDesk ids, so a connector can resolve its own mappings / idempotency.
    local_booking_id: ctx.bookingId || undefined,
    local_service_id: ctx.service?.id || undefined,
    local_staff_id: ctx.staff?.id || undefined,
    local_client_id: ctx.client?.id || undefined,
    notes: ctx.notes || 'Booked by Lola (LolaDesk AI front desk)',
    timezone: ctx.timezone || 'America/New_York',
    price: ctx.price
  };

  try{
    const created = await writeAppointment(integrations, payload, { provider });
    const externalId = created?.id || created?.external_id;
    if(!externalId) return { ok:false, skipped:true, error:'provider returned no id' };
    return { ok:true, external:{ id: externalId, provider } };
  }catch(e){
    const msg = String(e?.message || e);
    // A setup problem (unmapped service, no location) won't fix itself on retry.
    if(e?.code === 'config') return { ok:false, conflict:false, unsupported:true, error: msg };
    return { ok:false, conflict: e?.code === 'conflict' || CONFLICT_RE.test(msg), error: msg };
  }
}

// ── small helpers ──────────────────────────────────────────────────
// Spoken times are the SALON's wall clock (Vercel runs in UTC).
const timeLabel = (iso, tz) => fmtSalon(iso, tz, 'time');
const dayLabel = (d, tz) => {
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(String(d)) ? zonedLocalToUtc(String(d), '12:00:00', tz || 'America/New_York') : d;
  try{ return new Date(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: tz || 'America/New_York' }); }
  catch(_){ return new Date(iso).toDateString(); }
};
const first = n => String(n || '').split(' ')[0];
function addMin(iso, minutes){ return new Date(new Date(iso).getTime() + Number(minutes || 0) * 60000).toISOString(); }

function norm(v = ''){
  return String(v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
function fuzzyPick(items, query){
  if(!query) return null;
  const q = norm(query); if(!q) return null;
  let best = null, bestScore = 0;
  for(const it of items){
    const label = norm(it?.name || it);
    if(!label) continue;
    let s = 0;
    if(label === q) s = 100;
    else if(label.includes(q) || q.includes(label)) s = 80;
    else {
      const lw = new Set(label.split(' '));
      const qw = q.split(' '); let o = 0;
      for(const w of qw) if(lw.has(w)) o++;
      s = o ? 40 + o * 10 : 0;
    }
    if(s > bestScore){ bestScore = s; best = it; }
  }
  return bestScore >= 50 ? best : null;
}

// Tenant's onboarded JSON service list (legacy fallback when the services
// table has no rows yet).
function jsonServices(tenant){
  try{
    const list = Array.isArray(tenant.services) ? tenant.services
      : (typeof tenant.services === 'string' ? JSON.parse(tenant.services) : []);
    return (list || []).map(s => typeof s === 'string' ? { name: s, price: null, duration: null } : s);
  }catch{ return []; }
}

/**
 * The appointment instant from spoken params, built in the SALON's timezone.
 *   starts_at (ISO)           → as given
 *   date + time               → salon-local date at salon-local time
 *   time only                 → on fallbackIso's salon-local day (reschedule: the
 *                               booking's own day), else the salon's today
 *   no time                   → null: the caller asks — a time is never invented
 */
export function startsAtFromParams(params, { fallbackIso = null, tz = 'America/New_York', now = new Date() } = {}){
  if(params.starts_at && !/^\d{4}-\d{2}-\d{2}$/.test(String(params.starts_at))){
    const d = new Date(params.starts_at);
    if(!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const hhmm = to24(params.time);
  if(!hhmm) return null;
  const dateParam = params.date || (/^\d{4}-\d{2}-\d{2}$/.test(String(params.starts_at || '')) ? params.starts_at : null);
  const key = dateParam ? resolveDateKey(dateParam, tz, now)
    : (fallbackIso ? localDateKey(new Date(fallbackIso), tz) : localDateKey(now, tz));
  if(!key) return null;
  return zonedLocalToUtc(key, hhmm, tz);
}

// ── tenant memory ("Lola remembers all") ────────────────────────────
async function logEvent(tenantId, kind, detail){
  try{
    const rows = await getTenantMemory(tenantId);
    const log = rows.find(r => r.key === 'event_log')?.value;
    const entry = { kind, detail, at: new Date().toISOString() };
    const next = [entry, ...(Array.isArray(log) ? log : [])].slice(0, 60);
    await setTenantMemory(tenantId, 'event_log', next);
  }catch(e){ console.warn('[booking-brain] memory log failed:', e.message); }
}

// Text block to inject into Lola's system prompt so she "remembers" this salon.
export async function tenantMemoryBlock(tenantId){
  const rows = await getTenantMemory(tenantId);
  if(!rows.length) return '';
  const facts = rows.filter(r => r.key !== 'event_log').map(r =>
    `- ${r.key}: ${typeof r.value === 'string' ? r.value : JSON.stringify(r.value)}`
  );
  const log = rows.find(r => r.key === 'event_log')?.value;
  const recent = Array.isArray(log) ? log.slice(0, 5).map(e =>
    `- ${e.kind}: ${JSON.stringify(e.detail)}`
  ) : [];
  return ['What you remember about this salon:', ...facts, ...recent].join('\n');
}

export async function remember(tenant, params){
  const key = String(params.key || '').trim();
  if(!key) return { ok: false, speak: "What would you like me to remember?" };
  const value = params.value !== undefined ? params.value : true;
  await setTenantMemory(tenant.id, key, value);
  await logEvent(tenant.id, 'remembered', { key });
  return { ok: true, speak: `Got it — I'll remember that about ${tenant.name || 'this salon'}.` };
}

export async function recall(tenant, params){
  const rows = await getTenantMemory(tenant.id);
  const key = params.key ? String(params.key).trim() : null;
  const list = key ? rows.filter(r => r.key === key) : rows;
  if(!list.length) return { ok: true, memories: [], speak: "I don't have anything saved for that yet." };
  const speak = list.slice(0, 8).map(r =>
    `${r.key}: ${typeof r.value === 'string' ? r.value : JSON.stringify(r.value)}`
  ).join('. ');
  return { ok: true, memories: list, speak };
}

// ── booking primitives ─────────────────────────────────────────────
async function getBookingRow(tenantId, bookingId){
  const c = db(); if(!c) return null;
  const { data } = await c.from('bookings').select('*').eq('tenant_id', tenantId).eq('id', bookingId).maybeSingle();
  return data || null;
}

async function resolveClient(tenantId, params, create){
  const found = await crm.findClientByContact(tenantId, params.client_phone || params.phone || null, params.client_email || params.email || null);
  if(found || !create) return found;
  return crm.upsertClient(tenantId, { phone: params.client_phone || params.phone, email: params.client_email || params.email, name: params.client_name || params.name });
}

// Resolve service + staff against the canonical tables, with a JSON fallback
// for tenants that haven't migrated their onboarded service list yet.
async function resolveServiceAndStaff(tenant, params){
  const tenantId = tenant.id;
  if(params.service_id && params.staff_id){
    const services = await repo.listServices(tenantId);
    const staff = await repo.listStaff(tenantId);
    const svc = services.find(s => s.id === params.service_id);
    const st = staff.find(x => x.id === params.staff_id);
    if(!svc) return { ok: false, needs: 'service', speak: "I couldn't find that service." };
    return { ok: true, service: svc, staff: st || null };
  }
  const r = await resolveBookingRequest(tenantId, { service: params.service, stylist: params.stylist || params.staff });
  if(r.ok) return { ok: true, service: r.service, staff: r.staff, anyStaff: r.anyStaff, staffResult: r.staffResult };
  if(r.needs === 'service'){
    const jsvc = fuzzyPick(jsonServices(tenant), params.service);
    if(jsvc){
      const jstaff = fuzzyPick((tenant.team || []).map(x => ({ name: x.name || x })), params.stylist || params.staff);
      return {
        ok: true, jsonService: true,
        service: { id: null, name: jsvc.name, price: jsvc.price ?? null, duration_minutes: jsvc.durationMin ?? jsvc.duration_minutes ?? jsvc.duration ?? 60 },
        staff: jstaff ? { id: null, name: jstaff.name } : null, anyStaff: !jstaff, staffResult: { candidates: [] }
      };
    }
    return { ok: false, needs: 'service', speak: "I want to make sure I book the right service — which one were you thinking?", candidates: (r.serviceResult?.candidates || []).map(x => x.name) };
  }
  return { ok: false, needs: 'staff', speak: "Which stylist would you like?", candidates: (r.staffResult?.candidates || []).map(x => x.name) };
}

// ── the actions ─────────────────────────────────────────────────────
// Provider-aware availability: when the owner selected Cal.com as the booking
// provider, slot truth comes from the Cal.com mesh node via getAvailability
// (service -> eventTypeId through provider_mappings). Any missing config,
// mapping, or outage falls back to the local smart-calendar engine so Lola
// never stalls on a Cal.com hiccup.
async function availabilityWithProvider(tenant, { serviceId, date, staffId, limit }){
  const local = () => getAvailability({ tenantId: tenant.id, serviceId, date, staffId, limit });
  const pref = await preferredBookingProvider(tenant.id);
  if(pref !== 'cal_platform') return local();
  try{
    const integrations = await getTenantIntegrations(tenant.id);
    const cal = (integrations || []).find(i => i.provider === 'cal_platform');
    if(!cal) return local();
    const mapping = await repo.getProviderMapping(tenant.id, 'cal_platform', 'service', serviceId);
    const eventTypeId = mapping?.external_id;
    if(!eventTypeId) return local();
    const from = new Date(date); from.setHours(0, 0, 0, 0);
    const to = new Date(from); to.setDate(to.getDate() + 14);
    const slots = await getConnector('cal_platform').getAvailability(cal, {
      eventTypeId, from: from.toISOString(), to: to.toISOString()
    });
    const svc = (await repo.listServices(tenant.id)).find(s => s.id === serviceId);
    const dur = Number(svc?.duration_minutes || 60);
    const norm = (slots || []).map(s => ({
      starts_at: s.time,
      ends_at: new Date(new Date(s.time).getTime() + dur * 60000).toISOString(),
      duration_minutes: dur,
      staff_name: null,
      provider: 'cal_platform'
    }));
    return { ok: true, slots: norm, service: svc || null, settings: null };
  }catch(e){
    console.warn('[booking-brain] cal_platform availability failed — using local engine:', e?.message || e);
    return local();
  }
}

export async function checkAvailability(tenant, params){
  const resolved = await resolveServiceAndStaff(tenant, params);
  if(!resolved.ok) return resolved;
  if(resolved.jsonService) return { ok: false, error: 'json_service', speak: "That service isn't on the smart calendar yet." };
  const av = await availabilityWithProvider(tenant, {
    serviceId: resolved.service.id,
    date: params.date || params.starts_at || new Date().toISOString(),
    staffId: params.staff_id || resolved.staff?.id || null,
    limit: Number(params.limit || 12)
  });
  if(!av.ok) return { ok: false, error: av.error, speak: "I couldn't check that right now." };
  const tz = await salonTz(tenant.id);
  const names = av.slots.slice(0, 4).map(s => `${timeLabel(s.starts_at, tz)}${s.staff_name ? ` with ${first(s.staff_name)}` : ''}`);
  const speak = av.slots.length
    ? `I have ${av.slots.length} opening${av.slots.length === 1 ? '' : 's'}${names.length ? `: ${names.join(', ')}` : ''}.`
    : `That day looks full — want me to try a different day?`;
  return { ok: true, slots: av.slots, service: av.service, settings: av.settings, speak, text: speak };
}

// Upstream write-through for a booking that is ALREADY saved in LolaDesk:
// queue it in the durable outbox (retried by cron) and wait a moment for the
// salon's platform. → { committed, conflict, external, pending }
// While we wait, a refusal does NOT text the owner (the caller pivots instead);
// once we stop waiting, any later refusal alerts the owner as usual.
const UPSTREAM_WAIT_MS = 3500;
async function writeThroughNow(tenantId, booking, ctx){
  let waiting = true;
  try{
    const { enqueueUpstream, processOutbox, afterResponse } = await import('./booking-outbox.js');
    const c = db();
    const q = await enqueueUpstream(c, { tenantId, bookingId: booking.id, ctx });
    if(!q?.ok) return { pending: false };
    const send = async (m) => { if(waiting) return { skipped: true, reason: 'caller_pivoting' }; const { sendSms } = await import('./sms.js'); return sendSms(m); };
    const run = processOutbox(c, { bookingId: booking.id, send });
    afterResponse(run);
    const out = await Promise.race([run.catch(() => null), new Promise(r => setTimeout(() => r(null), UPSTREAM_WAIT_MS))]);
    const res = (out?.results || []).find(x => x.op === 'create' || !x.op) || null;
    if(res?.done) return { committed: true, external: res.external };
    if(res?.failed && res.conflict) return { conflict: true, error: res.error };
    return { pending: !res || res.retry_in_min != null };
  }catch(e){ console.warn('[booking-brain] write-through:', String(e?.message||e).slice(0,160)); return { pending: true }; }
  finally{ waiting = false; }
}

// Undo a local booking the salon's platform just refused (the caller is offered
// another time instead) — silent: the client was never told it was booked.
async function withdrawBooking(tenantId, booking, channel){
  try{ await repo.updateCanonicalBooking(tenantId, booking.id, { status: 'cancelled' }, { source: channel, reason: 'upstream_conflict', sendCancellation: false, upstream: false }); }
  catch(e){ console.warn('[booking-brain] withdraw failed:', e?.message || e); }
}

// The client is told once everything held: text + deposit request (same
// contract createCanonicalBooking uses when it confirms inline).
function confirmBooked(tenantId, booking){
  sendConfirmationSMS({ tenantId, clientId: booking.client_id, serviceId: booking.service_id, startTime: booking.start_time, confirmationCode: booking.confirmation_code }).catch(() => {});
  requestDeposit({ tenantId, booking, policy: null }).catch(() => {});
}

const ACTIVE = (b) => !/^(cancel|no[-_ ]?show)/i.test(String(b?.status || ''));
async function overlappingActive(tenantId, startIso, endIso, excludeId = null){
  const c = db(); if(!c) return [];
  const { data } = await c.from('bookings').select('id,status,start_time,end_time,created_at,staff_id').eq('tenant_id', tenantId).lt('start_time', endIso);
  return (data || []).filter(b => ACTIVE(b) && b.id !== excludeId && new Date(b.end_time || addMin(b.start_time, 60)).getTime() > new Date(startIso).getTime());
}

export async function bookAppointment(tenant, params, opts = {}){
  const tenantId = tenant.id;
  const channel = opts.channel || 'lola';
  const conversationId = opts.conversationId || null;
  try{
    const resolved = await resolveServiceAndStaff(tenant, params);
    if(!resolved.ok) return { ok: false, needs: resolved.needs, speak: resolved.speak, options: resolved.candidates || [] };

    const hasContact = params.client_phone || params.phone || params.client_name || params.name || params.client_email || params.email;
    if(!hasContact) return { ok: false, needs: 'client_phone', speak: "What's the best phone number for the appointment?" };

    const tz = await salonTz(tenantId);
    const startsAt = startsAtFromParams(params, { tz });
    // No time given → ask. (It used to quietly become 10:00 server time.)
    if(!startsAt) return { ok: false, needs: 'time', speak: `What time would you like${params.date ? ` on ${dayLabel(resolveDateKey(params.date, tz) || params.date, tz)}` : ''}?` };

    const client = await resolveClient(tenantId, params, true);
    if(!client?.id) return { ok: false, needs: 'client_phone', speak: "What's the best phone number for the appointment?" };

    let insights = null;
    try{ insights = await crm.getClientInsights(client.id, tenantId); }catch{}

    // JSON-service legacy path: no calendar rows yet. Still conflict-checked:
    // one client per chair (the onboarded team size) at any moment.
    if(resolved.jsonService){
      const svc = resolved.service;
      const duration = Math.max(15, Number(svc.duration_minutes || 60));
      const endsAt = addMin(startsAt, duration);
      const chairs = Math.max(1, Array.isArray(tenant.team) ? tenant.team.length : 0);
      const taken = () => ({ ok: false, conflict: true, needs: 'alternate_time', speak: `That time is already booked — what other time works for you?`, alternatives: [] });
      if((await overlappingActive(tenantId, startsAt, endsAt)).length >= chairs) return taken();
      const booking = await repo.createCanonicalBooking({
        tenantId, clientId: client.id, serviceId: null, staffId: null,
        startTime: startsAt, endTime: endsAt, status: 'confirmed',
        totalAmount: Number(svc.price || 0), notes: params.notes || null,
        source: channel, conversationId, holdId: null, sendConfirmation: false
      });
      // Re-check after insert: a racer that landed first keeps the chair.
      const mineAt = new Date(booking.created_at || Date.now()).getTime();
      const earlier = (await overlappingActive(tenantId, startsAt, endsAt, booking.id)).filter(b => {
        const t = new Date(b.created_at || 0).getTime();
        return t < mineAt || (t === mineAt && String(b.id) < String(booking.id));
      });
      if(earlier.length >= chairs){ await withdrawBooking(tenantId, booking, channel); return taken(); }
      confirmBooked(tenantId, booking);
      await logEvent(tenantId, 'booking_created', { booking_id: booking.id, client_id: client.id, service: svc.name, at: startsAt });
      const when = `${dayLabel(startsAt, tz)} at ${timeLabel(startsAt, tz)}`;
      const speak = `Perfect${client.name ? `, ${first(client.name)}` : ''}. You're booked for ${svc.name} on ${when}.`;
      return { ok: true, booked: true, booking, speak, text: speak };
    }

    // Smart path: hold the slot atomically (checks real availability), then commit.
    let selected = resolved.staff, held = null;
    const candidates = resolved.staffResult?.candidates || [];
    if(selected){
      held = await holdAvailability({ tenantId, clientId: client.id, serviceId: resolved.service.id, staffId: selected.id, startsAt, channel, conversationId, ttlSeconds: 120 });
    } else if(candidates.length){
      for(const cand of candidates){
        const attempt = await holdAvailability({ tenantId, clientId: client.id, serviceId: resolved.service.id, staffId: cand.id, startsAt, channel, conversationId, ttlSeconds: 120 });
        if(attempt.ok){ selected = cand; held = attempt; break; }
      }
    } else {
      return { ok: false, needs: 'staff', speak: 'I can check that once your team is on the calendar — which stylist were you thinking?', options: [] };
    }
    const pivot = async (lead) => {
      const alt = await getAvailability({ tenantId, serviceId: resolved.service.id, date: startsAt, limit: 5 }).catch(() => ({ ok: false, slots: [] }));
      const hint = alt.ok && alt.slots.length ? ` I could do ${timeLabel(alt.slots[0].starts_at, tz)}.` : '';
      return { ok: false, conflict: true, needs: 'alternate_time', speak: `${lead}${hint} Want me to grab the closest opening?`, alternatives: alt.slots || [] };
    };
    if(!held?.ok) return pivot('That time just got taken.');

    const services = await repo.listServices(tenantId);
    const svcRow = services.find(s => s.id === resolved.service.id) || resolved.service;

    // ── LOCAL FIRST: the booking is saved in LolaDesk before anything else,
    // so a salon-platform hiccup can never lose it. Claimed from the hold
    // exactly once. The text + deposit go out after the platform answers.
    const saved = await repo.bookFromHold(tenantId, held.hold, {
      clientId: client.id, serviceId: resolved.service.id, staffId: selected.id,
      startTime: held.slot.starts_at, endTime: held.slot.ends_at, status: 'confirmed',
      totalAmount: held.slot.price ?? svcRow.price ?? 0, notes: params.notes || null,
      source: channel, conversationId, sendConfirmation: false
    });
    if(!saved.ok) return pivot('That time just got taken.');
    let booking = saved.booking;

    // ── WRITE-THROUGH to the salon's booking platform (durable outbox). A
    // refusal while the caller is still on the line ("409, already booked
    // there") withdraws the local booking and pivots — the blueprint's
    // conflict protocol. Anything slower or transient keeps the booking and
    // the outbox retries (owner alerted if it finally can't land).
    const up = await writeThroughNow(tenantId, booking, {
      bookingId: booking.id, client, service: svcRow, staff: selected,
      startsAt: held.slot.starts_at, endsAt: held.slot.ends_at,
      durationMin: held.slot.duration_minutes, notes: params.notes || null,
      price: held.slot.price ?? svcRow.price ?? 0, timezone: held.slot.time_zone || tz
    });
    if(up.conflict){
      await withdrawBooking(tenantId, booking, channel);
      await logEvent(tenantId, 'external_conflict', { time: held.slot.starts_at });
      return pivot('That slot just filled up a second ago.');
    }
    if(up.committed && up.external?.id){
      booking = { ...booking, external_id: up.external.id, external_provider: up.external.provider };
      await logEvent(tenantId, 'external_commit', { provider: up.external.provider, external_id: up.external.id });
    }
    confirmBooked(tenantId, booking);

    await logEvent(tenantId, 'booking_created', { booking_id: booking.id, client_id: client.id, service: svcRow.name, staff: selected.name, at: booking.start_time });
    try{ await crm.updateClientFromConversation(client.id, tenantId, { intent: 'booking_completed', channel, summary: `Booked ${svcRow.name} with ${selected.name}` }); }catch{}

    const returning = insights && insights.total_bookings > 1;
    const when = `${dayLabel(booking.start_time, tz)} at ${timeLabel(booking.start_time, tz)}`;
    const speak = `${returning ? `Welcome back${client.name ? `, ${first(client.name)}` : ''}. ` : `Perfect${client.name ? `, ${first(client.name)}` : ''}. `}You're with ${selected.name} for ${svcRow.name || 'your appointment'} on ${when}. I'll text you the confirmation.`;
    const text = `Booked at ${tenant.name}: ${svcRow.name || 'Appointment'} with ${selected.name} on ${when}.`;
    return { ok: true, booked: true, booking, speak, text };
  }catch(e){
    console.error('[booking-brain] bookAppointment failed:', e);
    return { ok: false, error: 'booking_failed', speak: "I hit a snag locking that in. Give me another time and I'll take care of it." };
  }
}

export async function rescheduleAppointment(tenant, params, opts = {}){
  const tenantId = tenant.id, channel = opts.channel || 'lola', conversationId = opts.conversationId || null;
  try{
    const current = await getBookingRow(tenantId, params.booking_id);
    if(!current) return { ok: false, error: 'booking_not_found', speak: "I couldn't find that appointment." };
    const tz = await salonTz(tenantId);
    const curStart = current.start_time || current.starts_at;
    const newStart = startsAtFromParams(params, { fallbackIso: curStart || null, tz });
    if(!newStart) return { ok: false, needs: 'time', speak: 'What time should I move it to?' };
    // The booking keeps its REAL length (a 2h colour stays 2h when it moves).
    const lenMin = current.end_time && curStart ? Math.round((new Date(current.end_time) - new Date(curStart)) / 60000) : null;

    let serviceId = current.service_id || null;
    let staffId = params.staff_id || current.staff_id || null;
    if(!serviceId || !staffId){
      const resolved = await resolveBookingRequest(tenantId, { service: params.service || current.service, stylist: params.stylist || current.stylist });
      if(resolved.ok){ serviceId = resolved.service.id; if(!staffId) staffId = resolved.staff?.id || null; }
    }

    if(serviceId && staffId){
      // excludeBookingId: the booking being moved never blocks its own new time.
      const held = await holdAvailability({ tenantId, clientId: current.client_id, serviceId, staffId, startsAt: newStart, channel, conversationId, ttlSeconds: 120, excludeBookingId: current.id, minDurationMin: lenMin });
      if(held.ok){
        const patch = { start_time: held.slot.starts_at, end_time: held.slot.ends_at, duration_min: held.slot.duration_minutes };
        if(params.staff_id) patch.staff_id = params.staff_id;
        // One history row (updateCanonicalBooking writes it when status changes;
        // a pure move is recorded there as the reschedule reason).
        const booking = await repo.updateCanonicalBooking(tenantId, current.id, patch, { source: channel, reason: 'rescheduled' });
        await repo.releaseHold(tenantId, held.hold.hold_token, 'converted');
        await logEvent(tenantId, 'booking_rescheduled', { booking_id: current.id, from: curStart, to: held.slot.starts_at });
        // The OLD slot just freed up — offer it to a consenting waitlisted client.
        let offer = null;
        try{
          offer = await offerFreedSlot({ tenantId, serviceId: current.service_id || serviceId, serviceName: params.service || current.service || null, freedAt: curStart });
          if(offer && offer.ok) await logEvent(tenantId, 'waitlist_offered', { client: offer.entry?.client_name || offer.entry?.client_phone, freed_by: 'reschedule' });
        }catch(e){ console.warn('[booking-brain] waitlist offer failed:', e.message); }
        const speak = `Done — moved to ${dayLabel(held.slot.starts_at, tz)} at ${timeLabel(held.slot.starts_at, tz)}.`;
        return { ok: true, rescheduled: true, booking, waitlist_offer: offer, speak, text: speak };
      }
      const alt = await getAvailability({ tenantId, serviceId, date: newStart, limit: 5, excludeBookingId: current.id }).catch(() => ({ ok: false, slots: [] }));
      return { ok: false, conflict: true, needs: 'alternate_time', speak: `That time is taken — I could do ${alt.slots?.[0] ? timeLabel(alt.slots[0].starts_at, tz) : 'a different time'}. Want me to?`, alternatives: alt.slots || [] };
    }

    // Legacy row without canonical ids: no engine check possible — move it
    // through the canonical update (history, text, upstream), keeping its length.
    const booking = await moveBooking(tenantId, current.id, newStart, { source: channel });
    if(!booking) return { ok: false, error: 'move_failed', speak: "I couldn't move that appointment." };
    await logEvent(tenantId, 'booking_rescheduled', { booking_id: current.id, from: curStart, to: newStart, legacy: true });
    return { ok: true, rescheduled: true, booking, speak: `Done — moved to ${dayLabel(newStart, tz)} at ${timeLabel(newStart, tz)}.` };
  }catch(e){
    console.error('[booking-brain] reschedule failed:', e);
    return { ok: false, error: 'reschedule_failed', speak: "I hit a snag moving that — try again." };
  }
}

export async function cancelAppointment(tenant, params, opts = {}){
  const tenantId = tenant.id, channel = opts.channel || 'lola';
  try{
    const current = await getBookingRow(tenantId, params.booking_id);
    if(!current) return { ok: false, error: 'booking_not_found', speak: "I couldn't find that appointment." };
    const booking = await repo.updateCanonicalBooking(tenantId, current.id, { status: 'cancelled' }, { source: channel, reason: params.reason || 'client_request' });
    if(!booking) return { ok: false, error: 'cancel_failed', speak: "I couldn't cancel that appointment." };
    await logEvent(tenantId, 'booking_cancelled', { booking_id: current.id, was: current.status, reason: params.reason || null, at: new Date().toISOString() });

    // Revenue recovery: a freed slot has a value. Surface the waitlist so the
    // salon can offer it instead of letting the opening walk. The canonical
    // bookings table stores service_id only, so resolve the name for matching.
    let waitlist = { count: 0, entries: [] };
    let freedServiceName = current.service || current.service_name || null;
    try{
      if(!freedServiceName && current.service_id){
        const services = await repo.listServices(tenantId);
        freedServiceName = services.find(s => s.id === current.service_id)?.name || null;
      }
      waitlist = await repo.findWaitlistMatches(tenantId, {
        serviceId: current.service_id || null,
        serviceName: freedServiceName
      });
      if(waitlist.count) await logEvent(tenantId, 'waitlist_opportunity', { count: waitlist.count, freed: current.start_time || current.starts_at, service: freedServiceName });
    }catch(e){ console.warn('[booking-brain] waitlist check failed:', e.message); }

    // Demand conversion: text the first consenting waitlisted client.
    let offer = null;
    try{
      offer = await offerFreedSlot({ tenantId, serviceId: current.service_id || null, serviceName: freedServiceName, freedAt: current.start_time || current.starts_at });
      if(offer && offer.ok) await logEvent(tenantId, 'waitlist_offered', { client: offer.entry?.client_name || offer.entry?.client_phone, at: current.start_time || current.starts_at });
    }catch(e){ console.warn('[booking-brain] waitlist offer failed:', e.message); }

    const speak = waitlist.count
      ? offer && offer.ok
        ? `Cancelled — I'll free up that slot and I've texted the first person on the waitlist.`
        : `Cancelled — I'll free up that slot. ${waitlist.count} client${waitlist.count === 1 ? ' is' : 's are'} on the waitlist for ${freedServiceName || 'that service'}.`
      : "Cancelled — I'll free up that slot.";
    return { ok: true, cancelled: true, booking, waitlist_matches: waitlist, waitlist_offer: offer, speak, text: 'Cancelled.' };
  }catch(e){
    console.error('[booking-brain] cancel failed:', e);
    return { ok: false, error: 'cancel_failed', speak: "I hit a snag cancelling that — try again." };
  }
}

// Put a caller on the priority waitlist for real. This is the fulfillment of
// the legacy skill-layer promise ("I'll add you to the priority waitlist") —
// the row lands in booking_waitlist and the dashboard surfaces it.
export async function waitlistAdd(tenant, params, opts = {}){
  const tenantId = tenant.id, channel = opts.channel || 'lola';
  try{
    let client = null;
    try{
      client = await resolveClient(tenantId, params, true);
    }catch{}
    let serviceId = params.service_id || null, serviceName = params.service || params.service_name || null;
    if(!serviceId && serviceName){
      const resolved = await resolveServiceAndStaff(tenant, params).catch(() => ({ ok:false }));
      if(resolved && resolved.ok && resolved.service) serviceId = resolved.service.id;
    }
    const consent = params.sms_consent === true || params.sms_consent === 'true';
    const entry = await repo.addToWaitlist({
      tenantId,
      clientId: client?.id || null,
      clientName: client?.name || params.client_name || params.name || null,
      clientPhone: client?.phone || params.client_phone || params.phone || null,
      serviceId, serviceName,
      staffId: params.staff_id || null,
      preferredDate: params.preferred_date || params.date || null,
      preferredTime: params.preferred_time || params.time || null,
      notes: params.notes || null,
      source: channel,
      smsConsent: consent
    });
    await logEvent(tenantId, 'waitlist_added', { client_id: client?.id || null, service: serviceName, date: params.date || null, sms_consent: consent });
    const who = client?.name || params.client_name || params.name;
    const svc = serviceName ? ` for ${serviceName}` : '';
    const promise = consent ? " I'll text you the moment a slot opens." : " Check back with me for the earliest opening.";
    const speak = who
      ? `Done${who ? `, ${first(who)}` : ''}. You're on ${tenant.name || 'the salon'}'s priority waitlist${svc}.${promise}`
      : `You're on ${tenant.name || 'the salon'}'s priority waitlist${svc}.${promise}`;
    return { ok: true, waitlisted: true, entry, sms_consent: consent, speak, text: speak };
  }catch(e){
    console.error('[booking-brain] waitlist failed:', e);
    return { ok: false, error: 'waitlist_failed', speak: "I couldn't add you to the waitlist just now — try again in a moment." };
  }
}

// Owner day view — same shape operator-tools used, now served from here.
// "tomorrow" is the salon's tomorrow; times are spoken on the salon's clock.
export async function getDay(tenant, params){
  const tz = await salonTz(tenant.id);
  const date = resolveDateKey(params.date, tz) || localDateKey(new Date(), tz);
  const rows = await enrichBookings(tenant.id, await listBookings(tenant.id, { from: date, to: date, tz }));
  if(!rows.length) return { ok: true, count: 0, appointments: [], speak: `Nothing on the books for ${dayLabel(date, tz)} yet.` };
  const lines = rows.map(b => `${timeLabel(b.starts_at, tz)} ${b.service}${b.client_name ? ` for ${first(b.client_name)}` : ''}${b.stylist ? ` with ${b.stylist}` : ''}`);
  return { ok: true, count: rows.length, appointments: rows, speak: `${rows.length} on ${dayLabel(date, tz)}: ${lines.join('; ')}.` };
}

// ── unified dispatch for every transport ────────────────────────────
export const BOOKING_ACTIONS = {
  check_availability: checkAvailability,
  book_appointment: bookAppointment,
  reschedule_appointment: rescheduleAppointment,
  cancel_appointment: cancelAppointment,
  waitlist_add: waitlistAdd,
  get_day: getDay,
  remember,
  recall
};

export async function runBookingAction(action, tenant, params = {}, opts = {}){
  const fn = BOOKING_ACTIONS[action];
  if(!fn) return { ok: false, error: 'unsupported_action', speak: "I can't do that right now." };
  if(!tenant?.id) return { ok: false, error: 'tenant_required', speak: "I couldn't tell which salon this is." };

  // Trial-to-paid gate: expired/suspended tenants cannot create new bookings
  // (or check availability / reschedule). Cancels stay open so clients are
  // never stranded. Owner-facing channels get the upgrade prompt; callers
  // get a graceful decline that never reveals billing state.
  if(BLOCKED_BOOKING_ACTIONS.has(action)){
    const gate = bookingGateResponse(tenant, opts.channel);
    if(gate) return gate;
  }

  return fn(tenant, params, opts);
}

export default {
  runBookingAction, BOOKING_ACTIONS,
  checkAvailability, bookAppointment, rescheduleAppointment, cancelAppointment, waitlistAdd, getDay,
  remember, recall, tenantMemoryBlock
};
