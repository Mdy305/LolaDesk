import { db } from './lib/db.js';

const checks=['tenants','clients','client_memories','bookings','services','staff','staff_services','staff_schedules','staff_time_off','availability_holds','booking_status_history','conversations','messages','calls','follow_up_queue','usage_events'];

export default async function handler(req,res){
  if(req.method!=='GET') return res.status(405).json({ok:false,error:'method_not_allowed'});
  const c=db(); if(!c)return res.status(503).json({ok:false,error:'database_not_configured'});
  const results={};
  for(const table of checks){
    try{ const {error}=await c.from(table).select('*',{head:true,count:'exact'}).limit(1); results[table]=error?{ok:false,error:error.message}:{ok:true}; }
    catch(e){ results[table]={ok:false,error:String(e?.message||e)}; }
  }
  const failed=Object.entries(results).filter(([,v])=>!v.ok).map(([k])=>k);
  return res.status(failed.length?503:200).json({ok:failed.length===0,failed,results,execution_route:'/api/lola-execute',crm_route:'/api/crm'});
}
