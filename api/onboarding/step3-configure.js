import { getUserFromToken, bearer } from '../lib/auth.js';
import { db } from '../lib/db.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';

function cleanServices(value){
  if(!Array.isArray(value)) return [];
  return value.slice(0,100).map(service=>({
    name:String(service?.name || '').trim().slice(0,120),
    price:Number(service?.price || 0),
    duration:String(service?.duration || service?.dur || '').trim().slice(0,40)
  })).filter(service=>service.name);
}
function safeUrl(value){
  const raw=String(value||'').trim();
  if(!raw) return '';
  try{
    const url=new URL(raw);
    if(!['http:','https:'].includes(url.protocol)) return '';
    return url.toString().slice(0,1000);
  }catch{return '';}
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'POST') return res.status(405).json({ ok:false, error:'POST only' });

  try{
    const user = await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({ ok:false, error:'Not authenticated' });
    const tenant = await resolveTenantForUser(user);
    if(!tenant?.id) return res.status(404).json({ ok:false, error:'No tenant mapped to this account' });
    const client = db();
    if(!client) return res.status(503).json({ ok:false, error:'Database not configured' });

    const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const personality = String(input.personality || input.persona || 'warm').trim().slice(0,80);
    const voice = String(input.voiceType || input.voice || 'lola').trim().slice(0,80);
    const services = cleanServices(input.selectedServices || input.services);
    const bookingUrl = safeUrl(input.bookingUrl || input.booking_url);
    const platform = String(input.platform || 'link').toLowerCase().replace(/[^a-z0-9_-]/g,'').slice(0,40);
    if(!bookingUrl) return res.status(400).json({ ok:false, error:'A valid booking URL is required' });

    const tenantResult = await client.from('tenants').update({
      persona:personality,
      lolabrain_voice:voice,
      lolabrain_personality:personality,
      services,
      booking_url:bookingUrl,
      status:'onboarding_configuration'
    }).eq('id', tenant.id).select().single();
    if(tenantResult.error) throw tenantResult.error;

    const onboardingResult = await client.from('tenant_onboarding').update({
      stage:'configuration',
      status:'in_progress',
      progress:75,
      booking:{ booking_url:bookingUrl, platform },
      persona:{ persona:personality, voice },
      provisioning:{ services_count:services.length, booking_connected:true, booking_provider:platform },
      last_error:null,
      updated_at:new Date().toISOString()
    }).eq('tenant_id', tenant.id);
    if(onboardingResult.error) throw onboardingResult.error;

    return res.status(200).json({ ok:true, configured:true, tenant_id:tenant.id, services_count:services.length, booking:{ url:bookingUrl, platform } });
  }catch(error){
    return res.status(500).json({ ok:false, error:String(error?.message || error) });
  }
}