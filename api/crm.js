import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantAccessForUser } from './lib/tenant-access.js';
import crm from './lib/lola-crm.js';
import { db } from './lib/db.js';

function bodyOf(req){ if(!req.body)return {}; if(typeof req.body==='string'){try{return JSON.parse(req.body||'{}')}catch{return {}}} return req.body; }

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin',process.env.APP_ORIGIN||'https://www.loladesk.com');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  if(req.method==='OPTIONS') return res.status(204).end();
  if(!['GET','POST','PATCH'].includes(req.method)) return res.status(405).json({ok:false,error:'method_not_allowed'});
  try{
    const user=await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({ok:false,error:'not_authenticated'});
    const access=await resolveTenantAccessForUser(user), tenant=access?.tenant;
    if(!tenant?.id) return res.status(403).json({ok:false,error:'tenant_not_mapped'});
    const body=bodyOf(req), action=body.action||req.query?.action||(req.method==='GET'?'list':'');
    if(action==='list'){
      const c=db(); if(!c)return res.status(503).json({ok:false,error:'database_not_configured'});
      const limit=Math.min(200,Math.max(1,Number(req.query?.limit||body.limit||100)));
      const {data,error}=await c.from('clients').select('*').eq('tenant_id',tenant.id).order('updated_at',{ascending:false}).limit(limit); if(error)throw error;
      return res.json({ok:true,clients:data||[]});
    }
    if(action==='insights'){
      const id=body.client_id||req.query?.client_id; if(!id)return res.status(400).json({ok:false,error:'client_id_required'});
      return res.json({ok:true,context:await crm.getClientInsights(id,tenant.id)});
    }
    if(action==='segment') return res.json({ok:true,clients:await crm.getClientsBySegment(tenant.id,body.segment||req.query?.segment||'all')});
    if(action==='vip') return res.json({ok:true,clients:await crm.getVIPClients(tenant.id)});
    if(action==='follow_up') return res.json({ok:true,clients:await crm.getClientsForFollowUp(tenant.id,Number(body.limit||50))});
    if(action==='upsert') return res.json({ok:true,client:await crm.upsertClient(tenant.id,body.client||body)});
    if(action==='remember'){
      if(!body.client_id||!body.key)return res.status(400).json({ok:false,error:'client_id_and_key_required'});
      return res.json({ok:true,memory:await crm.rememberClientDetail(body.client_id,tenant.id,{key:body.key,value:body.value,phone:body.phone||null})});
    }
    if(action==='memory'){
      const id=body.client_id||req.query?.client_id; if(!id)return res.status(400).json({ok:false,error:'client_id_required'});
      return res.json({ok:true,memory:await crm.getClientMemory(id,tenant.id,body.key||req.query?.key||null)});
    }
    return res.status(400).json({ok:false,error:'unknown_action'});
  }catch(error){ console.error('[crm]',error); return res.status(500).json({ok:false,error:'crm_error'}); }
}
