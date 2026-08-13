import { db } from './lib/db.js';

const REQUIRED_TABLES=[
  'tenants','tenant_config','booking_settings','clients','services','staff','staff_services','staff_schedules','staff_time_off',
  'bookings','availability_holds','booking_services','booking_status_history','resources','service_resources',
  'integrations','provider_mappings','external_appointments','booking_sync_log','telnyx_call_sessions','telnyx_messages'
];

export default async function handler(req,res){
  const c=db();
  if(!c) return res.status(503).json({ok:false,error:'database_not_configured'});
  const checks=[];
  for(const table of REQUIRED_TABLES){
    try{
      const {error}=await c.from(table).select('*',{count:'exact',head:true});
      checks.push({table,ok:!error,error:error?.message||null});
    }catch(e){checks.push({table,ok:false,error:String(e?.message||e)});}
  }
  const missing=checks.filter(x=>!x.ok);
  return res.status(missing.length?503:200).json({
    ok:missing.length===0,
    ready:missing.length===0,
    required:REQUIRED_TABLES.length,
    passed:checks.length-missing.length,
    missing:missing.map(x=>x.table),
    checks
  });
}
