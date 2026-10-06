/**
 * api/lib/webhook-body.js — raw-bytes body reading + Telnyx signature check for
 * the TeXML / messaging webhooks (telnyx-voice, telnyx-sms, operator-voice).
 * ════════════════════════════════════════════════════════════════════════
 * Telnyx signs the EXACT bytes it sent, so these routes export
 * `config = { api: { bodyParser: false } }` and read the stream themselves.
 * Both TeXML (form-urlencoded) and API v2 (JSON) bodies are parsed here.
 *
 * Signature rule (same as before, now for every content type): when
 * TELNYX_PUBLIC_KEY is set, every request must carry a valid Ed25519
 * signature over the raw bytes. A body the runtime already parsed has no raw
 * bytes left to check, so with a key set it is refused rather than trusted.
 */
import { getTelnyxSignatureHeaders, verifyTelnyxSignature } from './telnyx-signature.js';

function parseRaw(raw, contentType) {
  const ct = String(contentType || '').toLowerCase();
  const s = String(raw || '');
  if (ct.includes('json') || /^\s*[{[]/.test(s)) {
    try { return JSON.parse(s || '{}'); } catch { return {}; }
  }
  try { const o = {}; for (const [k, v] of new URLSearchParams(s)) o[k] = v; return o; } catch { return {}; }
}

async function readStream(req) {
  if (!req || typeof req.on !== 'function') return '';
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(Buffer.concat(chunks).toString('utf8')); };
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));   // whole bytes: a split multi-byte char can't break the signature
    req.on('end', finish);
    req.on('error', finish);
    // A stream that was already consumed never fires 'end': don't hang the call.
    if (req.readableEnded) finish();
  });
}

/** → { parsed, raw, parsedByRuntime } */
export async function readWebhookBody(req) {
  const ct = req?.headers?.['content-type'] || req?.headers?.['Content-Type'] || '';
  const asRaw = (raw) => ({ parsed: parseRaw(raw, ct), raw, parsedByRuntime: false });
  if (Buffer.isBuffer(req?.rawBody)) return asRaw(req.rawBody.toString('utf8'));
  if (typeof req?.rawBody === 'string') return asRaw(req.rawBody);
  // The stream first (bodyParser:false): touching a runtime's lazy req.body getter could consume it.
  if (req && typeof req.on === 'function' && !req.readableEnded) {
    const raw = await readStream(req);
    if (raw) return asRaw(raw);
  }
  let b;
  try { b = req?.body; } catch { b = undefined; }
  if (Buffer.isBuffer(b)) return asRaw(b.toString('utf8'));
  if (typeof b === 'string') return asRaw(b);
  if (b && typeof b === 'object') return { parsed: b, raw: '', parsedByRuntime: true };
  return { parsed: {}, raw: '', parsedByRuntime: false };
}

/** → { ok, reason?, skipped? } — checks only when TELNYX_PUBLIC_KEY is set. */
export function checkTelnyxSignature(req, incoming, { texml = false } = {}) {
  if (!process.env.TELNYX_PUBLIC_KEY) return process.env.TELNYX_REQUIRE_SIGNATURE === '1' ? { ok: false, reason: 'TELNYX_PUBLIC_KEY not configured' } : { ok: true, skipped: true };
  // TeXML (form-encoded call scripts) may arrive without Telnyx's Ed25519 headers: a call is never
  // refused for that (it would hang up every caller) unless strict mode is on.
  if (texml && !getTelnyxSignatureHeaders(req).signature && process.env.TELNYX_REQUIRE_SIGNATURE !== '1') {
    if (!globalThis.__lolaWarnedTexmlSig) { globalThis.__lolaWarnedTexmlSig = 1; console.warn('[telnyx] TeXML request without a signature header — accepted (set TELNYX_REQUIRE_SIGNATURE=1 to refuse)'); }
    return { ok: true, skipped: true, unsigned_texml: true };
  }
  if (!incoming || incoming.parsedByRuntime || !incoming.raw) {
    if (!globalThis.__lolaWarnedRawBody) { globalThis.__lolaWarnedRawBody = 1; console.error('[telnyx] TELNYX_PUBLIC_KEY is set but the raw request body is unavailable (runtime pre-parsed it) — refusing unverifiable webhooks'); }
    return { ok: false, reason: 'raw body unavailable' };
  }
  const sig = getTelnyxSignatureHeaders(req);
  return verifyTelnyxSignature({ rawBody: incoming.raw, signature: sig.signature, timestamp: sig.timestamp });
}
