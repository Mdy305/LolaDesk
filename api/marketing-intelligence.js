/**
 * api/marketing-intelligence.js — persist and retrieve marketing brain data
 * Every website analysis, strategy, and campaign gets saved so Lola
 * learns what works for this specific salon over time.
 */
import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db } from './lib/db.js';

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  if(req.method==='OPTIONS')return res.status(204).end();
  try{
    const user=await getUserFromToken(bearer(req));
    if(!user)return res.status(401).json({ok:false,error:'Not authenticated'});
    const tenant=await resolveTenantForUser(user);
    if(!tenant?.id)return res.status(404).json({ok:false,error:'No tenant found'});
    const c=db();
    if(!c)return res.status(503).json({ok:false,error:'Database not configured'});

    if(req.method==='GET'){
      const kind=req.query?.kind;
      let q=c.from('marketing_intelligence').select('*').eq('tenant_id',tenant.id).order('created_at',{ascending:false}).limit(50);
      if(kind)q=q.eq('kind',kind);
      const {data,error}=await q;
      if(error)throw error;
      return res.json({ok:true,items:data||[]});
    }

    const body=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});

    if(req.method==='POST'){
      const {kind,source_url,title,summary,data:payload,performance}=body;
      if(!kind)return res.status(400).json({ok:false,error:'kind required (analysis|strategy|campaign|result)'});
      const row={
        tenant_id:tenant.id,
        kind,
        source_url:source_url||null,
        title:title||null,
        summary:summary||null,
        data:payload||{},
        performance:performance||{}
      };
      const {data:saved,error}=await c.from('marketing_intelligence').insert(row).select().single();
      if(error)throw error;
      return res.json({ok:true,item:saved});
    }

    if(req.method==='PATCH'){
      const {id,performance,summary}=body;
      if(!id)return res.status(400).json({ok:false,error:'id required'});
      const patch={updated_at:new Date().toISOString()};
      if(performance)patch.performance=performance;
      if(summary)patch.summary=summary;
      const {data:saved,error}=await c.from('marketing_intelligence').update(patch).eq('id',id).eq('tenant_id',tenant.id).select().single();
      if(error)throw error;
      return res.json({ok:true,item:saved});
    }

    return res.status(405).json({ok:false,error:'Method not allowed'});
  }catch(e){
    return res.status(500).json({ok:false,error:String(e?.message||e)});
  }
}
