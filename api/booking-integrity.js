import { bearer, getUserFromToken } from './lib/auth.js';
import { db } from './lib/db.js';
import { resolveTenantForUser } from './lib/tenant-access.js';

const READY_PROVIDERS = new Set(['square','boulevard','google_calendar']);
const CAPABILITIES = {
  square: ['availability','create','reschedule','cancel'],
  boulevard: ['availability','create','reschedule','cancel'],
  google_calendar: ['availability','create','reschedule','cancel'],
  vagaro: [], mindbody: [], fresha: [], booker: []
};

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
  if(req.method==='OPTIONS') return res.status(200).end();
  if(req.method!=='GET') return res.status(405).json({error:'GET only'});
  try{
    const user=await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({error:'not authenticated'});
    const tenant=await resolveTenantForUser(user);
    if(!tenant) return res.status(404).json({error:'no tenant found'});
    const c=db(); if(!c) return res.status(503).json({error:'database not configured'});
    const [{data:integrations,error:iErr},{data:bookings,error:bErr}]=await Promise.all([
      c.from('integrations').select('provider,status,expires_at,metadata,updated_at').eq('tenant_id',tenant.id),
      c.from('bookings').select('id,status,service:services(name),starts_at:start_time,created_at,price:total_amount').eq('tenant_id',tenant.id).order('created_at',{ascending:false}).limit(100)
    ]);
    if(iErr) throw new Error(iErr.message); if(bErr) throw new Error(bErr.message);
    const providers=(integrations||[]).map(row=>{
      const provider=String(row.provider||'').toLowerCase();
      const expired=row.expires_at && new Date(row.expires_at).getTime()<Date.now();
      const productionReady=READY_PROVIDERS.has(provider);
      const connected=row.status==='connected' && !expired;
      return {provider,status:connected?(productionReady?'ready':'connected_unsupported'):(expired?'expired':row.status||'disconnected'),production_ready:productionReady,capabilities:CAPABILITIES[provider]||[],expires_at:row.expires_at||null,updated_at:row.updated_at||null};
    });
    const rows=(bookings||[]).map(b=>({...b,service:b.service?.name||null}));
    const duplicates=[];
    const seen=new Map();
    for(const b of rows){
      const key=[b.service||'',b.starts_at||'',b.status||''].join('|');
      if(seen.has(key) && !['cancelled','completed'].includes(String(b.status))) duplicates.push({first_id:seen.get(key),duplicate_id:b.id,service:b.service,starts_at:b.starts_at});
      else seen.set(key,b.id);
    }
    const counts=rows.reduce((a,b)=>(a[b.status||'unknown']=(a[b.status||'unknown']||0)+1,a),{});
    const primary=providers.find(p=>p.production_ready&&p.status==='ready')||null;
    const blockers=[];
    if(!primary) blockers.push('Connect and verify Square, Boulevard, or Google Calendar before Lola confirms live bookings.');
    if(duplicates.length) blockers.push(`${duplicates.length} possible duplicate booking${duplicates.length===1?'':'s'} require review.`);
    if(!tenant.booking_url) blockers.push('Add a booking URL as a safe fallback.');
    const score=Math.max(0,100-(primary?0:55)-(duplicates.length?20:0)-(tenant.booking_url?0:15));
    return res.status(200).json({ok:true,score,can_book_live:!!primary&&duplicates.length===0,primary_provider:primary?.provider||null,providers,booking_counts:counts,possible_duplicates:duplicates,blockers,recent_bookings:rows.slice(0,20)});
  }catch(e){ return res.status(500).json({error:String(e?.message||e)}); }
}
