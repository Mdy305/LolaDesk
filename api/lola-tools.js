/**
 * /api/lola-tools — The orchestral skill layer for Lola
 * ════════════════════════════════════════════════════════════════
 * ONE endpoint, MANY skills. Telnyx's Lola assistant calls this for
 * every action. The `tool` field selects the skill. Every call is
 * multi-tenant: we resolve the salon from the called number (or an
 * explicit tenant slug) so the same Lola serves every salon.
 *
 * SKILLS (the orchestra):
 *   check_availability   — open times for a service/day
 *   book_appointment     — write a confirmed booking
 *   confirm_booking      — confirm the next upcoming appointment
 *   reschedule_appointment — safely move an appointment
 *   cancel_appointment   — cancel an appointment
 *   capture_lead         — save contact when booking can't complete
 *   get_pricing          — price + duration for a service
 *   recommend_service    — suggest the right service from a goal
 *   list_services        — everything the salon offers
 *   handle_recovery      — win-back logic for lapsed clients
 *   escalate             — take a message / flag for human follow-up
 *
 * Telnyx Tool setup: POST https://www.loladesk.com/api/lola-tools
 *   body: { tool: "check_availability", to: "+1...", service: "...", date: "..." }
 *
 * Returns concise JSON Lola can speak back. Designed to never throw at
 * the caller — failures degrade to a graceful spoken fallback.
 */

import {
  getTenantByPhone, getTenantBySlug, upsertClient, getClientByPhone,
  logUsage, getOrStartConversation, getTenantIntegrations, db
} from './lib/db.js';
import { resolveInboundTenant } from './lib/tenant-resolver.js';
import { executeSkill, injectCallerMemory } from './lib/orchestrator.js';
import { cancelBookingSafe, createBookingSafe, listAvailability, parseDurationMin, rescheduleBookingSafe } from './lib/calendar-engine.js';
import { salonTz, fmtSalon } from './lib/salon-time.js';
import { zonedLocalToUtc } from './lib/timezone.js';
import { serviceGate } from './lib/paid-hooks.js';

// Resolve which salon this call is for. When a dialed `to` number is present
// (a Telnyx-originated call), resolution goes through the STRICT inbound
// resolver — the same gate every other inbound transport uses — so an
// unrecognized number can never slide into the demo salon's data. The
// legacy getTenantByPhone path is kept only for callers that pass no
// number at all (e.g. dashboard/slug-driven calls).
async function resolveTenant(body){
  // The salon comes ONLY from the number that was called. A `tenant` slug in
  // the body used to be trusted, which let anyone cancel/reschedule any
  // salon's bookings or read a caller's memory.
  const to = body.to || body.To || body.called_number || body.telnyx_agent_target || body.data?.payload?.telnyx_agent_target || '';
  const phone = to ? String(to).replace(/\D/g, '') : '';
  if(phone.length >= 8){
    const routing = await resolveInboundTenant({ to });
    if(routing.status === 'resolved') return routing.tenant;
    return null; // hard gate: unrouted number → no tenant, never demo data
  }
  return null;   // no called number → no salon (never fall back to demo data)
}

function findService(tenant, query){
  if(!query) return null;
  const q = String(query).toLowerCase();
  return (tenant.services||[]).find(s =>
    s.name.toLowerCase().includes(q) || q.includes(s.name.toLowerCase())
  );
}

// Resolve a service by its canonical services-table id (the blueprint's
// detect_upsell_opportunity(serviceId, …) signature). Falls back to the
// tenant.services jsonb when the services table has no row (legacy tenants).
async function findServiceById(tenant, id){
  const c = db();
  if(!c || !tenant?.id || !id) return null;
  const { data } = await c.from('services')
    .select('id,name,price,duration_minutes').eq('tenant_id', tenant.id).eq('id', id)
    .maybeSingle().then(r => r).catch(() => ({ data: null }));
  if(data) return { id: data.id, name: data.name, price: data.price, duration: data.duration_minutes };
  const tsvc = (tenant.services||[]).find(s => String(s.id||'') === String(id));
  return tsvc || null;
}

// ── SKILL: detect_upsell_opportunity (the Yield Engine's call-time arm) ──
// Deterministic, high-margin pairing: match the booked/known service to a
// complementary add-on and gate it by the caller's spend tier, so Lola can
// grow the ticket on every call — "Since you're coming in for a balayage,
// I'd add our restorative gloss…". No client identity is fine (pairing is
// service-driven); no base service is a clean no-op.
const UPSELL_PAIRS = [
  { match: /balayage|highlight|color|gloss|toner|root/i, addons: [
    { name: 'Restorative Gloss', price: 60, vip: false, pitch: 'it makes the color pop and keeps the tone fresh twice as long' },
    { name: 'Bond-Building Treatment', price: 45, vip: true, pitch: 'it protects your hair during the lightening process' }
  ] },
  { match: /cut|trim|shape/i, addons: [
    { name: 'Signature Blowout', price: 40, vip: false, pitch: 'it finishes the cut with a bouncy, salon-perfect style' },
    { name: 'Scalp Ritual', price: 35, vip: true, pitch: 'it relaxes the scalp and stimulates healthy growth' }
  ] },
  { match: /botox|keratin|smooth|relax/i, addons: [
    { name: 'Maintenance Gloss', price: 45, vip: false, pitch: 'it stretches your smoothing results by weeks' },
    { name: 'Leave-In Repair Serum', price: 28, vip: true, pitch: 'it defends the hair from heat and humidity daily' }
  ] },
  { match: /extension/i, addons: [
    { name: 'Extension Care Kit', price: 55, vip: false, pitch: 'it keeps the bonds secure and the hair silky between visits' },
    { name: 'Bond Touch-Up', price: 40, vip: true, pitch: 'it refreshes the attachment points so everything stays invisible' }
  ] },
  { match: /treatment|repair|condition|mask/i, addons: [
    { name: 'Deep Conditioning Mask', price: 35, vip: false, pitch: 'it doubles the repair power of the treatment' },
    { name: 'Scalp Therapy', price: 45, vip: true, pitch: 'it targets the root cause of stress-related thinning' }
  ] },
  { match: /blowout|style|updo/i, addons: [
    { name: 'Finishing Product Set', price: 30, vip: false, pitch: 'it recreates the look at home in minutes' },
    { name: 'Luxury Shine Mist', price: 25, vip: true, pitch: 'it adds that red-carpet reflection' }
  ] }
];
const DEFAULT_ADDONS = [
  { name: 'Deep Conditioning Mask', price: 35, vip: false, pitch: 'it leaves the hair feeling incredible' }
];

function spendTier(client, ltv){
  if(client?.is_vip || String(client?.status||'').toLowerCase() === 'vip') return 'vip';
  if(ltv != null && Number(ltv) >= 1000) return 'vip';
  if(ltv != null && Number(ltv) > 0) return 'regular';
  return 'new';
}

