/**
 * /api/webhooks/telnyx-insights — Telnyx AI Assistant post-call insights
 * ════════════════════════════════════════════════════════════════════
 * Receives `call.conversation_insights.generated` events from the LolaBrain
 * insight group's webhook and lands each conversation's summary, outcome,
 * and transcript on the tenant's Calls page automatically.
 *
 * POST /api/webhooks/telnyx-insights
 *
 * Tenant resolution: the event carries only call ids, so the tenant comes from
 * the call_sessions map that /api/agent-variables records at conversation
 * start (it knows the dialed number), falling back to an existing calls row.
 * Exactly-once: calls.insight_id unique index skips redelivered events.
 *
 * The endpoint never crashes on garbage or unknown calls — it acknowledges
 * and ignores so Telnyx stops retrying. Signature-verified when
 * TELNYX_PUBLIC_KEY is set (production), skipped in non-production.
 */
import { db } from '../lib/db.js';
import { parseInsightsEvent, classifyResults, persistCallInsights, markConversationEnded } from '../lib/call-insights.js';
import { rawBody, verifyTelnyxSignature } from '../lib/telnyx-webhook-verify.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const payload = rawBody(req);
  if (!verifyTelnyxSignature(req, payload)) {
    return res.status(401).json({ error: 'Invalid Telnyx webhook signature' });
  }

  let event;
  try { event = JSON.parse(payload); }
  catch { return res.status(400).json({ error: 'Invalid JSON payload' }); }

  const parsed = parseInsightsEvent(event);

  // call.conversation.ended — the assistant's hangup signal: close the live
  // calls row (and backfill the session id / duration) so the operator's
  // Lola Live panel returns to Standing by the moment the call ends.
  if (parsed.eventType === 'call.conversation.ended') {
    const result = await markConversationEnded(db(), parsed);
    if (result.mode === 'error') console.error('[telnyx-insights] end-persist failed:', result.error);
    return res.status(200).json({ ok: true, ...result });
  }

  if (parsed.eventType && parsed.eventType !== 'call.conversation_insights.generated') {
    return res.status(200).json({ ok: true, ignored: 'unexpected event type', event: parsed.eventType });
  }
  if (!parsed.results.length) {
    return res.status(200).json({ ok: true, ignored: 'no insight results', event: parsed.eventType });
  }

  const classified = classifyResults(parsed.results);
  const result = await persistCallInsights(db(), parsed, classified);
  if (result.mode === 'error') console.error('[telnyx-insights] persist failed:', result.error);

  return res.status(200).json({ ok: true, ...result });
}
