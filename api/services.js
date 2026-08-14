import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db } from './lib/db.js';

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,DELETE,OPTIONS');
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
      const {data,error}=await c.from('services').select('id,name,description,duration_minutes,price,is_active,active_duration_1_min,processing_duration_min,active_duration_2_min').eq('tenant_id',tenant.id).order('name');
      if(error)throw error;
      return res.json({ok:true,services:data||[]});
    }

    if(req.method==='POST'){
      const b=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});
      const {id,name,description,duration_minutes,price,is_active}=b;
      if(!name)return res.status(400).json({ok:false,error:'Name is required'});
      const row={tenant_id:tenant.id,name:name.trim(),description:description||'',duration_minutes:Number(duration_minutes||60),price:price!=null?Number(price):0,is_active:is_active!==false};
      const {data,error}=id
        ?await c.from('services').update(row).eq('id',id).eq('tenant_id',tenant.id).select().single()
        :await c.from('services').insert(row).select().single();
      if(error)throw error;
      return res.json({ok:true,service:data});
    }

    if(req.method==='DELETE'){
      const id=req.query?.id;
      if(!id)return res.status(400).json({ok:false,error:'Missing id'});
      const {error}=await c.from('services').update({is_active:false}).eq('id',id).eq('tenant_id',tenant.id);
      if(error)throw error;
      return res.json({ok:true});
    }
    return res.status(405).json({ok:false,error:'Method not allowed'});
  }catch(e){return res.status(500).json({ok:false,error:String(e?.message||e)});}
}