async function detect_upsell_opportunity(tenant, body){
  const { service, service_id, client_phone, from, client_id, client_ltv } = body || {};
  // 1. Resolve the booked/known base service (id first, then name).
  let base = service_id ? await findServiceById(tenant, service_id) : null;
  if(!base && service) base = findService(tenant, service);
  if(!base){
    return {
      speak: 'I can pair the perfect add-on once I know which service you are booking. Which one were you thinking?',
      base_service: null, recommended: [], reason: 'service_not_found'
    };
  }

  // 2. Resolve the caller's spend tier (explicit LTV, else the client row).
  let ltv = null;
  if(client_ltv != null && !Number.isNaN(Number(client_ltv))) ltv = Number(client_ltv);
  let client = null;
  const phone = client_phone || from;
  if(phone){
    try{ client = await getClientByPhone(tenant.id, phone); }catch{}
    if(client && ltv == null) ltv = Number(client.lifetime_value || 0);
  }
  const tier = spendTier(client, ltv);

  // 3. Deterministic pairing, gated by tier.
  const name = String(base.name || '').toLowerCase();
  const pair = UPSELL_PAIRS.find(p => p.match.test(name)) || null;
  const addons = (pair?.addons || DEFAULT_ADDONS);
  const recommended = addons.filter(a => (a.vip ? tier === 'vip' : true)).slice(0, 2);

  // 4. Speak it the way the blueprint's pitch example reads.
  let speak;
  if(recommended.length){
    const top = recommended[0];
    speak = `Since you're coming in for ${base.name}, I'd suggest adding our ${top.name} for $${top.price} — ${top.pitch}. Should I add that on?`;
  } else {
    speak = `I don't have an add-on pairing for ${base.name} yet, but I can recommend something the moment you pick your time.`;
  }
  try{ await logUsage(tenant.id, 'upsell_detected', 1, { service: base.name, tier, client_id: client?.id || null }); }catch{}
  return { speak, base_service: base.name, tier, client_known: !!client, ltv: ltv ?? null, recommended };
}

// ── SKILL: list everything offered ──
function list_services(tenant){
  const svc = (tenant.services||[]);
  if(!svc.length) return { speak: "Let me grab our service list for you — one moment.", services: [] };
  const spoken = svc.map(s => `${s.name}${s.price?` at $${s.price}`:''}`).join(', ');
  return { speak: `We offer ${spoken}.`, services: svc };
}

// ── SKILL: pricing for a service ──
function get_pricing(tenant, { service }){
  const s = findService(tenant, service);
  if(!s) return { speak: `I want to quote you exactly right — let me check on ${service||'that'} and confirm.`, found:false };
  return {
    speak: `${s.name} is ${s.price?`$${s.price}`:'priced at consultation'}${s.duration?`, about ${s.duration}`:''}.`,
    found:true, name:s.name, price:s.price, duration:s.duration
  };
}

// ── SKILL: recommend a service from a goal ──
function recommend_service(tenant, { goal }){
  const g = (goal||'').toLowerCase();
  const svc = (tenant.services||[]);
  let pick = null;
  if(/blonde|light|bright|sun|beach/.test(g)) pick = svc.find(s=>/balayage|highlight|blond/i.test(s.name));
  else if(/damage|repair|frizz|smooth/.test(g)) pick = svc.find(s=>/botox|keratin|treatment/i.test(s.name));
  else if(/length|fuller|volume/.test(g)) pick = svc.find(s=>/extension/i.test(s.name));
  else if(/trim|cut|shape/.test(g)) pick = svc.find(s=>/cut/i.test(s.name));
  else if(/event|quick|fresh/.test(g)) pick = svc.find(s=>/blowout|gloss/i.test(s.name));
  pick = pick || svc[0];
  if(!pick) return { speak: "Tell me a bit about what you're hoping for and I'll point you to the perfect service." };
  return {
    speak: `For that, I'd suggest ${pick.name}${pick.price?` — $${pick.price}`:''}. Want me to find you a time?`,
    recommended: pick.name
  };
}

// Tell the salon's own booking system (Boulevard via Zapier…) without making the caller wait.
async function zapNotice(tenant, bookingId, event){
  try{
    const [{ emitBooking }, { afterResponse }] = await Promise.all([import('./lib/zapier-bridge.js'), import('./lib/booking-outbox.js')]);
    afterResponse(emitBooking(db(), tenant, bookingId, event));
  }catch(_){}
}

// ── SKILL: check availability — the smart booking brain (lib/smart-slots.js) ──
// The time they asked for when it's free; otherwise the times that keep the salon's day packed
// (no unsellable holes), with their usual stylist first; a full day rolls to the next days.
const sameDay = (a, b, tz) => fmtSalon(a, tz, 'long').split(',').slice(0, 2).join() === fmtSalon(b, tz, 'long').split(',').slice(0, 2).join();
function dayWord(iso, tz){
  const now = new Date();
  if(sameDay(iso, now, tz)) return 'today';
  if(sameDay(iso, new Date(now.getTime() + 86400000), tz)) return 'tomorrow';
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: tz });
}
const orList = (xs) => xs.length <= 1 ? (xs[0] || '') : xs.slice(0, -1).join(', ') + ' or ' + xs[xs.length - 1];
async function smartOffers(tenant, { service, date, time, stylist, client_phone, exclude_booking_id }){
  const { resolveServiceId, resolveStaffId } = await import('./lib/calendar-engine.js');
  const serviceId = service ? await resolveServiceId(tenant.id, service) : null;
  let sid = serviceId;
  if(!sid){ try{ const { data } = await db().from('services').select('id').eq('tenant_id', tenant.id).eq('is_active', true).limit(1); sid = data?.[0]?.id || null; }catch(_){} }
  if(!sid) return null;
  const staffId = stylist ? await resolveStaffId(tenant.id, stylist) : null;
  let clientId = null;
  if(client_phone){ try{ clientId = (await getClientByPhone(tenant.id, client_phone))?.id || null; }catch(_){} }
  const wantAt = (date && time) ? await salonInstant(tenant, date, time) : null;
  const { findSmartSlots } = await import('./lib/smart-slots.js');
  return findSmartSlots({ tenantId: tenant.id, serviceId: sid, date: date || null, wantAt, staffId, clientId, excludeBookingId: exclude_booking_id || null, tz: await salonTz(tenant.id) });
}
function speakOffers(r, { service, askedTime, askedDay, stylist, tz }){
  const offers = r.offers || [];
  const times = offers.map(s => fmtSalon(s.starts_at, tz, 'time').replace(/:00(?=\s?[AP]M)/, ''));
  const day = offers[0] ? dayWord(offers[0].starts_at, tz) : '';
  const who = (s) => s.staff_name && !stylist ? ` with ${String(s.staff_name).split(' ')[0]}` : '';
  if(r.exact) return `Yes — ${times[0]} ${day} works${who(offers[0])}. Want me to book it?`;
  if(askedTime && r.rolled_days === 0) return `${askedTime} is taken — the closest I have ${day} is ${orList(times)}. Which works?`;
  if(r.rolled_days > 0) return `${askedDay ? askedDay[0].toUpperCase() + askedDay.slice(1) + ' is' : 'Today is'} fully booked${stylist ? ' for ' + stylist : ''} — the next openings are ${day} at ${orList(times)}. Want one of those?`;
  return `${day[0].toUpperCase() + day.slice(1)} I can do ${orList(times)}${service ? ` for ${service}` : ''}. Which one do you want?`;
}

