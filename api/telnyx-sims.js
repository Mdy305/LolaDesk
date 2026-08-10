/**
 * /api/telnyx-sims — Telnyx Wireless SIM Management & Private APN
 * ════════════════════════════════════════════════════════════════
 * LolaDesk is a telecom provider. Salons order physical Telnyx SIMs
 * directly from us for their booking iPads and front desk hardware.
 *
 * This ensures the Lola AI never goes offline due to spotty salon Wi-Fi.
 * The SIMs connect over a highly secure Telnyx Private APN.
 *
 * GET  /api/telnyx-sims            → List active SIMs for THIS salon only
 * POST /api/telnyx-sims            → Order a new physical SIM for THIS salon
 *
 * Tenant isolation: SIM orders are recorded in the local `tenant_sims`
 * table at order time. GET only ever returns Telnyx SIM cards that
 * match an order this tenant placed — never the account-wide list.
 * (Previously GET returned every tenant's SIMs to any authenticated
 * user, and POST never recorded which tenant an order belonged to at
 * all — see migrations/20260811_tenant_sims_isolation.sql.)
 *
 * ENV VARS:
 *   TELNYX_API_KEY
 */
import { getUserFromToken, bearer } from './lib/auth.js';
import { db } from './lib/db.js';
import { resolveTenantForUser } from './lib/tenant-access.js';

const TELNYX = 'https://api.telnyx.com/v2';

function authHeaders(){
  return {
    'Content-Type':'application/json',
    'Authorization':`Bearer ${process.env.TELNYX_API_KEY}`
  };
}

// ── GET: List active SIMs for THIS tenant only ──
export async function handleGet(req, res, tenant){
  const client = db();
  if(!client) return res.status(503).json({ error:'Database not configured' });

  const { data: orders } = await client.from('tenant_sims').select('*').eq('tenant_id', tenant.id);
  const rows = orders || [];
  if(!rows.length){
    return res.status(200).json({ ok:true, sims:[] });
  }

  const knownOrderIds = new Set(rows.map(r => r.telnyx_order_id).filter(Boolean));
  const knownSimIds = new Set(rows.map(r => r.telnyx_sim_id).filter(Boolean));

  const r = await fetch(`${TELNYX}/sim_cards`, { headers: authHeaders() });
  const data = await r.json();
  if(!r.ok) return res.status(r.status).json({ error: data.errors });

  // Only ever return SIMs that trace back to an order THIS tenant placed.
  const tenantSims = (data.data || []).filter(sim =>
    knownSimIds.has(sim.id) || (sim.sim_card_order_id && knownOrderIds.has(sim.sim_card_order_id))
  );

  return res.status(200).json({ ok:true, sims: tenantSims });
}

// ── POST: Order a physical SIM, recorded against THIS tenant ──
export async function handlePost(req, res, tenant){
  const body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});

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

  const client = db();
  if(client){
    await client.from('tenant_sims').insert({
      tenant_id: tenant.id,
      telnyx_order_id: data.data?.id || null,
      address_id: body.address_id,
      quantity: payload.quantity
    });
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(200).end();

  if(!process.env.TELNYX_API_KEY){
    return res.status(500).json({ error: 'Missing TELNYX_API_KEY env var' });
  }

  try{
    const user = await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({ error: 'Unauthorized' });
    const tenant = await resolveTenantForUser(user);
    if(!tenant?.id) return res.status(404).json({ error: 'No salon found for this account' });

    if(req.method === 'GET') return await handleGet(req, res, tenant);
    if(req.method === 'POST') return await handlePost(req, res, tenant);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }catch(e){
    return res.status(500).json({ error: String(e) });
  }
}
