import { db, getTenantByPhone, getTenantBySlug } from './lib/db.js';
import { upsertProviderMapping } from './lib/booking-repository.js';

async function tenantFrom(req,body){
  if(body.tenant_id){ const c=db(); const {data}=await c.from('tenants').select('*').eq('id',body.tenant_id).maybeSingle(); return data; }
  if(body.tenant) return getTenantBySlug(body.tenant);
  return getTenantByPhone(body.to || req.query?.to || '');
}

export default async function handler(req,res){
  try{
    const body=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});
    const tenant=await tenantFrom(req,body);
    if(!tenant?.id) return res.status(404).json({ok:false,error:'tenant_not_found'});
    const c=db();
    if(req.method==='GET'){
      let q=c.from('provider_mappings').select('*').eq('tenant_id',tenant.id);
      if(req.query?.provider) q=q.eq('provider',req.query.provider);
      if(req.query?.entity_type) q=q.eq('entity_type',req.query.entity_type);
      const {data,error}=await q.order('provider').order('entity_type');
      if(error) throw error;
      return res.json({ok:true,mappings:data||[]});
    }
    if(req.method==='POST' || req.method==='PATCH'){
      for(const k of ['provider','entity_type','local_id','external_id']) if(!body[k]) return res.status(400).json({ok:false,error:`${k}_required`});
      const mapping=await upsertProviderMapping({
        tenantId:tenant.id,provider:body.provider,entityType:body.entity_type,localId:body.local_id,
        externalId:body.external_id,externalParentId:body.external_parent_id||null,metadata:body.metadata||{}
      });
      return res.json({ok:true,mapping});
    }
    return res.status(405).json({ok:false,error:'method_not_allowed'});
  }catch(e){return res.status(500).json({ok:false,error:String(e?.message||e)});}
}