// ── The salon's live booking system (Boulevard today; any connector with META.live): availability is
// asked of that system and bookings are made + verified there — lib/live-booking.js. Same Lola, same words.
async function liveFor(tenant){
  try{ const { liveProviderFor } = await import('./lib/live-booking.js'); return await liveProviderFor(tenant.id); }catch(_){ return null; }
}
function dateKeyIn(date, tz){
  return resolveDateKey(date, tz);
}
const spokenTime = (iso, tz) => fmtSalon(iso, tz, 'time').replace(/:00(?=\s?[AP]M)/, '');
function pickTimes(times, wantAt = null, n = 3){
  const list = [...(times || [])];
  if(wantAt) return list.sort((x, y) => Math.abs(Date.parse(x.startTime) - Date.parse(wantAt)) - Math.abs(Date.parse(y.startTime) - Date.parse(wantAt))).slice(0, n).sort((x, y) => Date.parse(x.startTime) - Date.parse(y.startTime));
  if(list.length > n){ const step = list.length / n; return Array.from({ length: n }, (_, i) => list[Math.floor(i * step)]); }
  return list;
}
async function passToSalon(tenant, who, body){
  try{ await capture_lead(tenant, { client_name: who?.name || body.client_name, client_phone: who?.phone || body.client_phone, service_requested: `${body.service || 'appointment'} ${body.date || ''} ${body.time || ''}`.trim() }); }catch(_){}
}
async function check_availability_live(tenant, lp, body){
  const { service, date, time, stylist } = body || {};
  const tz = lp.integration?.metadata?.tz || await salonTz(tenant.id);
  const day = dateKeyIn(date, tz) || new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const wantAt = time ? await salonInstant(tenant, day, time) : null;
  const { liveCheck } = await import('./lib/live-booking.js');
  const r = await liveCheck(lp, { service: service || '', date: day, wantAt, stylist, tz });
  if(!r.ok && r.error === 'service_not_found') return { speak: `Which service would you like? We have ${orList((r.menu || []).slice(0, 5))}.`, slots: [], needs_service: true, source: lp.provider };
  const who = r.staffName ? ` with ${r.staffName}` : '';
  const note = r.staffMissing ? `${stylist} isn't showing for that one, but ` : '';
  if(r.exact) return { speak: `${note}Yes — ${spokenTime(r.exact.startTime, tz)} ${dayWord(r.exact.startTime, tz)} works for ${r.service}${who}. Shall I book it?`, slots: [r.exact.startTime], exact: true, service: r.service, source: lp.provider };
  if(r.times?.length){
    const offers = pickTimes(r.times, wantAt);
    const said = orList(offers.map((t) => spokenTime(t.startTime, tz)));
    return { speak: `${note}${wantAt ? `${String(time).trim()} is taken — the closest I have ${dayWord(offers[0].startTime, tz)} is` : `${dayWord(offers[0].startTime, tz)} I have`} ${said} for ${r.service}${who}. Which works?`, slots: offers.map((t) => t.startTime), service: r.service, source: lp.provider };
  }
  if(r.nextDate && r.nextTimes?.length){
    const offers = pickTimes(r.nextTimes, null);
    return { speak: `${note}That day is fully booked — the next openings are ${dayWord(offers[0].startTime, tz)}: ${orList(offers.map((t) => spokenTime(t.startTime, tz)))}. Which works?`, slots: offers.map((t) => t.startTime), service: r.service, rolled_days: 1, source: lp.provider };
  }
  return { speak: `I don't see any openings for ${r.service} in the next few weeks. Want me to have the salon text you when something opens?`, slots: [], service: r.service, source: lp.provider };
}
async function book_appointment_live(tenant, lp, body, who){
  const { service, date, time, stylist } = body;
  const tz = lp.integration?.metadata?.tz || await salonTz(tenant.id);
  const day = dateKeyIn(date, tz);
  const wantAt = day && time ? await salonInstant(tenant, day, time) : null;
  if(!wantAt) return { booked: false, needs_time: true, speak: `What day and time would you like for ${service || 'your appointment'}?` };
  const [firstName, ...rest] = who.name.split(' ');
  const { liveBook } = await import('./lib/live-booking.js');
  const r = await liveBook(lp, { starts_at: wantAt, date: day, service: service || '', stylist: stylist || null, timezone: tz, notes: 'Booked by Lola (LolaDesk)',
    client: { first_name: firstName, last_name: rest.join(' '), name: who.name, phone: who.phone || null, email: who.email || null } });
  if(!r.ok){
    if(r.error === 'service_not_found') return { booked: false, speak: `Which service should I book? We have ${orList((r.menu || []).slice(0, 5))}.` };
    if(r.error === 'taken'){
      const said = orList((r.offers || []).map((t) => spokenTime(t.startTime || t, tz)));
      return { booked: false, conflict: true, slots: (r.offers || []).map((t) => t.startTime || t), speak: said ? `That time was just taken in our book — I can do ${said} instead. Which works?` : `That day just filled up. Want me to look at the next day?` };
    }
    if(r.error === 'card_required'){
      // The salon's system wants a card on file — Lola never takes card numbers by voice: she texts the salon's own booking page.
      const url = String(tenant.booking_url || '').trim();
      let texted = false;
      if(url && who.phone){ try{ const { bookViaLink } = await import('./lib/link-booking.js'); const l = await bookViaLink(tenant, { ...body, client_name: who.name, client_phone: who.phone }, { url, startsAt: wantAt, service: { name: service } }); texted = /texted you/i.test(String(l?.speak || '')); }catch(_){} }
      if(!texted) await passToSalon(tenant, who, body);
      return { booked: false, card_required: true, speak: texted ? `The salon needs a card on file to hold ${spokenTime(wantAt, tz)} — I just texted you the booking link with everything filled in; it takes about thirty seconds. It's not booked until you tap confirm.` : `The salon needs a card on file to hold that time, so it's not booked yet — I've passed it to the salon and they'll text you the link to finish.` };
    }
    await passToSalon(tenant, who, body);
    return { booked: false, error: r.error, speak: `I couldn't get that confirmed in our booking system just now, so it's NOT booked yet. I've passed your request to the salon and they'll text you.`, detail: r.message };
  }
  // Booked AND verified in the salon's system: mirror it into LolaDesk (calendar, client card, confirmation text).
  let client = null;
  try{ client = await upsertClient(tenant.id, { phone: who.phone, name: who.name, email: who.email || undefined }); }catch(_){}
  let mirrored = null;
  try{
    const { createCanonicalBooking } = await import('./lib/booking-repository.js');
    let serviceId = null; try{ const { data } = await db().from('services').select('id,name').eq('tenant_id', tenant.id).ilike('name', r.service).maybeSingle(); serviceId = data?.id || null; }catch(_){}
    mirrored = await createCanonicalBooking({ tenantId: tenant.id, clientId: client?.id || null, serviceId, startTime: r.startAt, endTime: r.endAt || new Date(Date.parse(r.startAt) + 60 * 60e3).toISOString(), status: 'confirmed', notes: `Booked by Lola in ${lp.name} (${r.id})`, source: 'lola', externalId: r.id, externalSource: lp.provider, sendConfirmation: !!client });
  }catch(e){ console.warn('[lola-tools] live mirror:', String(e?.message || e).slice(0, 140)); }
  try{ await logUsage(tenant.id, 'booking', 1, { service: r.service, provider: lp.provider }); }catch(_){}
  let emailed = false;
  if(who.email){ try{ const { sendBookingEmail } = await import('./lib/booking-email.js'); emailed = (await sendBookingEmail({ tenant, to: who.email, name: who.name, service: r.service, when: fmtSalon(r.startAt, tz, 'long') })).sent; }catch(_){} }
  const when = fmtSalon(r.startAt, tz, 'long').replace(/:00(?= [AP]M)/, '');
  return {
    booked: true, verified: r.verified, provider: lp.provider, appointment_id: r.id, booking_id: mirrored?.id || null,
    speak: `You're all set, ${who.name.split(' ')[0]} — ${r.service} ${when}${r.staffName ? ` with ${r.staffName}` : ''}. It's confirmed in our book, and I'll text you a confirmation${who.email ? ' and email it to you' : ''}. Anything else?`,
    confirmation: { text_to: who.phone || null, email_to: emailed ? who.email : null }
  };
}
async function check_availability(tenant, body){
  await normalizeDate(tenant, body);
  // The salon's live booking system, when it has one (otherwise LolaDesk's calendar, which sees every connected system).
  try{ const lp = await liveFor(tenant); if(lp) return await check_availability_live(tenant, lp, body); }
  catch(e){ console.warn('[lola-tools] live availability:', String(e?.message || e).slice(0, 160)); }
  const { service, date, time, stylist } = body || {};
  const tz = await salonTz(tenant.id);
  try{
    const r = await smartOffers(tenant, body || {});
    if(r && r.ok && r.offers.length){
      const askedDay = date ? dayWord(/^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? date + 'T16:00:00Z' : date, tz) : null;
      return {
        speak: speakOffers(r, { service, askedTime: time ? String(time).trim() : null, askedDay, stylist, tz }),
        slots: r.offers.map(s => s.starts_at),
        offers: r.offers.map(s => ({ starts_at: s.starts_at, staff: s.staff_name, why: s.reasons })),
        exact: r.exact, rolled_days: r.rolled_days
      };
    }
  }catch(e){ console.warn('[lola-tools] smart slots:', String(e?.message || e).slice(0, 140)); }
  // Fallback: the plain list (legacy tenants without a services table).
  const svc = findService(tenant, service);
  const durationMin = parseDurationMin(svc?.durationMin ?? svc?.duration, 60);
  const smart = await listAvailability({ tenant, date, durationMin, service });
  if(smart?.slots?.length){
    const spokenSlots = smart.slots.slice(0, 3).map(s => fmtSalon(s, tz, 'time'));
    return { speak: `I can offer ${orList(spokenSlots)}${service ? ` for ${service}` : ''}. Which one do you want?`, slots: smart.slots };
  }
  // No invented times: offer to text real openings instead.
  return {
    speak: `Let me find the best ${service||'appointment'} time for you${date?` around ${date}`:''}. I can text you our next openings — what number should I use?`,
    slots: [], needs_callback: true
  };
}

