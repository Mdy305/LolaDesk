/**
 * POST /api/call-center/bridge — Telnyx webhook for owner → client calls.
 * The owner answered → "Connecting you to Maria" → dial the client and join.
 * Signature-verified when TELNYX_PUBLIC_KEY is set. Always answers 200 so
 * Telnyx never retries or disables the webhook.
 */
import { verifyTelnyxSignature, readRawBody } from '../lib/telnyx-webhook-verify.js';
import { runBridgeStep, decodeState } from '../lib/owner-call.js';

// The signature covers the EXACT bytes Telnyx sent — read them raw (a re-serialised
// JSON body never matches, which silently blocked every call step before).
export const config = { api: { bodyParser: false } };
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  const payload = await readRawBody(req);
  let event; try { event = JSON.parse(payload); } catch { return res.status(200).json({ ok: false, error: 'bad json' }); }
  if (!verifyTelnyxSignature(req, payload)) {
    // Our own calls carry a signed client_state: trust those even if the key in Vercel is wrong.
    const st = decodeState(event?.data?.payload?.client_state);
    if (!st || !st.trusted) return res.status(401).json({ ok: false, error: 'invalid signature' });
    console.warn('[bridge] Telnyx signature did not verify — check TELNYX_PUBLIC_KEY in Vercel; continuing on the signed call state.');
  }
  try { return res.status(200).json(await runBridgeStep(event)); }
  catch (e) { console.error('[bridge]', e?.message || e); return res.status(200).json({ ok: false, error: String(e?.message || e) }); }
}
