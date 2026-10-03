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
  // Older port orders were created with this (unsigned) URL. The payload is only used to NAME the
  // order — the engine re-reads its real state from Telnyx — so an unsigned event can't change data.
  if(/^porting_order\./.test(String(eventType))){
    try{
      const { handleTelecomEvent } = await import('../lib/setup/telecom.js');
      const pl = body?.data?.payload || body?.payload || {};
      const orderId = pl.porting_order_id || pl.id || null;
      // Only the order id is taken from an unsigned event (never comments, statuses or references).
      let timer = null;
      if(orderId) await Promise.race([handleTelecomEvent({ data: { event_type: 'porting_order.status_changed', payload: { id: String(orderId) } } }), new Promise((r) => { timer = setTimeout(r, 1500); })]);
      clearTimeout(timer);
    }catch(_){}
  }
  return res.status(200).json({ ok: true, event: eventType });
}
