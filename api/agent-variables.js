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

import { getTenantByPhone, getClientByPhone, tenantKnowledgePrompt } from './lib/db.js';

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

function pickFromNumber(body){
  // the CALLER's number — this is who Lola is talking to
  return (
    body?.data?.payload?.from ||
    body?.payload?.from ||
    body?.from ||
    body?.data?.payload?.from_number ||
    body?.telephony_data?.from ||
    body?.call?.from ||
    body?.From ||
    ''
  );
}

// Build the memory block that makes Lola feel like she KNOWS the caller.
function callerMemory(client){
  if(!client || !client.name){
    return { caller_known: 'false', caller_name: '', caller_brief: '' };
  }
  const bits = [];
  if(client.last_service) bits.push(`last came in for ${client.last_service}`);
  if(client.preferred_stylist) bits.push(`usually sees ${client.preferred_stylist}`);
  if(client.last_visit){
    const days = Math.floor((Date.now()-new Date(client.last_visit).getTime())/86400000);
    if(days>0 && days<400) bits.push(`last visit ~${days} days ago`);
  }
  if(client.is_vip) bits.push('is a VIP client');
  if(client.notes) bits.push(`note: ${client.notes}`);
  const brief = bits.length ? `${client.name} — ${bits.join(', ')}.` : `${client.name} is a returning client.`;
  return {
    caller_known: 'true',
    caller_name: client.name,
    caller_brief: brief,
    caller_vip: client.is_vip ? 'true' : 'false',
    caller_stylist: client.preferred_stylist || ''
  };
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
    const fromNumber = pickFromNumber(body);

    const tenant = await getTenantByPhone(toNumber);

    // ── CALLER RECOGNITION: the thing no competitor does well ──
    let memory = { caller_known:'false', caller_name:'', caller_brief:'' };
    try{
      if(tenant?.id && fromNumber){
        const client = await getClientByPhone(tenant.id, fromNumber);
        memory = callerMemory(client);
      }
    }catch(e){ /* never block the call on memory */ }

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
      knowledge: tenantKnowledgePrompt(tenant),
      // caller memory — lets Lola greet returning clients by name with context
      ...memory
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
