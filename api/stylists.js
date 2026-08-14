import { db } from './lib/db.js';
import { authenticatedTenant } from './lib/tenant-context.js';
import { listStaff, getStaffServices, getStaffSchedules, getStaffTimeOff } from './lib/booking-repository.js';

function bodyOf(req){
  if(typeof req.body==='string'){ try{return JSON.parse(req.body||'{}')}catch{return {}} }
  return req.body||{};
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  if(req.method==='OPTIONS') return res.status(204).end();
  try{
    const tenant=await authenticatedTenant(req);
    if(!tenant?.id) return res.status(401).json({ok:false,error:'not_authenticated'});
    const c=db();
    if(!c) return res.status(503).json({ok:false,error:'database_not_configured'});
    const body=bodyOf(req);

    if(req.method==='GET'){
      const date=req.query?.date || new Date().toISOString();
      const from=new Date(date); from.setUTCHours(0,0,0,0);
      const to=new Date(from.getTime()+86400000);
      const [staff,services,schedules,timeOff]=await Promise.all([
        listStaff(tenant.id),getStaffServices(tenant.id),getStaffSchedules(tenant.id),getStaffTimeOff(tenant.id,from.toISOString(),to.toISOString())
      ]);
      return res.json({ok:true,staff,staff_services:services,schedules,time_off:timeOff});
    }

    if(req.method==='POST'){
      const name=String(body.name||'').trim();
      if(!name) return res.status(400).json({ok:false,error:'name_required'});
      const {data,error}=await c.from('staff').insert({tenant_id:tenant.id,name,role:String(body.role||'Stylist').trim(),is_active:body.is_active!==false}).select().single();
      if(error) throw error;
      return res.json({ok:true,staff:data});
    }

    if(req.method==='PATCH'){
      if(!body.id) return res.status(400).json({ok:false,error:'id_required'});
      const patch={};
      if(body.name!==undefined) patch.name=String(body.name).trim();
      if(body.role!==undefined) patch.role=String(body.role).trim();
      if(body.is_active!==undefined) patch.is_active=!!body.is_active;
      const {data,error}=await c.from('staff').update(patch).eq('tenant_id',tenant.id).eq('id',body.id).select().maybeSingle();
      if(error) throw error;
      return res.json({ok:!!data,staff:data});
    }

    if(req.method==='DELETE'){
      const id=body.id || req.query?.id;
      if(!id) return res.status(400).json({ok:false,error:'id_required'});
      const {data,error}=await c.from('staff').update({is_active:false}).eq('tenant_id',tenant.id).eq('id',id).select().maybeSingle();
      if(error) throw error;
      return res.json({ok:!!data,staff:data});
    }

    return res.status(405).json({ok:false,error:'method_not_allowed'});
  }catch(e){return res.status(500).json({ok:false,error:String(e?.message||e)});}
}
