/**
 * /api/telnyx-sims — Telnyx Wireless SIM Management & Private APN
 * ════════════════════════════════════════════════════════════════
 * LolaDesk is a telecom provider. Salons order physical Telnyx SIMs
 * directly from us for their booking iPads and front desk hardware.
 *
 * This ensures the Lola AI never goes offline due to spotty salon Wi-Fi.
 * The SIMs connect over a highly secure Telnyx Private APN.
 *
 * GET  /api/telnyx-sims            → List active SIMs for the salon
 * POST /api/telnyx-sims            → Order a new physical SIM
 *
 * ENV VARS:
 *   TELNYX_API_KEY
 */

const TELNYX = 'https://api.telnyx.com/v2';

function authHeaders(){
  return {
    'Content-Type':'application/json',
    'Authorization':`Bearer ${process.env.TELNYX_API_KEY}`
  };
}

// ── GET: List active SIMs for a Tenant ──
export async function handleGet(req, res){
  // Note: Telnyx allows tagging/filtering. In a real multi-tenant app,
  // we would filter by a tag like `tenant:${req.query.tenantId}`
  const r = await fetch(`${TELNYX}/sim_cards`, {
    headers: authHeaders()
  });
  const data = await r.json();
  
  if(!r.ok){
    return res.status(r.status).json({ error: data.errors });
  }

  return res.status(200).json({
    ok: true,
    sims: data.data || []
  });
}

// ── POST: Order a physical SIM to the Salon ──
export async function handlePost(req, res){
  const body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});
  
  // To order a SIM, Telnyx requires an address ID. 
  // For this architecture demo, we assume the salon address has already been 
  // registered in Telnyx via /v2/addresses, passing it as `address_id`.
  if(!body.address_id){
    return res.status(400).json({ error: 'Missing shipping address_id' });
  }

  const payload = {
    address_id: body.address_id,
    quantity: body.quantity || 1
  };

  const r = await fetch(`${TELNYX}/sim_card_orders`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload)
  });

  const data = await r.json();
  if(!r.ok){
    return res.status(r.status).json({ error: data.errors });
  }

  return res.status(200).json({
    ok: true,
    message: 'SIM ordered successfully. Your LolaDesk hardware will arrive connected via Private APN.',
    order: data.data
  });
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();

  if(!process.env.TELNYX_API_KEY){
    return res.status(500).json({ error: 'Missing TELNYX_API_KEY env var' });
  }

  try{
    if(req.method === 'GET') return await handleGet(req, res);
    if(req.method === 'POST') return await handlePost(req, res);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }catch(e){
    return res.status(500).json({ error: String(e) });
  }
}
