/**
 * /api/telnyx-porting — Telnyx Number Porting API
 * ════════════════════════════════════════════════════════════════
 * LolaDesk handles migrating the salon's legacy business number into
 * our Telnyx infrastructure so Lola can answer their main line.
 *
 * GET  /api/telnyx-porting            → List porting orders for a tenant
 * POST /api/telnyx-porting            → Create a new porting order
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

// ── GET: List Porting Orders ──
export async function handleGet(req, res){
  const r = await fetch(`${TELNYX}/porting_orders`, {
    headers: authHeaders()
  });
  const data = await r.json();
  
  if(!r.ok){
    return res.status(r.status).json({ error: data.errors });
  }

  return res.status(200).json({
    ok: true,
    orders: data.data || []
  });
}

// ── POST: Create a Porting Order ──
export async function handlePost(req, res){
  const body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});
  
  // Telnyx porting requires a list of phone numbers and a webhook_url for status updates
  if(!body.phone_numbers || !Array.isArray(body.phone_numbers)){
    return res.status(400).json({ error: 'Missing phone_numbers array' });
  }

  const payload = {
    phone_numbers: body.phone_numbers,
    webhook_url: `${process.env.APP_URL || 'https://www.loladesk.com'}/api/webhooks/telnyx`,
    customer_reference: body.tenantId || 'loladesk_port'
  };

  const r = await fetch(`${TELNYX}/porting_orders`, {
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
    message: 'Porting order initiated. Lola will soon be managing this number.',
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
