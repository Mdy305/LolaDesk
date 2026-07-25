import { getUserFromToken, bearer } from '../lib/auth.js';
import { db } from '../lib/db.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';

function safePublicUrl(value){
  if(!value) return '';
  const url = new URL(String(value));
  if(!['http:','https:'].includes(url.protocol)) throw new Error('Only http/https URLs are supported');
  const host = url.hostname.toLowerCase();
  if(host === 'localhost' || host === '127.0.0.1' || host === '::1' || /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) throw new Error('Private network URLs are not allowed');
  return url.toString();
}

function extract(html){
  const text = String(html || '').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  const title = (String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]+>/g,' ').trim();
  const description = (String(html).match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)?.[1] || '').trim();
  const prices = [...text.matchAll(/(?:\$|USD\s?)(\d{2,5}(?:\.\d{1,2})?)/g)].slice(0,30).map(m=>Number(m[1]));
  return { title:title.slice(0,180), description:description.slice(0,500), summary:text.slice(0,6000), prices };
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'POST') return res.status(405).json({ok:false,error:'POST only'});
  try{
    const user = await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({ok:false,error:'Not authenticated'});
    const tenant = await resolveTenantForUser(user);
    if(!tenant?.id) return res.status(404).json({ok:false,error:'No tenant mapped to this account'});
    const client = db();
    if(!client) return res.status(503).json({ok:false,error:'Database not configured'});
    const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const websiteUrl = safePublicUrl(input.websiteUrl || input.website_url || tenant.website_url || '');
    if(!websiteUrl) return res.status(400).json({ok:false,error:'A website URL is required'});
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(),8000);
    let response;
    try{ response = await fetch(websiteUrl,{signal:controller.signal,headers:{'User-Agent':'LolaDesk-Business-Discovery/1.0'}}); }
    finally{ clearTimeout(timer); }
    if(!response.ok) throw new Error(`Website returned ${response.status}`);
    const html = (await response.text()).slice(0,750000);
    const discovered = extract(html);
    await client.from('tenants').update({website_url:websiteUrl,knowledge:{...(tenant.knowledge||{}),website:discovered},status:'onboarding_discovery'}).eq('id',tenant.id);
    await client.from('tenant_onboarding').update({stage:'discovery',status:'in_progress',progress:45,business:{website_url:websiteUrl,discovered},last_error:null,updated_at:new Date().toISOString()}).eq('tenant_id',tenant.id);
    return res.status(200).json({ok:true,tenant_id:tenant.id,dataPoints:[discovered.title,discovered.description,...discovered.prices].filter(Boolean).length,website:discovered});
  }catch(error){
    return res.status(500).json({ok:false,error:String(error?.message||error)});
  }
}
