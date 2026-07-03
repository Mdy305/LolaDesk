/**
 * /api/webhooks/telnyx — Generic Telnyx webhook sink
 * Used by number porting and future async Telnyx event callbacks.
 */
export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const body = typeof req.body === 'string' ? (() => { try{ return JSON.parse(req.body); }catch{ return {}; } })() : (req.body || {});
  const eventType = body?.data?.event_type || body?.event_type || 'unknown';
  console.log('[telnyx-webhook]', eventType);
  return res.status(200).json({ ok: true, event: eventType });
}