// ── SKILL: book an appointment ──
// Who the booking is for — a real booking needs a real person: first AND last name, a mobile for the
// confirmation text, and an email for the confirmation email (or a clear "skip"). A returning client's
// details on file fill themselves in. Returns { name, phone, email, needs:[...] }.
async function bookingIdentity(tenant, body){
  let name = String(body.client_name || '').replace(/\s+/g, ' ').trim();
  const phone = String(body.client_phone || body.from || '').trim();
  let email = String(body.client_email || '').trim().toLowerCase();
  if(tenant?.id && phone.replace(/\D/g, '').length >= 10){
    try{
      const known = await getClientByPhone(tenant.id, phone);
      const knownName = [known?.first_name, known?.last_name].filter((x) => x && !/^client$/i.test(String(x))).join(' ').trim();
      if(knownName.split(' ').length >= 2 && name.split(' ').length < 2) name = knownName;
      if(!email && known?.email) email = String(known.email).toLowerCase();
    }catch(_){}
  }
  const needs = [];
  if(name.split(' ').filter(Boolean).length < 2) needs.push('first and last name');
  if(phone.replace(/\D/g, '').length < 10 && !/^(instagram|messenger)$/i.test(String(body.channel || ''))) needs.push('mobile number');
  const skipEmail = body.no_email === true || String(body.no_email || '').toLowerCase() === 'true';
  const { EMAIL_RE } = await import('./lib/booking-email.js');
  if(!EMAIL_RE.test(email) && !skipEmail) needs.push('email');
  return { name, phone, email: EMAIL_RE.test(email) ? email : '', needs };
}
const sayNeeds = (needs) => needs.length === 1 ? needs[0] : needs.slice(0, -1).join(', ') + ' and ' + needs[needs.length - 1];

/** This client's own booking that ends right when the new one starts (or starts right when it ends), same day. */
async function adjacentBooking(tenant, clientId, startsAt, durationMin){
  if(!tenant?.id || !clientId || !startsAt) return null;
  try{
    const start = Date.parse(startsAt), end = start + (Number(durationMin) || 60) * 60e3;
    const { data } = await db().from('bookings').select('id,start_time,end_time,status')
      .eq('tenant_id', tenant.id).eq('client_id', clientId)
      .gte('start_time', new Date(start - 12 * 3600e3).toISOString()).lte('start_time', new Date(start + 12 * 3600e3).toISOString())
      .limit(20);
    const tz = await salonTz(tenant.id);
    const dayOf = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: tz });
    const near = (a, b) => Math.abs(a - b) <= 5 * 60e3;
    return (data || []).find((b) => b && String(b.status || '') !== 'cancelled' && dayOf(b.start_time) === dayOf(startsAt) && (
      (b.end_time && near(Date.parse(b.end_time), start)) || near(Date.parse(b.start_time), end))) || null;
  }catch(_){ return null; }
}

// "October 10" / "Friday" → the salon-calendar day (YYYY-MM-DD) before anything reads it.
async function normalizeDate(tenant, body){
  if(!body || !body.date || /^\d{4}-\d{2}-\d{2}$/.test(String(body.date))) return;
  try{ const k = resolveDateKey(body.date, await salonTz(tenant.id)); if(k) body.date = k; }catch(_){}
}

