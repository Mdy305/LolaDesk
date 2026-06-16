import { getTenantByPhone, tenantKnowledgePrompt } from './lib/db.js';

function pickToNumber(body){
  return (
    body?.data?.payload?.to ||
    body?.payload?.to ||
    body?.to ||
    body?.data?.payload?.to_number ||
    body?.telephony_data?.to ||
    body?.call?.to ||
    (Array.isArray(body?.to) ? body.to[0]?.phone_number : null) ||
    body?.To || ''
  );
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();
  try{
    const body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});
    const qTo = (()=>{ try{ return new URL(req.url,'http://x').searchParams.get('to'); }catch{ return null; } })();
    const toNumber = qTo || pickToNumber(body);
    const tenant = await getTenantByPhone(toNumber);
    const services = (tenant.services||[]).map(s => `${s.name}${s.price?` $${s.price}`:''}${s.duration?` (${s.duration})`:''}`).join('; ');
    const dynamic_variables = {
      company_name: tenant.name || 'our salon',
      business_type: tenant.business_mode || 'salon',
      location: tenant.location || '',
      hours: tenant.hours || '',
      services: services || '',
      booking_url: tenant.booking_url || '',
      knowledge: tenantKnowledgePrompt(tenant)
    };
    return res.status(200).json({ dynamic_variables });
  }catch(e){
    return res.status(200).json({ dynamic_variables: { company_name:'our salon', business_type:'salon', services:'', hours:'', booking_url:'' }, _error:String(e) });
  }
}
