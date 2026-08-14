import { db } from './lib/db.js';
import { authenticatedTenant } from './lib/tenant-context.js';
import { getBookingSettings } from './lib/booking-repository.js';

const WRITABLE=new Set([
  'timezone','slot_interval_minutes','minimum_notice_minutes','booking_horizon_days','cancellation_window_hours',
  'default_buffer_before_min','default_buffer_after_min','allow_staff_choice','allow_any_staff','allow_processing_overlap',
  'public_booking_enabled','voice_booking_enabled','sms_booking_enabled','require_phone','require_email','confirmation_sms',
  'reminder_sms','deposit_policy','cancellation_policy','metadata'
]);

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  if(req.method==='OPTIONS') return res.status(204).end();
  try{
    const body=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});
    const tenant=await authenticatedTenant(req);
    if(!tenant?.id) return res.status(401).json({ok:false,error:'not_authenticated'});
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
