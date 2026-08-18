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
import { writeAppointment } from './aggregator.js';
import { listBookings, enrichBookings, resolveDate, to24, moveBooking } from './operator-db.js';
import { bookingGateResponse, BLOCKED_BOOKING_ACTIONS } from './billing-gate.js';

// Providers Lola can WRITE appointments to. boulevard (partner sandbox) and
// shopify (retail only) deliberately excluded; google_calendar is a sync
// target, not a booking source of truth, so committing there would duplicate.
const BOOKING_PROVIDERS = ['square', 'vagaro', 'mindbody', 'fresha', 'booksy'];

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

async function commitToExternalProvider(tenantId, ctx){
  let integrations = [];
  try{ integrations = await getTenantIntegrations(tenantId); }
  catch(e){ return { ok:false, skipped:true, error:`integrations unavailable: ${e?.message||e}` }; }
  const targets = integrations.filter(i => BOOKING_PROVIDERS.includes(i.provider));
  if(!targets.length) return { ok:false, skipped:true };
  const provider = targets[0].provider;

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
    return { ok:false, conflict: CONFLICT_RE.test(msg), error: msg };
  }
}

// ── small helpers ──────────────────────────────────────────────────
const timeLabel = iso => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const dayLabel = d => new Date(d).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
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

async function startsAtFromParams(params, fallbackIso){
  if(params.starts_at) return new Date(params.starts_at).toISOString();
  const d = params.date ? resolveDate(params.date) : new Date(fallbackIso || Date.now());
  const [h, m] = to24(params.time).split(':');
  d.setHours(+h, +m, 0, 0);
  return d.toISOString();
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

// Keep the legacy operator read path working: canonical rows also carry the
// legacy text columns the older dashboards select.
async function writeLegacyCompat(tenantId, bookingId, { serviceName, staffName, startsAt, durationMin, price }){
  const c = db(); if(!c) return;
  try{
    await c.from('bookings').update({
      service: serviceName || null,
      stylist: staffName || null,
      starts_at: startsAt,
      duration_min: durationMin,
      price
    }).eq('tenant_id', tenantId).eq('id', bookingId);
  }catch(e){ console.warn('[booking-brain] legacy compat write failed:', e.message); }
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
export async function checkAvailability(tenant, params){
  const resolved = await resolveServiceAndStaff(tenant, params);
  if(!resolved.ok) return resolved;
  if(resolved.jsonService) return { ok: false, error: 'json_service', speak: "That service isn't on the smart calendar yet." };
  const av = await getAvailability({
    tenantId: tenant.id, serviceId: resolved.service.id,
    date: params.date || params.starts_at || new Date().toISOString(),
    staffId: params.staff_id || resolved.staff?.id || null,
    limit: Number(params.limit || 12)
  });
  if(!av.ok) return { ok: false, error: av.error, speak: "I couldn't check that right now." };
  const names = av.slots.slice(0, 4).map(s => `${timeLabel(s.starts_at)}${s.staff_name ? ` with ${first(s.staff_name)}` : ''}`);
  const speak = av.slots.length
    ? `I have ${av.slots.length} opening${av.slots.length === 1 ? '' : 's'}${names.length ? `: ${names.join(', ')}` : ''}.`
    : `That day looks full — want me to try a different day?`;
  return { ok: true, slots: av.slots, service: av.service, settings: av.settings, speak, text: speak };
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

    const client = await resolveClient(tenantId, params, true);
    if(!client?.id) return { ok: false, needs: 'client_phone', speak: "What's the best phone number for the appointment?" };

    let insights = null;
    try{ insights = await crm.getClientInsights(client.id, tenantId); }catch{}

    const startsAt = await startsAtFromParams(params);

    // JSON-service legacy path: no calendar rows yet, book directly.
    if(resolved.jsonService){
      const svc = resolved.service;
      const duration = Math.max(15, Number(svc.duration_minutes || 60));
      const booking = await repo.createCanonicalBooking({
        tenantId, clientId: client.id, serviceId: null, staffId: null,
        startTime: startsAt, endTime: addMin(startsAt, duration), status: 'confirmed',
        totalAmount: Number(svc.price || 0), notes: params.notes || null,
        source: channel, conversationId, holdId: null
      });
      await writeLegacyCompat(tenantId, booking.id, { serviceName: svc.name, staffName: resolved.staff?.name || null, startsAt, durationMin: duration, price: Number(svc.price || 0) });
      await logEvent(tenantId, 'booking_created', { booking_id: booking.id, client_id: client.id, service: svc.name, at: startsAt });
      const when = `${dayLabel(startsAt)} at ${timeLabel(startsAt)}`;
      const speak = `Perfect${client.name ? `, ${first(client.name)}` : ''}. You're booked for ${svc.name} on ${when}.`;
      return { ok: true, booked: true, booking, speak, text: speak };
    }

    // Smart path: hold the slot (checks real availability), then commit.
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
    if(!held?.ok){
      const alt = await getAvailability({ tenantId, serviceId: resolved.service.id, date: startsAt, limit: 5 }).catch(() => ({ ok: false, slots: [] }));
      const hint = alt.ok && alt.slots.length ? ` I could do ${timeLabel(alt.slots[0].starts_at)}.` : '';
      return { ok: false, conflict: true, needs: 'alternate_time', speak: `That time just got taken.${hint} Want me to grab the closest opening?`, alternatives: alt.slots || [] };
    }

    const services = await repo.listServices(tenantId);
    const svcRow = services.find(s => s.id === resolved.service.id) || resolved.service;

    // ── EXTERNAL COMMIT: push to the connected booking provider ──
    // The local hold is already taken; now the appointment must LAND on
    // Square/Vagaro/etc. If the provider rejects it as already taken (409),
    // release the hold and pivot to the closest openings — exactly the
    // blueprint's conflict protocol. Any other failure (auth, network) keeps
    // the booking local so the caller is never left unbooked; it's logged.
    let externalRef = null;
    const commit = await commitToExternalProvider(tenantId, {
      client, service: svcRow, staff: selected,
      startsAt: held.slot.starts_at, endsAt: held.slot.ends_at,
      durationMin: held.slot.duration_minutes, notes: params.notes || null,
      price: held.slot.price ?? svcRow.price ?? 0, timezone: held.slot.time_zone
    }).catch(e => ({ ok:false, conflict:false, error:String(e?.message||e) }));

    if(commit?.conflict){
      await repo.releaseHold(tenantId, held.hold.hold_token, 'released');
      await logEvent(tenantId, 'external_conflict', { provider: commit.provider || 'provider', time: held.slot.starts_at });
      const alt = await getAvailability({ tenantId, serviceId: resolved.service.id, date: startsAt, limit: 5 }).catch(() => ({ ok:false, slots: [] }));
      const hint = alt.ok && alt.slots.length ? ` I could do ${timeLabel(alt.slots[0].starts_at)}.` : '';
      return { ok:false, conflict:true, needs:'alternate_time', speak:`That slot just filled up a second ago.${hint} Want me to grab the closest opening?`, alternatives: alt.slots || [] };
    }
    if(commit?.ok) externalRef = commit.external;
    else if(commit && !commit.skipped) console.warn('[booking-brain] external commit failed — booking kept local:', commit.error);

    const booking = await repo.createCanonicalBooking({
      tenantId, clientId: client.id, serviceId: resolved.service.id, staffId: selected.id,
      startTime: held.slot.starts_at, endTime: held.slot.ends_at, status: 'confirmed',
      totalAmount: held.slot.price ?? svcRow.price ?? 0, notes: params.notes || null,
      source: channel, conversationId, holdId: held.hold.id,
      externalId: externalRef?.id || null, externalSource: externalRef?.provider || null
    });
    await repo.releaseHold(tenantId, held.hold.hold_token, 'converted');
    if(externalRef){
      try{
        await repo.upsertProviderMapping({ tenantId, provider: externalRef.provider, entityType:'booking', localId: booking.id, externalId: externalRef.id, metadata:{ starts_at: booking.start_time } });
      }catch{}
      await logEvent(tenantId, 'external_commit', { provider: externalRef.provider, external_id: externalRef.id });
    }
    await writeLegacyCompat(tenantId, booking.id, { serviceName: svcRow.name || resolved.service.name, staffName: selected.name, startsAt: booking.start_time, durationMin: held.slot.duration_minutes, price: booking.total_amount });

    await logEvent(tenantId, 'booking_created', { booking_id: booking.id, client_id: client.id, service: svcRow.name, staff: selected.name, at: booking.start_time });
    try{ await crm.updateClientFromConversation(client.id, tenantId, { intent: 'booking_completed', channel, summary: `Booked ${svcRow.name} with ${selected.name}` }); }catch{}

    const returning = insights && insights.total_bookings > 1;
    const when = `${dayLabel(booking.start_time)} at ${timeLabel(booking.start_time)}`;
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
    const newStart = await startsAtFromParams(params, current.start_time || current.starts_at || Date.now());

    let serviceId = current.service_id || null;
    let staffId = params.staff_id || current.staff_id || null;
    if(!serviceId || !staffId){
      const resolved = await resolveBookingRequest(tenantId, { service: params.service || current.service, stylist: params.stylist || current.stylist });
      if(resolved.ok){ serviceId = resolved.service.id; if(!staffId) staffId = resolved.staff?.id || null; }
    }

    if(serviceId && staffId){
      const held = await holdAvailability({ tenantId, clientId: current.client_id, serviceId, staffId, startsAt: newStart, channel, conversationId, ttlSeconds: 120 });
      if(held.ok){
        const patch = { start_time: held.slot.starts_at, end_time: held.slot.ends_at, starts_at: held.slot.starts_at, duration_min: held.slot.duration_minutes };
        if(params.staff_id) patch.staff_id = params.staff_id;
        const booking = await repo.updateCanonicalBooking(tenantId, current.id, patch, { source: channel, reason: 'rescheduled' });
        await repo.appendBookingHistory({ tenantId, bookingId: current.id, fromStatus: current.status, toStatus: 'confirmed', source: channel, reason: 'rescheduled' });
        await repo.releaseHold(tenantId, held.hold.hold_token, 'converted');
        await writeLegacyCompat(tenantId, current.id, { serviceName: current.service, staffName: current.stylist, startsAt: held.slot.starts_at, durationMin: held.slot.duration_minutes, price: current.total_amount ?? current.price });
        await logEvent(tenantId, 'booking_rescheduled', { booking_id: current.id, from: current.start_time || current.starts_at, to: held.slot.starts_at });
        const speak = `Done — moved to ${dayLabel(held.slot.starts_at)} at ${timeLabel(held.slot.starts_at)}.`;
        return { ok: true, rescheduled: true, booking, speak, text: speak };
      }
      const alt = await getAvailability({ tenantId, serviceId, date: newStart, limit: 5 }).catch(() => ({ ok: false, slots: [] }));
      return { ok: false, conflict: true, needs: 'alternate_time', speak: `That time is taken — I could do ${alt.slots?.[0] ? timeLabel(alt.slots[0].starts_at) : 'a different time'}. Want me to?`, alternatives: alt.slots || [] };
    }

    // Legacy row without canonical ids: move without an availability hold.
    const booking = await moveBooking(tenantId, current.id, newStart);
    if(!booking) return { ok: false, error: 'move_failed', speak: "I couldn't move that appointment." };
    await logEvent(tenantId, 'booking_rescheduled', { booking_id: current.id, from: current.starts_at, to: newStart, legacy: true });
    return { ok: true, rescheduled: true, booking, speak: `Done — moved to ${dayLabel(newStart)} at ${timeLabel(newStart)}.` };
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
    return { ok: true, cancelled: true, booking, speak: "Cancelled — I'll free up that slot.", text: 'Cancelled.' };
  }catch(e){
    console.error('[booking-brain] cancel failed:', e);
    return { ok: false, error: 'cancel_failed', speak: "I hit a snag cancelling that — try again." };
  }
}

// Owner day view — same shape operator-tools used, now served from here.
export async function getDay(tenant, params){
  const date = resolveDate(params.date);
  const rows = await enrichBookings(tenant.id, await listBookings(tenant.id, { from: date, to: date }));
  if(!rows.length) return { ok: true, count: 0, appointments: [], speak: `Nothing on the books for ${dayLabel(date)} yet.` };
  const lines = rows.map(b => `${timeLabel(b.starts_at)} ${b.service}${b.client_name ? ` for ${first(b.client_name)}` : ''}${b.stylist ? ` with ${b.stylist}` : ''}`);
  return { ok: true, count: rows.length, appointments: rows, speak: `${rows.length} on ${dayLabel(date)}: ${lines.join('; ')}.` };
}

// ── unified dispatch for every transport ────────────────────────────
export const BOOKING_ACTIONS = {
  check_availability: checkAvailability,
  book_appointment: bookAppointment,
  reschedule_appointment: rescheduleAppointment,
  cancel_appointment: cancelAppointment,
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
  checkAvailability, bookAppointment, rescheduleAppointment, cancelAppointment, getDay,
  remember, recall, tenantMemoryBlock
};
