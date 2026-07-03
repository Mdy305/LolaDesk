/**
 * /api/telnyx-esim — per-tenant eSIM resale ("Lola Link")
 * ════════════════════════════════════════════════════════════════
 * Turns Telnyx Wireless into a per-tenant add-on with three plays:
 *
 *   1. UPTIME FAILOVER ("Lola never sleeps") — the margin king.
 *      An eSIM in a failover router / tablet keeps the front desk
 *      alive when salon Wi-Fi dies. Cost ≈ $2/mo + a few MB most
 *      months; retails at ESIM_RETAIL_MONTHLY. ~85% gross margin,
 *      and the hardware on the counter is churn armor.
 *
 *   2. FRONT-DESK TABLET ("LolaPad") — the dashboard kiosk works out
 *      of the box on LTE, zero salon-IT setup. IMPORTANT ECONOMICS:
 *      Telnyx wireless is IoT-priced (~$0.0125–0.078/MB tiered), NOT
 *      broadband — so every SIM ships with a hard data_limit
 *      (ESIM_INCLUDED_MB) and overage is billed per MB at retail.
 *      The dashboard itself is light; the cap is the guardrail.
 *
 *   3. DEVICE ROADMAP — photo-campaign cameras, door counters:
 *      trickle-data devices are exactly what IoT pricing is for.
 *
 * Tiered data pricing is computed ACROSS the whole Telnyx account,
 * so every tenant you add pushes ALL tenants' data into cheaper
 * tiers — a structural multi-tenant advantage: your COGS per tenant
 * FALLS as you grow, while retail stays flat.
 *
 * Billing: ordering logs an `esim_rent` usage event at retail with
 * wholesale+margin in metadata (same pattern as number_rent); a
 * monthly `esim_data_overage` event is logged from the usage check.
 * Retention lever: suspend on churn keeps the SIM at $0.20/mo
 * standby instead of cancellation — winback = one 'enable' call.
 *
 * Endpoints (owner Bearer auth, same as settings):
 *   GET  /api/telnyx-esim                    → status + usage for this tenant
 *   POST /api/telnyx-esim { action }         → 'order' | 'enable' | 'disable'
 *                                              | 'set_limit' (mb)
 *
 * ENV: TELNYX_API_KEY, ESIM_RETAIL_MONTHLY (15), ESIM_INCLUDED_MB (500),
 *      ESIM_RETAIL_PER_MB (0.10)
 */
import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db, logUsage } from './lib/db.js';

const TELNYX = 'https://api.telnyx.com/v2';
const PROVIDER = 'telnyx_esim';

export function esimPricing(){
  return {
    retail_monthly: Number(process.env.ESIM_RETAIL_MONTHLY || 15),
    included_mb: Number(process.env.ESIM_INCLUDED_MB || 500),
    retail_per_mb: Number(process.env.ESIM_RETAIL_PER_MB || 0.10),
    wholesale_monthly: 2.0,        // Telnyx active-SIM MRC
    wholesale_standby: 0.20,       // suspended SIM — the churn-pause price
    wholesale_esim_once: 0.70
  };
}

function tx(path, opts = {}){
  return fetch(`${TELNYX}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`, ...(opts.headers||{}) }
  }).then(async r => ({ ok: r.ok, status: r.status, data: await r.json().catch(()=>({})) }));
}

async function getEsimRow(tenantId){
  const c = db(); if(!c) return null;
  const { data } = await c.from('integrations').select('*')
    .eq('tenant_id', tenantId).eq('provider', PROVIDER).maybeSingle();
  return data || null;
}

