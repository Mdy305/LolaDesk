/**
 * /api/demo-call — enqueue a demo request and (optionally) trigger Telnyx outbound call
 * POST { phone }
 *
 * - rate-limits by phone (recentDemoRequestsByPhone)
 * - inserts into demo_requests
 * - if TELNYX_API_KEY present, attempts outbound call using Telnyx Calls API
 */

import { db, e164, enqueueDemoRequest, recentDemoRequestsByPhone } from './lib/db.js';

export default async function handler(req, res){
  if(req.method !== 'POST') return res.status(405).end();
  const body = req.body || {};
  const phone = body.phone || body.phone_number || body.to;
  if(!phone) return res.status(400).json({ error: 'missing phone' });
  const phoneE = e164(phone);

  const c = db();
  if(!c) return res.status(500).json({ error: 'Supabase not configured' });

  try{
    // rate limit: max 3 requests per hour per phone
    const recent = await recentDemoRequestsByPhone(phoneE, 60);
    if(recent >= 3) return res.status(429).json({ error: 'rate_limited' });

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    const { data } = await c.from('demo_requests').insert({ phone_number: phoneE, ip }).select().maybeSingle();
    const id = data?.id;

    // Try to trigger Telnyx outbound call if configured
    const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
    const TELNYX_VOICE_APP_ID = process.env.TELNYX_VOICE_APP_ID;
    const FROM_NUMBER = process.env.DEMO_FROM_NUMBER || process.env.TELNYX_FROM_NUMBER;

    if(TELNYX_API_KEY && TELNYX_VOICE_APP_ID && FROM_NUMBER){
      // note: this code uses Telnyx Call Control to create an outbound call
      try{
        const telnyxResp = await fetch('https://api.telnyx.com/v2/calls', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${TELNYX_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            connection_id: TELNYX_VOICE_APP_ID,
            from: FROM_NUMBER,
            to: phoneE,
            // optional event webhook URL: TELNYX_CALLBACK_URL
            if_machine: 'continue'
          })
        });
        const telnyxJson = await telnyxResp.json();
        // log telnyx response into demo_requests metadata
        await c.from('demo_requests').update({ processed: true, metadata: telnyxJson }).eq('id', id);
        return res.status(200).json({ id, telnyx: telnyxJson });
      }catch(e){
        console.error('telnyx call failed', e);
        return res.status(200).json({ id, telnyx_error: String(e?.message||e) });
      }
    }

    return res.status(200).json({ id, queued: true });
  }catch(e){
    console.error('demo-call error', e);
    return res.status(500).json({ error: String(e?.message||e) });
  }
}
