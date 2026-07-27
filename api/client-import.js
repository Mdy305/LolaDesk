import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { parseContactText, saveContacts } from './lib/client-records.js';

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
    const payload=body(req);
    const contacts=Array.isArray(payload.contacts)?payload.contacts:parseContactText(payload.raw_text||'');
    if(!contacts.length) return res.status(400).json({error:'No valid contacts found'});
    if(contacts.length>2000) return res.status(413).json({error:'Import is limited to 2,000 contacts at a time'});
    const result=await saveContacts(tenant.id,contacts);
    return res.status(200).json({ok:true,...result});
  }catch(error){ return res.status(500).json({error:String(error?.message||error)}); }
}
