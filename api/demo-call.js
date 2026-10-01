/**
 * /api/demo-call — "Call my phone": Lola rings you and talks (see lib/demo-call.js).
 * POST { phone } → { ok, say, … }  · rate-limited per phone and per IP · US/Canada only
 */
import { db, e164, recentDemoRequestsByPhone } from './lib/db.js';
import { placeDemoCall } from './lib/demo-call.js';

export default async function handler(req, res){
  if(req.method !== 'POST') return res.status(405).end();
  const body = (typeof req.body === 'string' ? (()=>{ try{ return JSON.parse(req.body); }catch{ return {}; } })() : req.body) || {};
  const phone = body.phone || body.phone_number || body.to;
  if(!phone) return res.status(400).json({ error: 'missing phone', say: 'What number should I call?' });
  const phoneE = e164(phone);
  const c = db();
  if(!c) return res.status(500).json({ error: 'Supabase not configured', say: 'I can’t place calls from this address. Use loladesk.com.' });
  try{
    if(!/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(String(phoneE||''))) return res.status(400).json({ error: 'us_canada_numbers_only', say: 'I can call US and Canada numbers.' });
    const recent = await recentDemoRequestsByPhone(phoneE, 60);
    if(recent >= 3) return res.status(429).json({ error: 'rate_limited', say: 'I’ve called that number a few times already. Try again in an hour.' });
    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim() || null;
    if(ip){
      const { count } = await c.from('demo_requests').select('id', { count: 'exact', head: true }).eq('ip', ip).gte('created_at', new Date(Date.now() - 3600e3).toISOString());
      if((count || 0) >= 5) return res.status(429).json({ error: 'rate_limited', say: 'That’s a lot of calls from here. Try again in an hour.' });
    }
    let id = null;
    try{ const { data } = await c.from('demo_requests').insert({ phone_number: phoneE, ip }).select().maybeSingle(); id = data?.id || null; }catch{}
    const r = await placeDemoCall(c, phoneE);
    try{ if(id) await c.from('demo_requests').update({ processed: r.ok, metadata: r }).eq('id', id); }catch{}
    if(!r.ok) console.warn('[demo-call]', r.error, (r.tried || []).join(' | ').slice(0, 400));
    return res.status(200).json({ id, ...r, ...(r.ok ? { telnyx: { data: { call_control_id: r.call_control_id } } } : {}) });
  }catch(e){
    console.error('demo-call error', e);
    return res.status(500).json({ error: String(e?.message||e), say: 'Something went wrong placing the call. Try again in a moment.' });
  }
}
