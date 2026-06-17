/**
 * /api/agent-variables — Telnyx Dynamic Variables Webhook
 * ════════════════════════════════════════════════════════════════
 * THE multi-tenant mechanism for the shared Lola assistant.
 *
 * ONE Lola assistant in Telnyx serves EVERY salon. Before Lola speaks,
 * Telnyx POSTs here with the called number. We resolve which salon owns
 * that number and return THAT salon's variables. Telnyx injects them
 * into the greeting + instructions, so the same assistant greets each
 * caller as the correct salon — with the right name, services, hours,
 * and the website knowledge we captured at onboarding.
 *
 * Set this URL in Telnyx → AI Assistants → your assistant →
 *   "Dynamic Variables Webhook URL":
 *   https://www.loladesk.com/api/agent-variables
 *
 * Telnyx sends the call context. The exact field names vary, so we
 * look for the called ("to") number across several common shapes.
 *
 * Returns the shape Telnyx expects:
 *   { "dynamic_variables": { company_name, services, hours, booking_url, ... } }
 *
 * ENV VARS:
 *   SUPABASE_URL · SUPABASE_SERVICE_KEY  (falls back to demo tenant if absent)
 */

import { getTenantByPhone, tenantKnowledgePrompt } from './lib/db.js';

function pickToNumber(body){
  // Telnyx dynamic-variables webhook payloads vary; check the common spots.
  return (
    body?.data?.payload?.to ||
    body?.payload?.to ||
    body?.to ||
    body?.data?.payload?.to_number ||
    body?.telephony_data?.to ||
    body?.call?.to ||
    (Array.isArray(body?.to) ? body.to[0]?.phone_number : null) ||
    body?.To ||
    ''
  );
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();

  try{
    const body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});
    // allow ?to= for easy testing in a browser/curl too
    const qTo = (()=>{ try{ return new URL(req.url,'http://x').searchParams.get('to'); }catch{ return null; } })();
    const toNumber = qTo || pickToNumber(body);

    const tenant = await getTenantByPhone(toNumber);

    const services = (tenant.services||[])
      .map(s => `${s.name}${s.price?` $${s.price}`:''}${s.duration?` (${s.duration})`:''}`)
      .join('; ');

    const dynamic_variables = {
      company_name: tenant.name || 'our salon',
      business_type: tenant.business_mode || 'salon',
      location: tenant.location || '',
      hours: tenant.hours || '',
      services: services || '',
      booking_url: tenant.booking_url || '',
      // a compact knowledge block Lola can lean on for tone/positioning
      knowledge: tenantKnowledgePrompt(tenant)
    };

    // Telnyx expects the variables under "dynamic_variables".
    return res.status(200).json({ dynamic_variables });
  }catch(e){
    // Never hard-fail the call — return safe generic variables.
    return res.status(200).json({
      dynamic_variables: {
        company_name: 'our salon',
        business_type: 'salon',
        services: '',
        hours: '',
        booking_url: ''
      },
      _error: String(e)
    });
  }
}
