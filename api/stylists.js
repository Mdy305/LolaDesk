import { db, getTenantByPhone, getTenantBySlug } from './lib/db.js';
import { listStaff, getStaffServices, getStaffSchedules, getStaffTimeOff } from './lib/booking-repository.js';

async function tenantFrom(req,body){
  if(body.tenant_id){
    const c=db(); const {data}=await c.from('tenants').select('*').eq('id',body.tenant_id).maybeSingle(); return data;
  }
  if(body.tenant) return getTenantBySlug(body.tenant);
  return getTenantByPhone(body.to || req.query?.to || '');
}

export default async function handler(req,res){
  if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Origin','*');return res.status(204).end();}
  try{
    const body=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});
    const tenant=await tenantFrom(req,body);
    if(!tenant?.id) return res.status(404).json({ok:false,error:'tenant_not_found'});
    if(req.method==='GET'){
      const date=req.query?.date || new Date().toISOString();
      const from=new Date(date); from.setUTCHours(0,0,0,0);
      const to=new Date(from.getTime()+86400000);
      const [staff,services,schedules,timeOff]=await Promise.all([
        listStaff(tenant.id),getStaffServices(tenant.id),getStaffSchedules(tenant.id),getStaffTimeOff(tenant.id,from.toISOString(),to.toISOString())
      ]);
      return res.json({ok:true,staff,staff_services:services,schedules,time_off:timeOff});
    }
    return res.status(405).json({ok:false,error:'method_not_allowed'});
  }catch(e){return res.status(500).json({ok:false,error:String(e?.message||e)});}
}
