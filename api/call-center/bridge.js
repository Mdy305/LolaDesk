/**
 * POST /api/call-center/bridge — Telnyx webhook for owner → client calls.
 * The owner answered → "Connecting you to Maria" → dial the client and join.
 * Signature-verified when TELNYX_PUBLIC_KEY is set. Always answers 200 so
 * Telnyx never retries or disables the webhook.
 */
import { rawBody, verifyTelnyxSignature } from '../lib/telnyx-webhook-verify.js';
import { runBridgeStep } from '../lib/owner-call.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  const payload = rawBody(req);
  if (!verifyTelnyxSignature(req, payload)) return res.status(401).json({ ok: false, error: 'invalid signature' });
  let event; try { event = JSON.parse(payload); } catch { return res.status(200).json({ ok: false, error: 'bad json' }); }
  try { return res.status(200).json(await runBridgeStep(event)); }
  catch (e) { console.error('[bridge]', e?.message || e); return res.status(200).json({ ok: false, error: String(e?.message || e) }); }
}