async function book_appointment(tenant, body){
  await normalizeDate(tenant, body);
  const { service, date, time, stylist } = body;
  // Conversations with clients (a phone call, the website) collect the full details first; bookings the
  // salon makes itself (dashboard, Zapier, owner commands) don't need them.
  const collect = body.collect_details === true;
  const who = await bookingIdentity(tenant, body);
  if(!collect){ who.needs = []; who.name = who.name || String(body.client_name || ''); }
  if(who.needs.length){
    // Nothing is booked until we know who it's for — and Lola must say so, never pretend.
    const emailOnly = who.needs.length === 1 && who.needs[0] === 'email';
    return {
      booked: false, needs: who.needs,
      speak: emailOnly
        ? `Almost done — what's the best email for your confirmation? If you'd rather not, just say skip.`
        : `Before I lock it in, I just need your ${sayNeeds(who.needs)}${who.needs.includes('email') ? ' (for the confirmation — you can skip the email)' : ''}.`,
      instruction: 'NOT BOOKED YET. Ask for exactly these, read them back, then call book_appointment again with client_name (first and last), client_phone, and client_email — or no_email: true if they skip the email.'
    };
  }
  const client_name = who.name, client_phone = who.phone, client_email = who.email;
  // The salon's live booking system, when it has one: book there, verify, then mirror into LolaDesk.
  {
    const lp = await liveFor(tenant);
    if(lp){
      try{ return await book_appointment_live(tenant, lp, body, { name: client_name || 'Client', phone: client_phone, email: client_email }); }
      catch(e){
        console.warn('[lola-tools] live booking:', String(e?.message || e).slice(0, 160));
        await passToSalon(tenant, { name: client_name, phone: client_phone }, body);
        return { booked: false, error: 'booking_system_unreachable', speak: `I couldn't reach our booking system just now, so it's NOT booked yet. I've passed your request to the salon and they'll text you to confirm.` };
      }
    }
  }
  const s = findService(tenant, service);
  try{
    // upsert the client
    let client = null;
    if(tenant.id && client_phone){
      client = await upsertClient(tenant.id, { phone: client_phone, name: client_name, email: client_email || undefined });
    }
    const startsAt = await salonInstant(tenant, date, time);
    const durationMin = parseDurationMin(s?.durationMin ?? s?.duration, 60);
    // Salons that keep their own system and chose "Lola texts my booking link": she closes it there.
    try{
      const { bookingMode, bookViaLink } = await import('./lib/link-booking.js');
      const mode = await bookingMode(tenant);
      if(mode.link) return await bookViaLink(tenant, body, { url: mode.url, startsAt, service: s ? { name: s.name, duration: s.duration } : { name: service }, durationMin });
    }catch(e){ console.warn('[lola-tools] link mode:', String(e?.message||e).slice(0,120)); }
    if(!startsAt){
      return {
        speak: `Perfect — I can book that now. Tell me the exact date and time you want for ${s?.name || service || 'your appointment'}.`,
        booked: false,
        needs_time: true
      };
    }

    // Lola never waits on the salon's booking platform mid-call: she books in LolaDesk's
    // engine (conflict-safe) and the platform write follows in the background (booking-outbox).
    let upstream = null, bookedRow = null;
    // An add-on right before/after this client's booking the same day (the upsell she just offered)
    // joins that visit: no second confirmation text, no second deposit link, no second email.
    const addOnTo = await adjacentBooking(tenant, client?.id, startsAt, durationMin);
    // Always record internally too (conflict-safe)
    if(tenant.id && startsAt){
      const safe = await createBookingSafe({
        tenant,
        clientId: client?.id,
        service: s?.name || service,
        stylist,
        startsAt,
        durationMin,
        price: s?.price,
        ...(addOnTo ? { sendConfirmation: false, addOnTo: addOnTo.id } : {})
      });
      if(!safe.ok && safe.conflict){
        const tzB = await salonTz(tenant.id);
        let r = null;
        try{ r = await smartOffers(tenant, { service: s?.name || service, date, time, stylist, client_phone }); }catch(_){}
        if(r && r.ok && r.offers.length){
          const day = dayWord(r.offers[0].starts_at, tzB);
          const opts = orList(r.offers.map(x => fmtSalon(x.starts_at, tzB, 'time')));
          return { speak: `That time just got taken — the closest I have${r.rolled_days ? ' is ' + day + ' at' : ' ' + day + ' is'} ${opts}. Which works?`, booked: false, conflict: true, slots: r.offers.map(x => x.starts_at) };
        }
        const av = await listAvailability({ tenant, date: startsAt, durationMin, stylist });
        const options = orList((av.slots || []).slice(0, 3).map(x => fmtSalon(x, tzB, 'time')));
        return {
          speak: `That time just got taken. I can do ${options || 'the next available slot'} instead.`,
          booked: false,
          conflict: true,
          slots: av.slots || []
        };
      } else if(!safe.ok && safe.error === 'service_not_found'){
        // Never a booking without a real service: offer the salon's actual menu.
        const menu = (safe.menu || []).map(m => typeof m === 'string' ? m : m?.name).filter(Boolean).slice(0, 5);
        return {
          speak: menu.length ? `Which service should I book? We have ${orList(menu)}.` : `Which service would you like me to book?`,
          booked: false, needs_service: true, menu, error: 'service_not_found'
        };
      } else if(!safe.ok){
        return {
          speak: `I could not lock that slot yet. Please confirm another nearby time and I will secure it now.`,
          booked: false,
          error: safe.error || 'booking_failed'
        };
      } else {
        bookedRow = safe.booking || null;
        await logUsage(tenant.id, 'booking', 1, { service: s?.name || service });
        if(safe.booking?.id){
          try{
            const { writeThrough } = await import('./lib/booking-outbox.js');
            upstream = await writeThrough(db(), { tenantId: tenant.id, booking: safe.booking, ctx: {
              client: { id: client?.id || safe.booking.client_id || null, name: client_name || null, phone: client_phone || null },
              service: { id: safe.booking.service_id || null, name: s?.name || service || null },
              staff: { id: safe.booking.staff_id || null },
              startsAt: safe.booking.start_time || startsAt, endsAt: safe.booking.end_time || null, durationMin,
              price: s?.price ?? 0, timezone: await salonTz(tenant.id), notes: 'Booked by Lola (LolaDesk AI front desk)'
            } });
          }catch(e){ console.warn('[lola-tools] outbox:', String(e?.message||e).slice(0,120)); }
        }
      }
    }

    const tzS = await salonTz(tenant.id);
    const bk = bookedRow;
    const whenStr = bk?.start_time ? fmtSalon(bk.start_time, tzS, 'long').replace(/:00(?= [AP]M)/, '') : `${date ? date : ''}${time ? ` at ${time}` : ''}`;
    // The stylist the calendar actually assigned (the one asked for may not have been free).
    let staffName = null;
    if(bk?.staff_id){ try{ const { data } = await db().from('staff').select('name').eq('id', bk.staff_id).maybeSingle(); staffName = data?.name ? String(data.name).split(' ')[0] : null; }catch(_){} }
    if(!staffName && !bk?.staff_id) staffName = stylist || null;
    let speakStr = addOnTo
      ? `Done${client_name?`, ${String(client_name).split(' ')[0]}`:''} — I've added ${s?.name||service} ${whenStr}${staffName?` with ${staffName}`:''} to your visit. `
      : `You're all set${client_name?`, ${String(client_name).split(' ')[0]}`:''} — ${s?.name||service} ${whenStr}${staffName?` with ${staffName}`:''}. `;
    // The deposit line tells the truth: the salon's real policy, this client's real history, the real amount.
    let plan = { required: false };
    if(addOnTo){ /* part of the visit already confirmed (and deposited) — nothing new to send */ }
    else if(bk?.id){ try{ const { depositPlan } = await import('./lib/deposits.js'); plan = await depositPlan({ tenantId: tenant.id, booking: bk, clientId: client?.id }); }catch(_){} }
    else if(tenant.knowledge?.require_deposit) plan = { required: true, amount_cents: Math.round(Number(tenant.knowledge.deposit_amount || 50) * 100) };
    if(addOnTo) speakStr += `It's on the same appointment, so there's nothing new to confirm. `;
    else if(plan.required) speakStr += `I'm texting you a secure link for the $${(plan.amount_cents / 100).toFixed(plan.amount_cents % 100 ? 2 : 0)} deposit${plan.hold_minutes ? ` — the spot is held for ${plan.hold_minutes} minutes` : ''}. `;
    else speakStr += client_email ? `I'll text and email you a confirmation. ` : `I'll text you a confirmation. `;
    // A real add-on from the menu that fits right after, with the same stylist — offered once.
    let upsell = null;
    if(bk?.id && !addOnTo && body.channel !== 'no_upsell'){
      try{
        const { fitsAfter } = await import('./lib/smart-slots.js');
        const { listServices } = await import('./lib/booking-repository.js');
        upsell = await fitsAfter({ tenantId: tenant.id, booking: bk, services: await listServices(tenant.id) });
      }catch(_){ upsell = null; }
    }
    if(upsell) speakStr += `${staffName || 'Your stylist'} has time right after — want me to add a ${upsell.name} for $${upsell.price}? It's ${upsell.duration_minutes} minutes.`;
    else speakStr += `Anything else?`;
    if(upsell){ try{ await logUsage(tenant.id, 'upsell_offered', 1, { service: upsell.name, price: upsell.price }); }catch(_){} }
    // The confirmation email (the text goes out with the booking itself).
    let emailed = { sent: false, reason: addOnTo ? 'add_on' : 'no_email' };
    if(bk?.id && client_email && !addOnTo){
      try{ const { sendBookingEmail } = await import('./lib/booking-email.js'); emailed = await sendBookingEmail({ tenant, to: client_email, name: client_name, service: s?.name || service, when: whenStr }); }catch(_){}
    }

    return {
      speak: speakStr,
      confirmation: { text_to: addOnTo ? null : (client_phone || null), email_to: emailed.sent ? client_email : null, email_error: emailed.sent || addOnTo ? null : (client_email ? emailed.reason : null) },
      booked: true, external: upstream?.ok ? 'queued' : false, deposit_required: !!plan.required,
      ...(addOnTo ? { add_on_to: addOnTo.id } : {}),
      ...(bk?.staff_id ? { stylist: staffName } : {}),
      ...(upsell ? { upsell: { service: upsell.name, price: upsell.price, starts_at: upsell.starts_at, stylist: upsell.staff_name, how: `If they say yes, call book_appointment with service "${upsell.name}", the same client name and phone, stylist "${upsell.staff_name}", date ${new Date(upsell.starts_at).toLocaleDateString('en-CA', { timeZone: tzS })} and time ${fmtSalon(upsell.starts_at, tzS, 'time')}.` } } : {})
    };
  }catch(e){
    console.error('[lola-tools] book_appointment failed:', String(e?.message || e).slice(0, 200));
    try{ await capture_lead(tenant, { client_name, client_phone, service_requested: `${service || 'appointment'} ${date || ''} ${time || ''}`.trim() }); }catch(_){}
    return {
      speak: `I couldn't lock that in just now — it is NOT booked yet. I've passed your request to the salon and they'll text you to confirm.`,
      booked: false, needs_callback: true
    };
  }
}

