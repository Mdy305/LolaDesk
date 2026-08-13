import { db, getTenantByPhone, getTenantBySlug } from './lib/db.js';

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
      const {data,error}=await c.from('resources').select('*').eq('tenant_id',tenant.id).order('name');
      if(error) throw error;
      return res.json({ok:true,resources:data||[]});
    }
    if(req.method==='POST'){
      const {data,error}=await c.from('resources').insert({
        tenant_id:tenant.id,location_id:body.location_id||null,name:body.name,
        resource_type:body.resource_type||'chair',capacity:Number(body.capacity||1),
        is_active:body.is_active!==false,metadata:body.metadata||{}
      }).select().single();
      if(error) throw error;
      return res.json({ok:true,resource:data});
    }
    if(req.method==='PATCH'){
      if(!body.id) return res.status(400).json({ok:false,error:'id_required'});
      const patch={};
      for(const k of ['name','resource_type','capacity','is_active','metadata','location_id']) if(k in body) patch[k]=body[k];
      const {data,error}=await c.from('resources').update(patch).eq('tenant_id',tenant.id).eq('id',body.id).select().single();
      if(error) throw error;
      return res.json({ok:true,resource:data});
    }
    return res.status(405).json({ok:false,error:'method_not_allowed'});
  }catch(e){return res.status(500).json({ok:false,error:String(e?.message||e)});}
}
