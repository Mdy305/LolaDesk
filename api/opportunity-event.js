import { db } from './lib/db.js';
import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantAccessForUser } from './lib/tenant-access.js';

const ALLOWED=new Set(['opened','executed','dismissed']);

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method==='OPTIONS') return res.status(200).end();
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  try{
    const user=await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({error:'Not authenticated'});
    const access=await resolveTenantAccessForUser(user);
    const tenant=access?.tenant;
    if(!tenant?.id) return res.status(403).json({error:'No tenant mapped'});
    const body=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});
    const opportunityId=String(body.opportunityId||'').slice(0,80);
    const event=String(body.event||'').toLowerCase();
    if(!opportunityId||!ALLOWED.has(event)) return res.status(400).json({error:'Invalid opportunity event'});
    const clientIds=Array.isArray(body.clientIds)?body.clientIds.filter(Boolean).slice(0,50):[];
    const c=db();
    if(!c) return res.status(503).json({error:'Data service unavailable'});
    const metadata={
      opportunity_id:opportunityId,
      opportunity_type:String(body.type||'').slice(0,40),
      potential_revenue:Number(body.potentialRevenue||0),
      client_ids:clientIds,
      actor_user_id:user.id,
      actor_role:access?.role||'staff'
    };
    const {error}=await c.from('usage_events').insert({tenant_id:tenant.id,kind:`opportunity_${event}`,units:1,metadata});
    if(error) throw error;
    return res.status(200).json({ok:true,event,opportunityId});
  }catch(error){
    console.error('[opportunity-event]',error);
    return res.status(500).json({error:'Could not record opportunity action'});
  }
}
