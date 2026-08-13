import { db, getTenantByPhone, getTenantBySlug } from './lib/db.js';
import { getBookingSettings } from './lib/booking-repository.js';

async function tenantFrom(req,body){
  if(body.tenant_id){ const c=db(); const {data}=await c.from('tenants').select('*').eq('id',body.tenant_id).maybeSingle(); return data; }
  if(body.tenant) return getTenantBySlug(body.tenant);
  return getTenantByPhone(body.to || req.query?.to || '');
}

const WRITABLE=new Set([
  'timezone','slot_interval_minutes','minimum_notice_minutes','booking_horizon_days','cancellation_window_hours',
  'default_buffer_before_min','default_buffer_after_min','allow_staff_choice','allow_any_staff','allow_processing_overlap',
  'public_booking_enabled','voice_booking_enabled','sms_booking_enabled','require_phone','require_email','confirmation_sms',
  'reminder_sms','deposit_policy','cancellation_policy','metadata'
]);

export default async function handler(req,res){
  try{
    const body=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});
    const tenant=await tenantFrom(req,body);
    if(!tenant?.id) return res.status(404).json({ok:false,error:'tenant_not_found'});
    if(req.method==='GET') return res.json({ok:true,settings:await getBookingSettings(tenant.id)});
    if(req.method==='POST' || req.method==='PATCH'){
      const patch={tenant_id:tenant.id};
      for(const [k,v] of Object.entries(body)) if(WRITABLE.has(k)) patch[k]=v;
      const c=db();
      const {data,error}=await c.from('booking_settings').upsert(patch,{onConflict:'tenant_id'}).select().single();
      if(error) throw error;
      return res.json({ok:true,settings:data});
    }
    return res.status(405).json({ok:false,error:'method_not_allowed'});
  }catch(e){return res.status(500).json({ok:false,error:String(e?.message||e)});}
}
