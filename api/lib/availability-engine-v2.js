import {
  addMinutes, getBookingSettings, listServices, listStaff, getStaffServices,
  getStaffSchedules, getStaffTimeOff, getBlockedSlots, listBookings, listActiveHolds, createHoldAtomic
} from './booking-repository.js';
import { dayBoundsUtc, localWeekday, zonedLocalToUtc } from './timezone.js';

// Compare instants, not strings: Postgres returns "…14:00:00+00:00" while we
// build "…14:00:00.000Z", and as text those order wrongly at the same minute
// (a slot ending exactly when the next booking starts looked like a clash).
const ms=(v)=>typeof v==='number'?v:new Date(v).getTime();
function overlap(aStart,aEnd,bStart,bEnd){ return ms(aStart) < ms(bEnd) && ms(bStart) < ms(aEnd); }

function servicePhases(service, customDuration){
  const a1=Math.max(0,Number(service?.active_duration_1_min ?? 0));
  const p=Math.max(0,Number(service?.processing_duration_min ?? 0));
  const a2=Math.max(0,Number(service?.active_duration_2_min ?? 0));
  if(a1 || p || a2) return {active1:a1,processing:p,active2:a2,total:a1+p+a2};
  const total=Math.max(15,Number(customDuration || service?.duration_minutes || 60));
  return {active1:total,processing:0,active2:0,total};
}

function activeSegments(startIso, phases, allowProcessingOverlap){
  if(!allowProcessingOverlap || !phases.processing) return [[startIso,addMinutes(startIso,phases.total)]];
  const firstEnd=addMinutes(startIso,phases.active1);
  const secondStart=addMinutes(firstEnd,phases.processing);
  const secondEnd=addMinutes(secondStart,phases.active2);
  const out=[];
  if(phases.active1>0) out.push([startIso,firstEnd]);
  if(phases.active2>0) out.push([secondStart,secondEnd]);
  return out;
}

// Who can take this service (the Team page's service picker → staff_services):
//  • a stylist with picks takes only the services they picked;
//  • a stylist with no picks does everything ("If none picked, Lola offers
//    this staff for every service").
// Links to removed services (or from stylists no longer active) are ignored.
// No links at all → everyone does everything. A service NOBODY can take
// (every stylist picked other services) is still bookable by the whole team
// when the salon has a single stylist or offers "any available" — a new
// service must never silently vanish from the booking page.
export function staffForService({staff=[],links=[],serviceId,activeServiceIds=null,allowAny=true}){
  const ids=new Set(staff.map(x=>x.id));
  const live=links.filter(x=>ids.has(x.staff_id) && (!activeServiceIds || activeServiceIds.has(x.service_id)));
  const specialised=new Set(live.map(x=>x.staff_id));
  const serviceLinks=live.filter(x=>x.service_id===serviceId);
  const allowed=new Set(serviceLinks.map(x=>x.staff_id));
  let out=staff.filter(x=>allowed.has(x.id) || !specialised.has(x.id));
  if(!out.length && staff.length && (staff.length===1 || allowAny)) out=staff.slice();
  return {staff:out,links:serviceLinks};
}
async function eligibleStaff(tenantId,serviceId,requestedStaffId,activeServiceIds=null,settings=null){
  const staff=await listStaff(tenantId);
  const all=await getStaffServices(tenantId);
  const res=staffForService({staff,links:all,serviceId,activeServiceIds,allowAny:settings?.allow_any_staff!==false});
  if(requestedStaffId) res.staff=res.staff.filter(x=>x.id===requestedStaffId);
  return res;
}

