import { bearer, getUserFromToken } from './lib/auth.js';
import { db } from './lib/db.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { saveContacts, signClientPhotos } from './lib/client-records.js';

function body(req){ return typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{}); }
export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
  res.setHeader('Cache-Control','no-store');
  if(req.method==='OPTIONS') return res.status(204).end();
  try{
    const user=await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({error:'Not authenticated'});
    const tenant=await resolveTenantForUser(user);
    if(!tenant?.id) return res.status(403).json({error:'No tenant mapped to this account'});
    if(req.method==='POST'){
      const input=body(req);
      // Dedicated client WhatsApp opt-in toggle (booking reminders prefer
      // WhatsApp when a salon has it connected AND the client is enabled).
      if(typeof input.whatsapp_enabled === 'boolean' && input.id){
        const client=db(); if(!client) return res.status(503).json({error:'Database not configured'});
        const { data, error }=await client.from('clients')
          .update({ whatsapp_enabled: input.whatsapp_enabled, updated_at: new Date().toISOString() })
          .eq('tenant_id', tenant.id).eq('id', input.id)
          .select('id,first_name,last_name,name,phone,whatsapp_enabled').maybeSingle();
        if(error) throw error;
        if(!data) return res.status(404).json({error:'Client not found'});
        return res.status(200).json({ok:true,client:data});
      }
      const result=await saveContacts(tenant.id,[input]);
      return res.status(201).json({ok:true,...result,client:result.clients[0]||null});
    }
    if(req.method!=='GET') return res.status(405).json({error:'GET or POST only'});
    const c=db(); if(!c) return res.status(503).json({error:'Database not configured'});
    const {data,error}=await c.from('clients').select('id,first_name,last_name,phone,email,profile_picture_url,notes,preferred_service,lifetime_value,last_visit,status,whatsapp_enabled,created_at,updated_at').eq('tenant_id',tenant.id).order('updated_at',{ascending:false}).limit(2000);
    if(error) throw error;
    const clients=await signClientPhotos(data||[]);
    return res.status(200).json({ok:true,tenant:tenant.name,clients});
  }catch(error){ return res.status(500).json({error:String(error?.message||error)}); }
}
