import { listServices, listStaff, getStaffServices } from './booking-repository.js';

function norm(v=''){
  return String(v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
}

function score(query, label){
  const q=norm(query), l=norm(label);
  if(!q || !l) return 0;
  if(q===l) return 100;
  if(l.includes(q) || q.includes(l)) return 80;
  const qw=new Set(q.split(' '));
  const lw=new Set(l.split(' '));
  let overlap=0;
  for(const w of qw) if(lw.has(w)) overlap++;
  return overlap ? 40 + overlap*10 : 0;
}

export async function resolveService(tenantId, query){
  const services=await listServices(tenantId);
  if(!query) return { found:false, candidates:services.slice(0,5) };
  const ranked=services.map(item=>({ item, score:score(query,item.name) })).sort((a,b)=>b.score-a.score);
  const best=ranked[0];
  if(!best || best.score<50) return { found:false, candidates:ranked.slice(0,5).map(x=>x.item) };
  return { found:true, service:best.item, confidence:best.score/100, candidates:ranked.slice(0,3).map(x=>x.item) };
}

export async function resolveStaff(tenantId, query, { serviceId=null } = {}){
  const staff=await listStaff(tenantId);
  let eligible=staff;
  if(serviceId){
    const links=await getStaffServices(tenantId);
    const ids=new Set(links.filter(x=>x.service_id===serviceId).map(x=>x.staff_id));
    if(ids.size) eligible=staff.filter(x=>ids.has(x.id));
  }
  if(!query || /^(any|anyone|first available|whoever)$/i.test(String(query).trim())){
    return { found:false, anyStaff:true, candidates:eligible };
  }
  const ranked=eligible.map(item=>({ item, score:score(query,item.name) })).sort((a,b)=>b.score-a.score);
  const best=ranked[0];
  if(!best || best.score<50) return { found:false, candidates:ranked.slice(0,5).map(x=>x.item) };
  return { found:true, staff:best.item, confidence:best.score/100, candidates:ranked.slice(0,3).map(x=>x.item) };
}

export async function resolveBookingRequest(tenantId, { service, stylist, staff } = {}){
  const serviceResult=await resolveService(tenantId, service);
  if(!serviceResult.found) return { ok:false, needs:'service', serviceResult };
  const staffResult=await resolveStaff(tenantId, stylist || staff, { serviceId:serviceResult.service.id });
  if((stylist || staff) && !staffResult.found && !staffResult.anyStaff){
    return { ok:false, needs:'staff', serviceResult, staffResult };
  }
  return {
    ok:true,
    service:serviceResult.service,
    staff:staffResult.found ? staffResult.staff : null,
    anyStaff:!staffResult.found,
    serviceResult,
    staffResult
  };
}
