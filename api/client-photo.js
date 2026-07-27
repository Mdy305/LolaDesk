import { bearer, getUserFromToken } from './lib/auth.js';
import { db } from './lib/db.js';
import { resolveTenantForUser } from './lib/tenant-access.js';

function body(req){ return typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{}); }
export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
  res.setHeader('Cache-Control','no-store');
  if(req.method==='OPTIONS') return res.status(204).end();
  if(req.method!=='POST') return res.status(405).json({error:'POST only'});
  try{
    const user=await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({error:'Not authenticated'});
    const tenant=await resolveTenantForUser(user);
    if(!tenant?.id) return res.status(403).json({error:'No tenant mapped to this account'});
    const payload=body(req),clientId=String(payload.client_id||'');
    const match=String(payload.data_url||'').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if(!clientId||!match) return res.status(400).json({error:'client_id and a JPEG, PNG, or WebP photo are required'});
    const bytes=Buffer.from(match[2],'base64');
    if(!bytes.length||bytes.length>2097152) return res.status(413).json({error:'Photo must be 2 MB or smaller'});
    const c=db(); if(!c) return res.status(503).json({error:'Database not configured'});
    const {data:client,error:clientError}=await c.from('clients').select('id,profile_picture_url').eq('id',clientId).eq('tenant_id',tenant.id).maybeSingle();
    if(clientError||!client) return res.status(404).json({error:'Client not found'});
    const ext=match[1]==='image/png'?'png':match[1]==='image/webp'?'webp':'jpg';
    const path=tenant.id+'/'+clientId+'/'+Date.now()+'.'+ext;
    const {error:uploadError}=await c.storage.from('client-photos').upload(path,bytes,{contentType:match[1],upsert:false,cacheControl:'3600'});
    if(uploadError) throw uploadError;
    const {error:updateError}=await c.from('clients').update({profile_picture_url:path,updated_at:new Date().toISOString()}).eq('id',clientId).eq('tenant_id',tenant.id);
    if(updateError){ await c.storage.from('client-photos').remove([path]); throw updateError; }
    if(client.profile_picture_url) await c.storage.from('client-photos').remove([client.profile_picture_url]).catch(()=>{});
    const {data:signed}=await c.storage.from('client-photos').createSignedUrl(path,3600);
    return res.status(200).json({ok:true,path,url:signed?.signedUrl||null});
  }catch(error){ return res.status(500).json({error:String(error?.message||error)}); }
}
