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
    const c=db();if(!c)return res.status(503).json({ok:false,error:'Database not configured'});
    if(req.method==='GET'){
      const {data,error}=await c.from('staff').select('id,name,role,is_active,created_at').eq('tenant_id',tenant.id).eq('is_active',true).order('name');
      if(error)throw error;
      return res.json({ok:true,staff:data||[]});
    }
    if(req.method==='POST'){
      const b=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});
      if(!b.name)return res.status(400).json({ok:false,error:'Name is required'});
      const row={tenant_id:tenant.id,name:b.name.trim(),role:b.role||'Stylist',is_active:b.is_active!==false};
      const {data,error}=b.id
        ?await c.from('staff').update(row).eq('id',b.id).eq('tenant_id',tenant.id).select().single()
        :await c.from('staff').insert(row).select().single();
      if(error)throw error;
      return res.json({ok:true,staff:data});
    }
    if(req.method==='DELETE'){
      const id=req.query?.id;if(!id)return res.status(400).json({ok:false,error:'Missing id'});
      const {error}=await c.from('staff').update({is_active:false}).eq('id',id).eq('tenant_id',tenant.id);
      if(error)throw error;return res.json({ok:true});
    }
    return res.status(405).json({ok:false,error:'Method not allowed'});
  }catch(e){return res.status(500).json({ok:false,error:String(e?.message||e)});}
}