// ── Salon hours (booking-settings.html): business_hours {mon..sun:{open,close,closed}}
// and closures ['YYYY-MM-DD'] on booking_settings (or its metadata fallback).
// A closure date or a closed weekday has no slots; stylist shifts are clamped
// to opening hours. Hours that are still the untouched schema default
// (10–20, Sunday closed) are only enforced once the owner has saved them
// (metadata.hours_confirmed_at), so a salon that never opened the page keeps
// its stylists' own hours.
const WEEK_KEYS=['sun','mon','tue','wed','thu','fri','sat'];
const DEFAULT_HOURS=JSON.stringify(['mon','tue','wed','thu','fri','sat','sun'].map(d=>d==='sun'?[d,'10:00','20:00',true]:[d,'10:00','20:00',false]));
function clock(text){
  if(text==null||text==='') return null;
  const m=String(text).trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm|a|p)?$/);
  if(!m) return null;
  let h=Number(m[1]); const mi=Number(m[2]||0);
  if(m[3]){ const pm=m[3][0]==='p'; if(h===12) h=0; if(pm) h+=12; }
  return h>24||mi>59?null:Math.min(1440,h*60+mi);
}
const isObj=v=>v&&typeof v==='object'&&!Array.isArray(v);
export function salonDay(settings,dateKey,dayOfWeek){
  const md=isObj(settings?.metadata)?settings.metadata:{};
  const closures=(Array.isArray(settings?.closures)?settings.closures:(Array.isArray(md.closures)?md.closures:[])).map(x=>String(x).slice(0,10));
  if(closures.includes(dateKey)) return {closed:true,reason:'closure'};
  const bh=isObj(settings?.business_hours)?settings.business_hours:(isObj(md.business_hours)?md.business_hours:null);
  if(!bh) return null;
  if(!md.hours_confirmed_at){
    const sig=JSON.stringify(['mon','tue','wed','thu','fri','sat','sun'].map(d=>[d,bh[d]?.open,bh[d]?.close,bh[d]?.closed===true]));
    if(sig===DEFAULT_HOURS) return null;
  }
  const key=WEEK_KEYS[dayOfWeek];
  const h=bh[key];
  if(!isObj(h)) return null;
  if(h.closed===true||h.closed==='true') return {closed:true,reason:'business_hours'};
  const open=clock(h.open), close=clock(h.close);
  if(open==null||close==null||close<=open) return null;
  return {open,close};
}

function scheduleForStaff(schedules,staffId,dayOfWeek){
  return schedules.find(x=>x.staff_id===staffId && Number(x.day_of_week)===dayOfWeek)||null;
}

function mins(text){
  if(!text) return null;
  const [h,m]=String(text).split(':').map(Number);
  return h*60+(m||0);
}