// ── A client's own bookings: found by their verified number, never by a name (names aren't unique) ──
const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const BOOKING_COLS = 'id,tenant_id,client_id,service_id,staff_id,start_time,end_time,status,service:services(name)';
const svcName = (b) => b?.service?.name || (typeof b?.service === 'string' ? b.service : '') || b?.service_name || 'appointment';
/** "Tuesday, October 13 at 2 PM" in the salon's time zone. */
function sayWhen(iso, tz){
  const d = new Date(iso); if(isNaN(d)) return '';
  try{
    const day = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz });
    const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }).replace(/:00(?=\s?[AP]M)/, '');
    return `${day} at ${t}`;
  }catch(_){ return fmtSalon(iso, tz, 'long'); }
}
/** The service's name for what Lola says back (when the join didn't bring it). */
async function withServiceName(c, tenant, bk){
  if(bk && !bk.service?.name && bk.service_id){
    try{ const { data } = await c.from('services').select('name').eq('tenant_id', tenant.id).eq('id', bk.service_id).maybeSingle(); if(data?.name) bk.service = { name: data.name }; }catch(_){}
  }
  return bk;
}
async function nextBookingFor(c, tenant, clientId){
  const { data } = await c.from('bookings').select(BOOKING_COLS)
    .eq('tenant_id', tenant.id).eq('client_id', clientId)
    .gte('start_time', new Date().toISOString()).neq('status', 'cancelled')
    .order('start_time', { ascending: true }).limit(1);
  return data?.[0] || null;
}
/**
 * The booking this request may act on. With a client phone (the verified caller / texter), a given
 * booking_id must belong to that client — anyone else's booking is refused. Without one, only the
 * salon's own tools (dashboard / owner) reach here, and an explicit booking_id is honoured.
 * → { booking } | { refused: true } | { none: true }
 */
async function ownedBooking(c, tenant, { booking_id, client_phone }){
  const phone = String(client_phone || '').trim();
  let client = null;
  if(phone){ client = await getClientByPhone(tenant.id, phone).catch(() => null); }
  if(booking_id){
    const { data: bk } = await c.from('bookings').select(BOOKING_COLS).eq('tenant_id', tenant.id).eq('id', String(booking_id)).maybeSingle().then((r) => r, () => ({ data: null }));
    if(!bk) return { none: true };
    if(phone){
      let owner = null;
      if(bk.client_id){ const { data } = await c.from('clients').select('id,phone').eq('tenant_id', tenant.id).eq('id', bk.client_id).maybeSingle().then((r) => r, () => ({ data: null })); owner = data; }
      if(!owner || !last10(owner.phone) || last10(owner.phone) !== last10(phone)) return { refused: true };
    }
    return { booking: bk };
  }
  if(!client) return { none: true };
  const next = await nextBookingFor(c, tenant, client.id);
  return next ? { booking: next, client } : { none: true, client };
}
const NOT_YOURS = "I can only look up or change bookings under the number you're calling from. Want me to help with that one?";

async function confirm_booking(tenant, { client_phone }){
  const c = db();
  if(!c) return { speak:'I can confirm that now. Share your booking phone number.' };
  // By the verified number only — a name search could read out someone else's appointment.
  if(!client_phone) return { speak:"I can look that up from the number the appointment is under — are you calling or texting from it?", confirmed:false };
  const client = await getClientByPhone(tenant.id, client_phone);
  if(!client) return { speak:'I could not find a booking under this number yet. Want me to book one now?', confirmed:false };
  const next = await withServiceName(c, tenant, await nextBookingFor(c, tenant, client.id));
  if(!next) return { speak:`I do not see an upcoming booking for ${client.name || 'that client'}. Want me to book one now?`, confirmed:false };
  const when = fmtSalon(next.start_time, await salonTz(tenant.id));
  return { speak:`Yes - you are confirmed for ${svcName(next)} on ${when}.`, confirmed:true, booking:{ ...next, starts_at: next.start_time } };
}

async function reschedule_appointment(tenant, { booking_id, client_phone, new_date, new_time }){
  const c = db();
  if(!c) return { speak:'I can help reschedule. Please share booking details again.' };
  const found = await ownedBooking(c, tenant, { booking_id, client_phone });
  if(found.refused) return { speak: NOT_YOURS, rescheduled:false, verified:false };
  if(!found.booking) return { speak:'I could not identify which booking to reschedule yet. Please share the booking phone number.', rescheduled:false };
  const bk = { ...found.booking }, bookingId = bk.id;   // a copy: the move may update the row in place
  await withServiceName(c, tenant, bk);
  const targetIso = await salonInstant(tenant, new_date, new_time);
  if(!targetIso) return { speak:'Please share the new date and time, and I will move it immediately.' };
  const tz = await salonTz(tenant.id);
  const out = await rescheduleBookingSafe({ tenantId: tenant.id, bookingId, newStartsAt: targetIso });
  if(!out.ok){
    if(out.conflict){
      const av = await listAvailability({ tenant, date: targetIso, durationMin: Number(out?.booking?.duration_min || 60) });
      const options = (av.slots || []).slice(0, 3).map(x => fmtSalon(x, tz, 'time')).join(', ');
      return { speak:`That new time is not available. I can offer ${options || 'the next open slot'} instead.`, rescheduled:false, conflict:true, slots:av.slots || [] };
    }
    return { speak:'I could not reschedule that just now. Please give me one moment and we can retry.', rescheduled:false };
  }
  await zapNotice(tenant, bookingId, 'booking.rescheduled');
  const was = sayWhen(bk.start_time, tz), now = sayWhen(out.booking?.start_time || targetIso, tz);
  return { speak:`Done — your ${svcName(bk)}${was ? ` from ${was}` : ''} is moved to ${now}.`, rescheduled:true, booking:out.booking };
}

async function cancel_appointment(tenant, { booking_id, client_phone }){
  const c = db();
  if(!c) return { speak:'I can help cancel it now. Please confirm the booking phone number.' };
  const found = await ownedBooking(c, tenant, { booking_id, client_phone });
  if(found.refused) return { speak: NOT_YOURS, cancelled:false, verified:false };
  if(!found.booking) return { speak:'I could not find the booking to cancel yet. Share the booking phone number.', cancelled:false };
  const bk = { ...found.booking }, bookingId = bk.id;
  await withServiceName(c, tenant, bk);
  const out = await cancelBookingSafe({ tenantId: tenant.id, bookingId });
  if(!out.ok) return { speak:'I could not cancel that right now. Please give me one moment and retry.', cancelled:false };
  await zapNotice(tenant, bookingId, 'booking.cancelled');
  const when = sayWhen(bk.start_time, await salonTz(tenant.id));
  return { speak:`Done — your ${svcName(bk)}${when ? ` on ${when}` : ''} is cancelled. Do you want me to find you a new time?`, cancelled:true };
}

// ── SKILL: capture a lead ──
async function capture_lead(tenant, { client_name, client_phone, service_requested }){
  try{
    if(tenant.id && client_phone){
      const client = await upsertClient(tenant.id, { phone: client_phone, name: client_name });
      await logUsage(tenant.id, 'lead', 1, { service: service_requested, name: client_name });
    }
    return {
      speak: `Got it${client_name?`, ${String(client_name).split(' ')[0]}`:''} — I've noted you're interested in ${service_requested||'a visit'} and the team will reach out shortly. Thank you for calling!`,
      captured: true
    };
  }catch(e){
    return { speak: `Thank you — I've passed your details to the team and they'll be in touch soon.`, captured:false };
  }
}

// ── SKILL: recovery (win-back) ──
function handle_recovery(tenant, { client_name }){
  return {
    speak: `It's lovely to hear from you again${client_name?`, ${client_name}`:''}! We'd love to have you back. Should I find you a time this week?`
  };
}

