/**
 * /api/webhooks/whatsapp — Telnyx WhatsApp Webhook
 * ════════════════════════════════════════════════════════════════
 * Handles inbound WhatsApp messages routed via Telnyx.
 * 
 * Returns 202 immediately to clear the carrier connection,
 * then processes via the `WhatsAppSessionState` (Redis).
 */

import { getSessionState, appendSessionState } from '../lib/redis.js';
import { flushMeteredTextUsageToStripe } from '../lib/stripe.js';

const TELNYX = 'https://api.telnyx.com/v2';

export default async function handler(req, res){
  // 1. Instantly clear the carrier connection to prevent Telnyx timeouts
  res.status(202).end();

  try {
    const { data } = req.body;
    if(!data || data.event_type !== 'message.received') return;

    const payload = data.payload;
    const fromNumber = payload.from.phone_number;
    const toNumber = payload.to[0].phone_number;
    const incomingText = payload.text;

    // 2. Manage Distributed State via Redis
    const history = await appendSessionState(fromNumber, 'user', incomingText);

    // 3. (Mock) Call Telnyx AI Assistant "Lola" with the full Redis history
    // In production, we'd pass this to the Telnyx assistant chat endpoint
    const aiResponseText = `Hi! Lola here. I remember everything from our last ${history.length} messages. How can I help book your appointment?`;
    
    // Append Lola's response to the Redis state
    await appendSessionState(fromNumber, 'assistant', aiResponseText);

    // 4. Send the outbound WhatsApp reply via Telnyx
    if(process.env.TELNYX_API_KEY){
      await fetch(`${TELNYX}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
        },
        body: JSON.stringify({
          from: toNumber,
          to: fromNumber,
          text: aiResponseText,
          messaging_profile_id: process.env.TELNYX_MESSAGING_PROFILE
        })
      });
    }

    // 5. Automate Metered Billing: charge $0.05 per message
    // We pass a mock tenantId for the example
    const tenantId = 't_12345';
    await flushMeteredTextUsageToStripe(tenantId, 1);

  } catch(e) {
    console.error('[whatsapp-webhook] Async processing error:', e);
  }
}