function minuteToTimeText(minute){
  const h=Math.floor(minute/60),m=minute%60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`;
}

// When an existing booking keeps its stylist busy. Its real end_time wins
// (multi-service bookings run longer than their first service). Processing
// gaps only open up when the booking is exactly that one service.
function bookingBusySegments(booking,serviceById,allowProcessingOverlap){
  const start=booking.start_time;
  const svc=serviceById.get(booking.service_id);
  const fallbackEnd=addMinutes(start,Number(svc?.duration_minutes||60));
  const end=booking.end_time||fallbackEnd;
  if(!svc || !allowProcessingOverlap) return [[start,end]];
  const phases=servicePhases(svc,null);
  if(!phases.processing) return [[start,end]];
  const spanMin=(new Date(end)-new Date(start))/60000;
  if(Math.abs(spanMin-phases.total)>1) return [[start,end]];
  return activeSegments(start,phases,true);
}

// ── The salon's own booking platform (Square, Vagaro, Boulevard, Fresha, Mindbody,
// Google, any calendar link): its appointments are synced every minute into
// cached_availability. They are BUSY time here — Lola never double-books them.
// An appointment mapped to a LolaDesk stylist blocks that stylist; an unmapped
// one takes one chair (one free stylist) for its duration. LolaDesk's own
// bookings that were written upstream are not counted twice.
async function listExternalBusy(tenantId,from,to,localBookings){
  try{
    const { db } = await import('./db.js');
    const c=db(); if(!c) return [];
    const { data, error }=await c.from('cached_availability').select('provider,external_booking_id,starts_at,ends_at,staff_id,status')
      .eq('tenant_id',tenantId).lt('starts_at',to).gt('ends_at',from);
    if(error || !data?.length) return [];
    const ours=new Set((localBookings||[]).map(b=>b.external_id).filter(Boolean).map(String));
    const rows=data.filter(r=>r.status!=='cancelled' && !ours.has(String(r.external_booking_id)));
    if(!rows.length) return [];
    const { data: maps }=await c.from('provider_mappings').select('provider,external_id,local_id').eq('tenant_id',tenantId).eq('entity_type','staff');
    const toLocal=new Map((maps||[]).map(m=>[m.provider+':'+m.external_id,m.local_id]));
    return rows.map(r=>({start:r.starts_at,end:r.ends_at,staff_id:(r.staff_id && String(r.staff_id).startsWith('local:')) ? String(r.staff_id).slice(6) : ((r.staff_id && toLocal.get(r.provider+':'+r.staff_id)) || null)}));
  }catch(_){ return []; }
}

export async function getAvailability({tenantId,serviceId,date,staffId=null,limit=12,excludeBookingId=null,context=false,_seen=false}){
  const settings=await getBookingSettings(tenantId);
  const timeZone=settings.timezone||'America/New_York';
  const services=await listServices(tenantId);
  const service=services.find(x=>x.id===serviceId);
  if(!service) return {ok:false,error:'service_not_found',slots:[]};

  let bounds;
  try{ bounds=dayBoundsUtc(date,timeZone); }
  catch{ return {ok:false,error:'invalid_date',slots:[]}; }
  const {key:dateKey,start:from,end:to}=bounds;
  const dayOfWeek=localWeekday(new Date(from),timeZone);
  const salon=salonDay(settings,dateKey,dayOfWeek);
  if(salon?.closed) return {ok:true,slots:[],service,settings,closed:salon.reason,...(context?{day:{},services}:{})};
  const schedules=await getStaffSchedules(tenantId);
  const timeOff=await getStaffTimeOff(tenantId,from,to);
  const blocks=await getBlockedSlots(tenantId,dateKey);
  // Normalize date-keyed blocks into UTC windows for this exact day.
  // All-day rows (no start/end) span the whole working day; timed rows
  // (lunch, breaks) map to their local window. A block with no staff_id
  // applies to every eligible staff member.
  const blockedWindows=blocks.map(b=>({
    staff_id:b.staff_id||null,
    start:b.start_time?zonedLocalToUtc(dateKey,b.start_time,timeZone):from,
    end:b.end_time?zonedLocalToUtc(dateKey,b.end_time,timeZone):to
  }));
  const {staff,links}=await eligibleStaff(tenantId,serviceId,staffId,new Set(services.map(x=>x.id)),settings);
  const existing=await listBookings(tenantId,from,to);
  const holds=await listActiveHolds(tenantId,from,to);
  const external=await listExternalBusy(tenantId,from,to,existing);
  const serviceById=new Map(services.map(x=>[x.id,x]));
  const slots=[];
  // Chairs the platform's unmapped appointments occupy, checked per time window below.
  const allStaff=await listStaff(tenantId).catch(()=>staff);
  const chairs=Math.max(1,(allStaff||staff).length);
  // context:true → each stylist's shift and busy time for the day, so smart-slots.js can see
  // the gaps a slot would leave (packing) without reading everything twice.
  const day=context?{}:null;

  for(const member of staff){
    const schedule=scheduleForStaff(schedules,member.id,dayOfWeek);
    if(!schedule) continue;
    let startMinute=mins(schedule.start_time), endMinute=mins(schedule.end_time);
    if(startMinute==null || endMinute==null || endMinute<=startMinute) continue;
    // A stylist is bookable only while the salon is open.
    if(salon){ startMinute=Math.max(startMinute,salon.open); endMinute=Math.min(endMinute,salon.close); }
    if(endMinute<=startMinute) continue;
    const custom=links.find(x=>x.staff_id===member.id);
    const phases=servicePhases(service,custom?.custom_duration_minutes);
    const before=Number(settings.default_buffer_before_min||0);
    // Per-service clean-up time wins over the salon-wide default.
    const svcAfter=service.buffer_after_min;
    const after=(svcAfter!=null && svcAfter!=='' && Number.isFinite(Number(svcAfter)))?Math.max(0,Number(svcAfter)):Number(settings.default_buffer_after_min||0);
    const interval=Math.max(5,Number(settings.slot_interval_minutes||15));
    if(day){
      const busy=[];
      existing.filter(x=>x.staff_id===member.id && x.id!==excludeBookingId && !['cancelled','canceled','no_show'].includes(String(x.status||'').toLowerCase()))
        .forEach(b=>busy.push({start:b.start_time,end:b.end_time||addMinutes(b.start_time,60),booking:true,phases:bookingBusySegments(b,serviceById,settings.allow_processing_overlap!==false)}));
      holds.filter(h=>h.staff_id===member.id).forEach(h=>busy.push({start:h.starts_at,end:h.ends_at,booking:true}));
      external.filter(x=>x.staff_id===member.id).forEach(x=>busy.push({start:x.start,end:x.end,booking:true}));
      timeOff.filter(x=>x.staff_id===member.id).forEach(x=>busy.push({start:x.start_time,end:x.end_time,booking:false}));
      blockedWindows.filter(x=>!x.staff_id||x.staff_id===member.id).forEach(x=>busy.push({start:x.start,end:x.end,booking:false}));
      day[member.id]={name:member.name,shift:[zonedLocalToUtc(dateKey,minuteToTimeText(startMinute),timeZone),zonedLocalToUtc(dateKey,minuteToTimeText(endMinute),timeZone)],busy,buffers:{before,after}};
    }

    for(let minute=startMinute; minute+before+phases.total+after<=endMinute; minute+=interval){
      const windowStart=zonedLocalToUtc(dateKey,minuteToTimeText(minute),timeZone);
      const startsAt=addMinutes(windowStart,before);
      const endsAt=addMinutes(startsAt,phases.total);
      const windowEnd=addMinutes(endsAt,after);
      const leadMs=new Date(startsAt).getTime()-Date.now();
      if(leadMs<Number(settings.minimum_notice_minutes||0)*60000) continue;
      if(leadMs>Number(settings.booking_horizon_days||90)*86400000) continue;
      if(timeOff.some(x=>x.staff_id===member.id && overlap(windowStart,windowEnd,x.start_time,x.end_time))) continue;
      if(blockedWindows.some(x=>(!x.staff_id||x.staff_id===member.id) && overlap(windowStart,windowEnd,x.start,x.end))) continue;

      // The new appointment's buffers travel with it: nothing may sit within
      // `before` minutes ahead of it or `after` minutes behind it.
      const requestedActive=activeSegments(startsAt,phases,settings.allow_processing_overlap!==false)
        .map(([s1,s2],i,arr)=>[i===0?addMinutes(s1,-before):s1, i===arr.length-1?addMinutes(s2,after):s2]);
      const memberBookings=existing.filter(x=>x.staff_id===member.id && x.id!==excludeBookingId);
      const bookingConflict=memberBookings.some(b=>{
        const existingActive=bookingBusySegments(b,serviceById,settings.allow_processing_overlap!==false);
        return requestedActive.some(([a1,a2])=>existingActive.some(([b1,b2])=>overlap(a1,a2,b1,b2)));
      });
      if(bookingConflict) continue;

      // A hold reserves the full client appointment window. That is deliberate:
      // while a caller is deciding, we prefer a conservative hold over a race.
      const holdConflict=holds.some(h=>h.staff_id===member.id && overlap(windowStart,windowEnd,h.starts_at,h.ends_at));
      if(holdConflict) continue;

      // The salon's own booking platform: mapped appointments block their stylist…
      if(external.some(x=>x.staff_id===member.id && overlap(windowStart,windowEnd,x.start,x.end))) continue;
      // …unmapped ones each take a chair: if every chair is taken in this window, nobody is free.
      const unmapped=external.filter(x=>!x.staff_id && overlap(windowStart,windowEnd,x.start,x.end)).length;
      if(unmapped){
        const busyStaff=new Set(existing.filter(b=>b.id!==excludeBookingId && overlap(windowStart,windowEnd,b.start_time,b.end_time||addMinutes(b.start_time,60))).map(b=>b.staff_id));
        external.filter(x=>x.staff_id && overlap(windowStart,windowEnd,x.start,x.end)).forEach(x=>busyStaff.add(x.staff_id));
        if(unmapped + busyStaff.size >= chairs) continue;
      }

      slots.push({
        staff_id:member.id,staff_name:member.name,
        service_id:service.id,service_name:service.name,
        starts_at:startsAt,ends_at:endsAt,
        duration_minutes:phases.total,active_duration_1_min:phases.active1,
        processing_minutes:phases.processing,active_duration_2_min:phases.active2,
        price:custom?.custom_price ?? service.price,time_zone:timeZone,date:dateKey
      });
    }
  }
  // Earliest times first across ALL stylists (it used to stop after the first
  // stylist's first 12 slots, so afternoons and other stylists never showed).
  slots.sort((a,b)=>ms(a.starts_at)-ms(b.starts_at));
  return {ok:true,slots:slots.slice(0,Math.max(1,Number(limit)||12)),service,settings,...(day?{day,services}:{}),
    // _seen: the bookings this answer was computed against (holdAvailability hands
    // them to the atomic hold so only bookings written AFTER this read conflict).
    ...(_seen?{seen_booking_ids:existing.map(b=>b.id),buffers:bufferFor(service,settings)}:{})};
}

// Buffers that travel with a new appointment (same rule as the slot loop above).
export function bufferFor(service,settings){
  const before=Number(settings?.default_buffer_before_min||0);
  const svcAfter=service?.buffer_after_min;
  const after=(svcAfter!=null && svcAfter!=='' && Number.isFinite(Number(svcAfter)))?Math.max(0,Number(svcAfter)):Number(settings?.default_buffer_after_min||0);
  return {before,after};
}

/**
 * Check the slot with the full engine, then take it ATOMICALLY (createHoldAtomic:
 * Postgres advisory lock + re-check, or insert + re-check fallback).
 *   minDurationMin — keep a moved booking's real length (multi-service / long
 *                    visits): the hold spans max(slot, minDurationMin) and the
 *                    extra time must be free too.
 *   requester      — public callers' device key (caps holds per device).
 */
export async function holdAvailability({tenantId,clientId=null,serviceId,staffId,startsAt,channel='voice',conversationId=null,ttlSeconds=300,excludeBookingId=null,minDurationMin=null,requester=null}){
  const settings=await getBookingSettings(tenantId);
  const timeZone=settings.timezone||'America/New_York';
  const wantLonger=Number(minDurationMin)>0;
  const av=await getAvailability({tenantId,serviceId,date:startsAt,staffId,limit:500,excludeBookingId,_seen:true,context:wantLonger});
  const target=new Date(startsAt).toISOString();
  const match=(av.slots||[]).find(x=>x.staff_id===staffId && ms(x.starts_at)===ms(target));
  if(!match) return {ok:false,conflict:true,error:av.ok===false?(av.error||'slot_unavailable'):'slot_unavailable',slots:(av.slots||[]).slice(0,5),time_zone:timeZone};
  let slot=match;
  if(wantLonger && ms(match.starts_at)+Number(minDurationMin)*60000>ms(match.ends_at)){
    const endsAt=new Date(ms(match.starts_at)+Number(minDurationMin)*60000).toISOString();
    // The extra time after the slot must be free too: inside the stylist's
    // (salon-clamped) shift, and clear of bookings, holds, time off and blocks.
    const extraEnd=addMinutes(endsAt,(av.buffers||{}).after||0);
    const d=av.day?.[staffId];
    const busy=(d?.busy||[]).some(x=>overlap(match.ends_at,extraEnd,x.start,x.end));
    if(!d || ms(extraEnd)>ms(d.shift[1]) || busy) return {ok:false,conflict:true,error:'slot_unavailable',detail:'not_enough_time',slots:(av.slots||[]).slice(0,5),time_zone:timeZone};
    slot={...match,ends_at:endsAt,duration_minutes:Math.round((ms(endsAt)-ms(match.starts_at))/60000)};
  }
  const {before,after}=av.buffers||{before:0,after:0};
  const taken=await createHoldAtomic({tenantId,clientId,staffId,serviceId,startsAt:slot.starts_at,endsAt:slot.ends_at,
    windowStart:addMinutes(slot.starts_at,-before),windowEnd:addMinutes(slot.ends_at,after),
    channel,conversationId,ttlSeconds,excludeBookingId,seenBookingIds:av.seen_booking_ids||[],requester});
  if(!taken.ok) return {ok:false,conflict:true,error:'slot_unavailable',reason:taken.reason,slots:(av.slots||[]).filter(x=>x!==match).slice(0,5),time_zone:timeZone};
  return {ok:true,hold:taken.hold,slot,atomic:!!taken.atomic};
}
