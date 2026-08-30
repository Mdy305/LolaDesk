import { db } from './lib/db.js';

// staff_services is a join table keyed by (staff_id, service_id) — it has no
// id column, so probe it with a column that actually exists.
const checks={
  tenants:'id', clients:'id', client_memories:'id', bookings:'id',
  services:'id', staff:'id', staff_services:'staff_id',
  staff_schedules:'id', staff_time_off:'id', availability_holds:'id',
  booking_status_history:'id', conversations:'id', messages:'id',
  calls:'id', follow_up_queue:'id', usage_events:'id'
};

export default async function handler(req,res){
  if(req.method!=='GET') return res.status(405).json({ok:false,error:'method_not_allowed'});
  const c=db(); if(!c)return res.status(503).json({ok:false,error:'database_not_configured'});
  const results={};
  for(const [table, col] of Object.entries(checks)){
    try{ const {error}=await c.from(table).select(col).limit(1); results[table]=error?{ok:false,error:error.message}:{ok:true}; }
    catch(e){ results[table]={ok:false,error:String(e?.message||e)}; }
  }
  const failed=Object.entries(results).filter(([,v])=>!v.ok).map(([k])=>k);
  return res.status(failed.length?503:200).json({ok:failed.length===0,failed,results,execution_route:'/api/lola-execute',crm_route:'/api/crm'});
}
