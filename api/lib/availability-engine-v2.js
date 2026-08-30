import {
  addMinutes, getBookingSettings, listServices, listStaff, getStaffServices,
  getStaffSchedules, getStaffTimeOff, getBlockedSlots, listBookings, listActiveHolds, createHold
} from './booking-repository.js';
import { dayBoundsUtc, localWeekday, zonedLocalToUtc } from './timezone.js';

function overlap(aStart,aEnd,bStart,bEnd){ return aStart < bEnd && bStart < aEnd; }

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

async function eligibleStaff(tenantId,serviceId,requestedStaffId){
  const staff=await listStaff(tenantId);
  const links=await getStaffServices(tenantId);
  const serviceLinks=links.filter(x=>x.service_id===serviceId);
  const allowed=new Set(serviceLinks.map(x=>x.staff_id));
  let out=allowed.size?staff.filter(x=>allowed.has(x.id)):staff;
  if(requestedStaffId) out=out.filter(x=>x.id===requestedStaffId);
  return {staff:out,links:serviceLinks};
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

function bookingBusySegments(booking,serviceById,allowProcessingOverlap){
  const svc=serviceById.get(booking.service_id);
  if(!svc || !allowProcessingOverlap) return [[booking.start_time,booking.end_time]];
  const phases=servicePhases(svc,null);
  return activeSegments(booking.start_time,phases,true);
}

export async function getAvailability({tenantId,serviceId,date,staffId=null,limit=12}){
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
  const {staff,links}=await eligibleStaff(tenantId,serviceId,staffId);
  const existing=await listBookings(tenantId,from,to);
  const holds=await listActiveHolds(tenantId,from,to);
  const serviceById=new Map(services.map(x=>[x.id,x]));
  const slots=[];

  for(const member of staff){
    const schedule=scheduleForStaff(schedules,member.id,dayOfWeek);
    if(!schedule) continue;
    const startMinute=mins(schedule.start_time), endMinute=mins(schedule.end_time);
    if(startMinute==null || endMinute==null || endMinute<=startMinute) continue;
    const custom=links.find(x=>x.staff_id===member.id);
    const phases=servicePhases(service,custom?.custom_duration_minutes);
    const before=Number(settings.default_buffer_before_min||0);
    const after=Number(settings.default_buffer_after_min||0);
    const interval=Math.max(5,Number(settings.slot_interval_minutes||15));

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

      const requestedActive=activeSegments(startsAt,phases,settings.allow_processing_overlap!==false);
      const memberBookings=existing.filter(x=>x.staff_id===member.id);
      const bookingConflict=memberBookings.some(b=>{
        const existingActive=bookingBusySegments(b,serviceById,settings.allow_processing_overlap!==false);
        return requestedActive.some(([a1,a2])=>existingActive.some(([b1,b2])=>overlap(a1,a2,b1,b2)));
      });
      if(bookingConflict) continue;

      // A hold reserves the full client appointment window. That is deliberate:
      // while a caller is deciding, we prefer a conservative hold over a race.
      const holdConflict=holds.some(h=>h.staff_id===member.id && overlap(windowStart,windowEnd,h.starts_at,h.ends_at));
      if(holdConflict) continue;

      slots.push({
        staff_id:member.id,staff_name:member.name,
        service_id:service.id,service_name:service.name,
        starts_at:startsAt,ends_at:endsAt,
        duration_minutes:phases.total,active_duration_1_min:phases.active1,
        processing_minutes:phases.processing,active_duration_2_min:phases.active2,
        price:custom?.custom_price ?? service.price,time_zone:timeZone,date:dateKey
      });
      if(slots.length>=limit) return {ok:true,slots,service,settings};
    }
  }
  return {ok:true,slots,service,settings};
}

export async function holdAvailability({tenantId,clientId=null,serviceId,staffId,startsAt,channel='voice',conversationId=null,ttlSeconds=300}){
  const settings=await getBookingSettings(tenantId);
  const timeZone=settings.timezone||'America/New_York';
  const av=await getAvailability({tenantId,serviceId,date:startsAt,staffId,limit:200});
  const target=new Date(startsAt).toISOString();
  const match=av.slots.find(x=>x.staff_id===staffId && x.starts_at===target);
  if(!match) return {ok:false,conflict:true,error:'slot_unavailable',slots:av.slots.slice(0,5),time_zone:timeZone};
  const hold=await createHold({tenantId,clientId,staffId,serviceId,startsAt:match.starts_at,endsAt:match.ends_at,channel,conversationId,ttlSeconds});
  return {ok:true,hold,slot:match};
}
