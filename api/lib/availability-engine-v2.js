import {
  addMinutes, getBookingSettings, listServices, listStaff, getStaffServices,
  getStaffSchedules, getStaffTimeOff, listBookings, listActiveHolds, createHold
} from './booking-repository.js';

function overlap(aStart,aEnd,bStart,bEnd){ return aStart < bEnd && bStart < aEnd; }
function dayStartIso(date){ const d=new Date(date); d.setUTCHours(0,0,0,0); return d.toISOString(); }
function dayEndIso(date){ return new Date(new Date(dayStartIso(date)).getTime()+86400000).toISOString(); }
function minutesSinceMidnightUTC(iso){ const d=new Date(iso); return d.getUTCHours()*60+d.getUTCMinutes(); }
function atDayMinute(dayIso,minute){ return new Date(new Date(dayStartIso(dayIso)).getTime()+minute*60000).toISOString(); }

function servicePhases(service, customDuration){
  const a1=Math.max(0, Number(service.active_duration_1_min ?? 0));
  const p=Math.max(0, Number(service.processing_duration_min ?? 0));
  const a2=Math.max(0, Number(service.active_duration_2_min ?? 0));
  if(a1 || p || a2){ return { active1:a1, processing:p, active2:a2, total:a1+p+a2 }; }
  const total=Math.max(15, Number(customDuration || service.duration_minutes || 60));
  return { active1:total, processing:0, active2:0, total };
}

function activeSegments(startIso, phases, allowProcessingOverlap){
  if(!allowProcessingOverlap || !phases.processing){ return [[startIso, addMinutes(startIso, phases.total)]]; }
  const firstEnd=addMinutes(startIso, phases.active1);
  const secondStart=addMinutes(firstEnd, phases.processing);
  const secondEnd=addMinutes(secondStart, phases.active2);
  const out=[];
  if(phases.active1>0) out.push([startIso,firstEnd]);
  if(phases.active2>0) out.push([secondStart,secondEnd]);
  return out;
}

async function eligibleStaff(tenantId, serviceId, requestedStaffId){
  const staff=await listStaff(tenantId);
  const links=await getStaffServices(tenantId);
  const serviceLinks=links.filter(x=>x.service_id===serviceId);
  const allowed=new Set(serviceLinks.map(x=>x.staff_id));
  let out=allowed.size ? staff.filter(x=>allowed.has(x.id)) : staff;
  if(requestedStaffId) out=out.filter(x=>x.id===requestedStaffId);
  return { staff:out, links:serviceLinks };
}

function scheduleForStaff(schedules, staffId, dayOfWeek){
  return schedules.find(x=>x.staff_id===staffId && Number(x.day_of_week)===dayOfWeek) || null;
}

function timeToMinute(text){
  if(!text) return null;
  const [h,m]=String(text).split(':').map(Number);
  return h*60+(m||0);
}

export async function getAvailability({ tenantId, serviceId, date, staffId=null, limit=12 }){
  const settings=await getBookingSettings(tenantId);
  const services=await listServices(tenantId);
  const service=services.find(x=>x.id===serviceId);
  if(!service) return { ok:false, error:'service_not_found', slots:[] };

  const requestedDay=new Date(date);
  if(Number.isNaN(requestedDay.getTime())) return { ok:false, error:'invalid_date', slots:[] };
  const from=dayStartIso(requestedDay), to=dayEndIso(requestedDay);
  const dayOfWeek=requestedDay.getUTCDay();
  const schedules=await getStaffSchedules(tenantId);
  const timeOff=await getStaffTimeOff(tenantId,from,to);
  const { staff, links }=await eligibleStaff(tenantId,serviceId,staffId);
  const existing=await listBookings(tenantId,from,to);
  const holds=await listActiveHolds(tenantId,from,to);
  const slots=[];

  for(const member of staff){
    const schedule=scheduleForStaff(schedules,member.id,dayOfWeek);
    if(!schedule) continue;
    const startMinute=timeToMinute(schedule.start_time);
    const endMinute=timeToMinute(schedule.end_time);
    if(startMinute==null || endMinute==null || endMinute<=startMinute) continue;
    const custom=links.find(x=>x.staff_id===member.id);
    const phases=servicePhases(service,custom?.custom_duration_minutes);
    const before=Number(settings.default_buffer_before_min||0);
    const after=Number(settings.default_buffer_after_min||0);
    const interval=Math.max(5,Number(settings.slot_interval_minutes||15));

    for(let minute=startMinute; minute+before+phases.total+after<=endMinute; minute+=interval){
      const startsAt=atDayMinute(from,minute+before);
      const endsAt=addMinutes(startsAt,phases.total);
      const windowStart=atDayMinute(from,minute);
      const windowEnd=addMinutes(endsAt,after);
      const leadMs=new Date(startsAt).getTime()-Date.now();
      if(leadMs < Number(settings.minimum_notice_minutes||0)*60000) continue;
      if(leadMs > Number(settings.booking_horizon_days||90)*86400000) continue;
      if(timeOff.some(x=>overlap(windowStart,windowEnd,x.start_time,x.end_time) && x.staff_id===member.id)) continue;

      const active=activeSegments(startsAt,phases,settings.allow_processing_overlap!==false);
      const busyRows=[...existing.filter(x=>x.staff_id===member.id), ...holds.filter(x=>x.staff_id===member.id).map(h=>({start_time:h.starts_at,end_time:h.ends_at}))];
      const conflict=busyRows.some(b=>active.some(([a,bEnd])=>overlap(a,bEnd,b.start_time,b.end_time)));
      if(conflict) continue;

      slots.push({
        staff_id:member.id, staff_name:member.name,
        service_id:service.id, service_name:service.name,
        starts_at:startsAt, ends_at:endsAt,
        duration_minutes:phases.total,
        processing_minutes:phases.processing,
        price:custom?.custom_price ?? service.price,
        timezone:settings.timezone
      });
      if(slots.length>=limit) return { ok:true, slots, service, settings };
    }
  }
  return { ok:true, slots, service, settings };
}

export async function holdAvailability({ tenantId, clientId=null, serviceId, staffId, startsAt, channel='voice', conversationId=null, ttlSeconds=300 }){
  const av=await getAvailability({ tenantId, serviceId, date:startsAt, staffId, limit:100 });
  const match=av.slots.find(x=>x.staff_id===staffId && x.starts_at===new Date(startsAt).toISOString());
  if(!match) return { ok:false, conflict:true, error:'slot_unavailable' };
  const hold=await createHold({ tenantId,clientId,staffId,serviceId,startsAt:match.starts_at,endsAt:match.ends_at,channel,conversationId,ttlSeconds });
  return { ok:true, hold, slot:match };
}