// ── SKILL: escalate / take a message ──
async function escalate(tenant, { message, client_phone, client_name }){
  try{ if(tenant.id) await logUsage(tenant.id, 'escalation', 1, { message, client_name, client_phone }); }catch{}
  return { speak: `I've made a note for the team and they'll follow up with you personally. Is there anything else I can help with right now?` };
}

// Telnyx's LolaBrain tool is named "take-message" (its schema sends
// message_summary / caller_name / callback_number) — map it onto the escalate
// skill so a message left in voice lands in the same escalation log.
async function takeMessage(tenant, args){
  return escalate(tenant, {
    message: args?.message_summary || args?.message || '',
    client_name: args?.caller_name || args?.client_name || '',
    client_phone: args?.callback_number || args?.client_phone || ''
  });
}

function to24(t){
  // "2:00 PM", "2pm", "2 p.m.", "14:00", "14" -> "14:00:00". Unreadable -> null
  // (it used to silently become 10:00 AM).
  const m = String(t||'').trim().toLowerCase().replace(/\./g,'').match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if(!m) return null;
  let h = +m[1]; const min = m[2] || '00'; const ap = m[3] || '';
  if(h>23 || +min>59) return null;
  if(!ap && h>=1 && h<=7) h+=12;            // "at 3" at a salon means 3 PM
  if(ap==='pm' && h<12) h+=12; if(ap==='am' && h===12) h=0;
  return `${String(h).padStart(2,'0')}:${min}:00`;
}
// A caller's date + time are the SALON's local time (servers run in UTC).
async function salonInstant(tenant, date, time){
  const t = to24(time); if(!date || !t) return null;
  const tz = await salonTz(tenant.id);
  const key = resolveDateKey(date, tz);
  if(!key) return null;
  return zonedLocalToUtc(key, t, tz);
}

