/**
 * api/lib/derived-secret.js — a per-purpose secret derived from a real server secret that is
 * always configured in production (the Supabase service key; Telnyx key as a second choice).
 * Replaces hard-coded fallbacks like 'dev-only-secret-change-me' / 'loladesk' / 'x', which let
 * anyone who read the source mint valid keys. Returns '' when no server secret exists at all —
 * callers must then refuse (fail closed), never sign with an empty key.
 */
import crypto from 'node:crypto';

export function serverRootSecret() {
  return String(process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.TELNYX_API_KEY || '').trim();
}
export function derivedSecret(purpose) {
  const root = serverRootSecret();
  if (!root) return '';
  return crypto.createHmac('sha256', root).update('loladesk-derived:' + String(purpose)).digest('hex');
}