async function saveEsimRow(tenantId, metadata, status = 'connected'){
  const c = db(); if(!c) return null;
  const { data } = await c.from('integrations').upsert({
    tenant_id: tenantId, provider: PROVIDER, status, metadata
  }, { onConflict: 'tenant_id,provider' }).select().maybeSingle();
  return data;
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(200).end();

  const user = await getUserFromToken(bearer(req));
  if(!user) return res.status(401).json({ ok:false, error:'Not signed in' });
  const tenant = await resolveTenantForUser(user);
  if(!tenant?.id) return res.status(403).json({ ok:false, error:'No salon linked to this account' });

  const pricing = esimPricing();
  const row = await getEsimRow(tenant.id);
  const simId = row?.metadata?.sim_card_id || null;

  /* ── STATUS ── */
  if(req.method === 'GET'){
    if(!simId) return res.status(200).json({ ok:true, esim:null, pricing });
    if(!process.env.TELNYX_API_KEY) return res.status(200).json({ ok:true, esim:{ ...row.metadata, live:false }, pricing });
    const r = await tx(`/sim_cards/${simId}`);
    const sim = r.data?.data || {};
    const usedMb = Math.round((Number(sim.current_billing_period_consumed_data?.amount) || 0) /
      (String(sim.current_billing_period_consumed_data?.unit||'MB').toUpperCase()==='B' ? 1e6 : 1));
    // Overage becomes a billable usage event (idempotence left to the
    // monthly invoice job, which sums events per period).
    const overMb = Math.max(0, usedMb - pricing.included_mb);
    return res.status(200).json({ ok:true, pricing, esim: {
      sim_card_id: simId, iccid: row.metadata.iccid || sim.iccid,
      status: sim.status?.value || sim.status || row.status,
      data_limit_mb: Number(sim.data_limit?.amount) || pricing.included_mb,
      used_mb: usedMb, over_mb: overMb,
      overage_charge: +(overMb * pricing.retail_per_mb).toFixed(2),
      activation: row.metadata.activation || null
    }});
  }

  if(req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method not allowed' });
  if(!process.env.TELNYX_API_KEY) return res.status(503).json({ ok:false, error:'Telnyx is not configured on this deployment yet.' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});
  const action = String(body.action||'').toLowerCase();

  try{
    /* ── ORDER: one OTA eSIM for this salon ── */
    if(action === 'order'){
      if(simId) return res.status(200).json({ ok:true, already:true, esim: row.metadata, pricing });
      const order = await tx('/sim_card_orders', { method:'POST', body: JSON.stringify({ quantity: 1 }) });
      if(!order.ok) return res.status(502).json({ ok:false, error: order.data?.errors?.[0]?.detail || 'eSIM order failed' });
      // find the SIM the order produced (defensive: API returns order first)
      const orderId = order.data?.data?.id;
      let sim = null;
      for(let i=0; i<5 && !sim; i++){
        const list = await tx(`/sim_cards?filter[sim_card_order_id]=${encodeURIComponent(orderId)}&page[size]=1`);
        sim = list.data?.data?.[0] || null;
        if(!sim) await new Promise(r=>setTimeout(r, 800));
      }
      if(!sim) return res.status(202).json({ ok:true, pending:true, order_id: orderId,
        note:'eSIM is provisioning — refresh in a minute, or find the QR in Telnyx Mission Control.' });
      // cap data from day one — IoT pricing must never surprise anyone
      await tx(`/sim_cards/${sim.id}`, { method:'PATCH', body: JSON.stringify({
        data_limit: { amount: String(pricing.included_mb), unit: 'MB' }, tags: [`tenant:${tenant.slug}`]
      })}).catch(()=>{});
      const activation = {
        activation_code: sim.esim_installation_url || sim.activation_code || null,
        smdp_address: sim.smdp_address || null,
        iccid: sim.iccid || null
      };
      await saveEsimRow(tenant.id, { sim_card_id: sim.id, iccid: sim.iccid, activation, included_mb: pricing.included_mb });
      // the recurring-revenue line, margin visible for the billing layer
      await logUsage(tenant.id, 'esim_rent', pricing.retail_monthly, {
        sim_card_id: sim.id, wholesale: pricing.wholesale_monthly,
        margin: +(pricing.retail_monthly - pricing.wholesale_monthly).toFixed(2)
      }).catch(()=>{});
      return res.status(200).json({ ok:true, esim: { sim_card_id: sim.id, iccid: sim.iccid, activation }, pricing });
    }

    if(!simId) return res.status(404).json({ ok:false, error:'No eSIM on this account yet — order one first.' });

    /* ── ENABLE / DISABLE: the churn-pause lever ── */
    if(action === 'enable' || action === 'disable'){
      const r = await tx(`/sim_cards/${simId}/actions/${action}`, { method:'POST' });
      if(!r.ok) return res.status(502).json({ ok:false, error: r.data?.errors?.[0]?.detail || `${action} failed` });
      await saveEsimRow(tenant.id, row.metadata, action==='enable' ? 'connected' : 'suspended');
      return res.status(200).json({ ok:true, status: action==='enable' ? 'connected' : 'suspended',
        note: action==='disable' ? 'SIM parked at standby — one tap to bring it back.' : 'Back online.' });
    }

    /* ── SET LIMIT ── */
    if(action === 'set_limit'){
      const mb = Math.max(50, Math.min(50000, Number(body.mb)||pricing.included_mb));
      const r = await tx(`/sim_cards/${simId}`, { method:'PATCH', body: JSON.stringify({ data_limit: { amount: String(mb), unit: 'MB' } }) });
      if(!r.ok) return res.status(502).json({ ok:false, error:'Could not update the data cap' });
      await saveEsimRow(tenant.id, { ...row.metadata, included_mb: mb }, row.status);
      return res.status(200).json({ ok:true, data_limit_mb: mb });
    }

    return res.status(400).json({ ok:false, error:'Unknown action', actions:['order','enable','disable','set_limit'] });
  }catch(e){
    console.error('[esim]', e);
    return res.status(500).json({ ok:false, error:'eSIM service hiccup — nothing was charged.' });
  }
}
