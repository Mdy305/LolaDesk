import { createPublicKey, verify as verifySig } from 'crypto';

function header(req, name){
  return req.headers?.[name] || req.headers?.[name.toLowerCase()] || req.headers?.[name.toUpperCase()] || '';
}

export function getTelnyxSignatureHeaders(req){
  return {
    signature: header(req, 'telnyx-signature-ed25519'),
    timestamp: header(req, 'telnyx-timestamp')
  };
}

export function verifyTelnyxSignature({ rawBody, signature, timestamp }){
  const publicKeyPem = process.env.TELNYX_PUBLIC_KEY || '';
  if(!publicKeyPem) return { ok: true, skipped: true }; // optional unless configured
  if(!rawBody || !signature || !timestamp) return { ok: false, reason: 'missing headers/body' };

  const ts = Number(timestamp);
  if(!Number.isFinite(ts)) return { ok: false, reason: 'invalid timestamp' };
  const now = Math.floor(Date.now() / 1000);
  if(Math.abs(now - ts) > 5 * 60) return { ok: false, reason: 'stale timestamp' };

  try{
    const payload = `${timestamp}|${rawBody}`;
    const key = createPublicKey(publicKeyPem);
    const ok = verifySig(null, Buffer.from(payload, 'utf8'), key, Buffer.from(signature, 'base64'));
    return ok ? { ok: true } : { ok: false, reason: 'bad signature' };
  }catch(e){
    return { ok: false, reason: String(e?.message || e) };
  }
}
