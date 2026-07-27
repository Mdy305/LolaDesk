import { admin } from '../lib/auth.js';

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  res.setHeader('Cache-Control','no-store');
  if(req.method==='OPTIONS') return res.status(204).end();
  if(req.method!=='POST') return res.status(405).json({error:'POST only'});
  try{
    const body=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});
    const refreshToken=String(body.refresh_token||'');
    if(!refreshToken) return res.status(400).json({error:'refresh_token required'});
    const client=admin();
    if(!client) return res.status(503).json({error:'Auth not configured'});
    const {data,error}=await client.auth.refreshSession({refresh_token:refreshToken});
    if(error||!data?.session) return res.status(401).json({error:error?.message||'Session could not be renewed'});
    return res.status(200).json({session:data.session,user:data.user});
  }catch(error){
    return res.status(401).json({error:String(error?.message||error)});
  }
}
