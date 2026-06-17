/**
 * POST /api/billing/portal  { customerId }
 * Returns { url } -> salon manages/cancels their subscription.
 */
import { createPortal } from '../lib/stripe.js';

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS') return res.status(200).end();
  if(req.method!=='POST') return res.status(405).json({ error:'POST only' });
  try{
    const body = typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});
    if(!body.customerId) return res.status(400).json({ error:'customerId required' });
    const session = await createPortal({ customerId: body.customerId });
    return res.status(200).json({ url: session.url });
  }catch(e){ return res.status(500).json({ error:String(e&&e.message||e) }); }
}
