/**
 * POST /api/billing/checkout  { plan, tenantId, email }
 * Returns { url } -> redirect the salon to Stripe Checkout.
 */
import { createCheckout } from '../lib/stripe.js';

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS') return res.status(200).end();
  if(req.method!=='POST') return res.status(405).json({ error:'POST only' });
  try{
    const body = typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});
    const { plan, tenantId, email, customerId, interval } = body;
    if(!plan) return res.status(400).json({ error:'plan required' });
    const session = await createCheckout({ plan, tenantId, email, customerId, interval: interval==='annual'?'annual':'monthly' });
    return res.status(200).json({ url: session.url, id: session.id });
  }catch(e){ return res.status(500).json({ error:String(e&&e.message||e) }); }
}