// ── Which calendar day a client means, as YYYY-MM-DD in the salon's time zone ──
// "2026-10-10" as given; "today" / "tomorrow" / "Friday" / "next Friday"; "October 10", "Oct 10th",
// "Friday, October 10", "10/10" → the NEXT time that day comes round (never a past year: a bare
// "October 10" used to parse as 2001). An explicit year that has already gone is treated the same way.
const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const WEEKDAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const pad2 = (n) => String(n).padStart(2, '0');
function addDaysKey(key, n){ const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
function validMonthDay(y, m, d){ const dt = new Date(Date.UTC(y, m - 1, d)); return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d; }
export function resolveDateKey(date, tz, now = Date.now()){
  const s = String(date || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if(!s) return null;
  const zone = tz || 'America/New_York';
  let today;
  try{ today = new Date(now).toLocaleDateString('en-CA', { timeZone: zone }); }catch(_){ today = new Date(now).toISOString().slice(0, 10); }
  const thisYear = Number(today.slice(0, 4));
  const nextOccurrence = (m, d, y = null) => {
    if(!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    let year = y && y >= thisYear ? y : thisYear;
    if(!validMonthDay(year, m, d)){ if(!(m === 2 && d === 29)) return null; }
    let key = `${year}-${pad2(m)}-${pad2(d)}`;
    // No year given (or a year already gone): the next time that date comes round.
    for(let i = 0; (!y || y < thisYear) && key < today && i < 8; i++){ year++; key = `${year}-${pad2(m)}-${pad2(d)}`; }
    while(!validMonthDay(year, m, d) && year < thisYear + 8){ year++; key = `${year}-${pad2(m)}-${pad2(d)}`; }
    return validMonthDay(year, m, d) ? key : null;
  };
  let mm;
  if((mm = s.match(/^(\d{4})-(\d{2})-(\d{2})/))){
    const y = +mm[1], m = +mm[2], d = +mm[3];
    if(!validMonthDay(y, m, d)) return null;
    return y < thisYear ? nextOccurrence(m, d) : `${mm[1]}-${mm[2]}-${mm[3]}`;
  }
  if(s === 'today' || s === 'tonight' || s === 'this evening' || s === 'this afternoon') return today;
  if(s === 'tomorrow') return addDaysKey(today, 1);
  if(s === 'day after tomorrow' || s === 'the day after tomorrow') return addDaysKey(today, 2);
  const wd = WEEKDAY_NAMES.findIndex((w) => new RegExp('^(this |next |on )?' + w + '$').test(s));
  if(wd >= 0){
    const todayW = new Date(today + 'T12:00:00Z').getUTCDay();
    let diff = (wd - todayW + 7) % 7;
    if(/^next /.test(s) && diff === 0) diff = 7;
    return addDaysKey(today, diff);
  }
  // "october 10", "oct 10th", "friday, october 10", "october 10 2026", "10 october"
  const cleaned = s.replace(/^(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*,? /, '').replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  if((mm = cleaned.match(/^([a-z]+)\.? (\d{1,2})(?: (\d{4}))?$/)) || (mm = cleaned.match(/^(\d{1,2}) ([a-z]+)\.?(?: (\d{4}))?$/))){
    const word = /^\d/.test(mm[1]) ? mm[2] : mm[1];
    const day = /^\d/.test(mm[1]) ? +mm[1] : +mm[2];
    const m = MONTHS.indexOf(word.slice(0, 3)) + 1;
    if(m >= 1) return nextOccurrence(m, day, mm[3] ? +mm[3] : null);
  }
  // "10/10", "10/10/2026", "10-10"
  if((mm = cleaned.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/))){
    let y = mm[3] ? +mm[3] : null; if(y && y < 100) y += 2000;
    return nextOccurrence(+mm[1], +mm[2], y);
  }
  // Anything else Date can read: keep its month/day, never its (possibly ancient) default year.
  const t = Date.parse(s);
  if(isNaN(t)) return null;
  const dt = new Date(t);
  const explicitYear = /\b\d{4}\b/.test(s) ? dt.getFullYear() : null;
  return nextOccurrence(dt.getMonth() + 1, dt.getDate(), explicitYear);
}

// ── SKILL: recognise a returning client from the number they give (website chat, blocked caller ID) ──
async function recall_client(tenant, { client_phone }){
  if(!client_phone) return { speak: 'What’s the mobile number on your appointments? I’ll pull up your details.' };
  const client = await getClientByPhone(tenant.id, client_phone).catch(() => null);
  if(!client) return { speak: 'I don’t see that number yet — you’re new with us! What can I do for you?', known: false };
  const { clientStory, welcomeBack } = await import('./lib/client-brain.js');
  const story = await clientStory(db(), tenant, client);
  return { speak: welcomeBack(story, { salon: tenant.name }) || `Got you, ${story.first || 'welcome back'}! What can I do for you today?`, known: true, brief: story.brief };
}

const WRITE_SKILLS = new Set(['book_appointment', 'cancel_appointment', 'reschedule_appointment', 'capture_lead']);
const GATED_SKILLS = new Set(['book_appointment', 'reschedule_appointment']);

export const SKILLS = {
  recall_client,
  list_services, get_pricing, recommend_service,
  check_availability, book_appointment, capture_lead,
  handle_recovery, escalate, takeMessage,
  'take-message': takeMessage, // Telnyx's LolaBrain tool name
  'take_message': takeMessage, // older alias seen on some shared tools
  confirm_booking, reschedule_appointment, cancel_appointment,
  detect_upsell_opportunity // Yield Engine: pair add-ons to the booked service by spend tier
};

// A tool call without a valid signature means the assistant's wiring drifted: re-sign it now (at most every
// 10 minutes per instance), so nobody has to open the status page for private skills to come back.
let healAt = 0;
function wakeTheHeal(why){
  if(Date.now() - healAt < 10 * 60e3 || !process.env.TELNYX_API_KEY) return;
  healAt = Date.now();
  import('./lib/assistant-wiring.js').then((m) => m.wireAssistant({ heal: true })).then((w) => console.info('[lola-tools] re-signed tools (' + why + '):', w?.healed ? 'ok' : (w?.error || 'nothing to do'))).catch((e) => console.warn('[lola-tools] re-sign failed:', e?.message));
}

const linked = new Set();
async function linkConversation(tenant, q, body){
  const callControlId = String(q.call);
  if(linked.has(callControlId)) return;
  try{
    const c = db(); if(!c) return;
    const web = /web/i.test(String(q.ch || ''));
    const from = body.from && String(body.from).replace(/\D/g,'').length >= 8 ? String(body.from) : (web ? 'Website visitor' : null);
    const { error } = await c.from('call_sessions').upsert({ call_control_id: callControlId, tenant_id: tenant.id, from_number: from, to_number: tenant.phone_number || null }, { onConflict: 'call_control_id' });
    if(!error) linked.add(callControlId);
  }catch(_){ /* linking never blocks the answer */ }
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).json({ speak:'Method not allowed' });

  try{
    const body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});
    // The salon line and the caller can ride on the tool URL (?to={{telnyx_agent_target}}&from=…),
    // so every tool knows which salon it serves without the model having to say it.
    const real = (v) => v && !/\{\{/.test(String(v));
    const { toolKeyOk } = await import('./lib/tool-key.js');
    // Signed by LolaDesk's own assistant wiring (k=…). Unsigned or stale-signed (a rotated secret, before the
    // heal re-signs) still gets the public skills — booking never stops — but never the private ones.
    const signed = toolKeyOk(req.query?.k);
    if(!signed) wakeTheHeal(req.query?.k ? 'stale key' : 'unsigned');
    // Telnyx fills the salon line into the URL: it always wins over anything the model typed.
    if(real(req.query?.to)) body.to = String(req.query.to);
    // A website call has no dialed number; the salon's widget names its line (X-LolaDesk-Salon → {{loladesk_salon}}).
    const isPhone = (v) => String(v || '').replace(/\D/g, '').length >= 8;
    if(!isPhone(body.to) && real(req.query?.salon) && isPhone(req.query.salon)) body.to = String(req.query.salon);
    const web = /web/i.test(String(req.query?.ch || ''));
    // The caller's own line, as Telnyx saw it (never what the model or caller typed) — website visitors have none.
    const callerId = signed && !web && real(req.query?.from) && isPhone(req.query.from) ? String(req.query.from) : null;
    if(real(req.query?.from)) body.from = String(req.query.from);
    // Tool name may arrive as ?tool=… on the URL (Telnyx configures each
    // webhook tool with its own URL — pointing them all at this endpoint with
    // ?tool=<name> keeps one dispatched handler) OR in the body (function,
    // function_name, skill) for callers that send it that way.
    const tool = req.query?.tool || body.tool || body.function || body.function_name || body.skill;
    
    // Private skills act on a client's own bookings and history: only for the verified caller line.
    const PRIVATE = new Set(['cancel_appointment','reschedule_appointment','confirm_booking','recall_client','inject_memory']);
    const digits = (v) => String(v || '').replace(/\D/g, '').slice(-10);
    if(PRIVATE.has(String(tool))){
      if(!callerId){
        if(tool === 'recall_client'){
          // A website visitor gave a number: a warm first-name welcome, never their history (anyone can type a number).
          let firstName = '';
          try{ const t = await resolveTenant(body); const cl = t?.id && body.client_phone ? await getClientByPhone(t.id, body.client_phone) : null; firstName = String(cl?.first_name || '').trim(); }catch(_){}
          if(firstName && !/^client$/i.test(firstName)) return res.status(200).json({ speak: `Hey ${firstName}, welcome back! What can I do for you today?`, known: true });
          return res.status(200).json({ speak: "Thanks! I'll use that number for your booking. What can I do for you today?", known: false });
        }
        return res.status(200).json({ speak: "For your privacy I can only change a booking when you call from the number it's under. I can text that number a link to manage it — or help you with something else?", verified: false });
      }
      if(body.client_phone && digits(body.client_phone) !== digits(callerId)){
        return res.status(200).json({ speak: "I can only look up or change bookings for the number you're calling from. Want me to help with that one?", verified: false });
      }
      body.client_phone = callerId;
    }

    // Special Memory Injection Skill requested by Telnyx to start a call
    if (tool === 'inject_memory') {
      const tenant = await resolveTenant(body);
      const clientPhone = callerId;
      const memoryPrompt = await injectCallerMemory(tenant?.id, clientPhone);
      return res.status(200).json({ speak: "Memory loaded.", memory: memoryPrompt });
    }

    if(!tool || !SKILLS[tool]){
      return res.status(200).json({ speak: "I can help with booking, pricing, or recommendations — what would you like?", available_tools: Object.keys(SKILLS) });
    }
    
    // Skills that write (a booking, a client record, texts to a number) only answer LolaDesk's own signed
    // wiring: an unsigned request could otherwise book anything and text any number. The public read
    // skills (menu, prices, open times) stay open; the heal above re-signs drifted wiring.
    if(WRITE_SKILLS.has(String(tool)) && !signed){
      console.warn('[lola-tools] unsigned write refused:', tool);
      return res.status(200).json({ booked: false, ok: false, error: 'unsigned', verified: false,
        speak: "I can't book from here right now, so nothing is booked yet. Please call or text the salon and I'll take care of it there." });
    }
    if(tool === 'book_appointment'){ body.collect_details = true; body.channel = body.channel || (web ? 'web' : 'voice'); }
    const t0 = Date.now();
    const tenant = await resolveTenant(body);
    const tTenant = Date.now();
    if(!tenant){
      // No salon on this call (a website widget pasted without LolaDesk's salon line header, or an
      // unrouted number): say so plainly — never let her pretend she booked anything.
      console.warn('[lola-tools] no salon for', tool, web ? '(website call: the widget code is missing X-LolaDesk-Salon — copy it from Settings → Lola on your website)' : '(unrouted number)');
      return res.status(200).json({ booked: false, ok: false, error: 'salon_unknown',
        speak: "I can't reach the salon's calendar from here right now, so nothing is booked yet. Leave me your name and mobile and the salon will text you to confirm — or call us and I'll book you on the phone." });
    }
    // An expired / cancelled / unpaid salon: no new bookings or moves through Lola (cancels stay open,
    // so a client is never stranded). Fails open when the billing module isn't deployed.
    if(GATED_SKILLS.has(String(tool))){
      const gate = await serviceGate(tenant);
      if(!gate.ok) return res.status(200).json({ booked: false, ok: false, error: 'service_paused', reason: gate.reason || null,
        speak: gate.say || "The salon isn't taking bookings through me right now, so nothing is booked. Please call or text the salon directly." });
    }
    const clientPhone = body.client_phone || body.from;
    // Link this conversation to its salon (website calls have no dialed number): the
    // post-call insights webhook then lands the summary + transcript on that salon's Calls page.
    if(tenant?.id && real(req.query?.call)) await linkConversation(tenant, req.query, body);
    
    // Execute the skill safely via Orchestrator
    const result = await executeSkill(tenant, clientPhone, tool, body, SKILLS);
    // Latency profile for every voice tool call (visible in Vercel logs / browser devtools).
    try { res.setHeader('Server-Timing', `tenant;dur=${tTenant - t0}, skill;desc="${tool}";dur=${Date.now() - tTenant}, total;dur=${Date.now() - t0}`); res.setHeader('X-Lola-Latency-Ms', String(Date.now() - t0)); } catch (_) {}
    if (Date.now() - t0 > 1500) console.warn('[lola-tools] slow tool', tool, Date.now() - t0, 'ms');
    return res.status(200).json(result);
  }catch(e){
    console.error('[lola-tools] Error:', e);
    return res.status(200).json({ speak: "I'm having a quick technical moment — let me take your number and have someone call you right back.", _error: String(e) });
  }
}
