/**
 * api/lib/tool-key.js — proof that a request to Lola's tools / salon-details webhook came from
 * LolaDesk's own Telnyx assistant configuration.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * Telnyx calls the URLs we store on the assistant exactly as stored, so a secret in the URL
 * (k=…) is the documented-safe way to sign them (the tool URL is free-form). Without it, anyone
 * who knew a salon's public phone number could cancel or move its clients' bookings.
 * The key is derived from secrets already in Vercel — nothing new to configure — and rotates
 * when they do (the nightly/status heal re-signs every tool).
 */
import crypto from 'node:crypto';

const secret = () => String(process.env.LOLA_TOOLS_SECRET || process.env.TELNYX_API_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '');
export function toolKey(purpose = 'tools') {
  const s = secret();
  if (!s) return '';
  return crypto.createHmac('sha256', s).update('loladesk:' + purpose).digest('base64url').slice(0, 24);
}
export function toolKeyOk(k, purpose = 'tools') {
  const want = toolKey(purpose);
  if (!want || !k) return false;
  const a = Buffer.from(String(k)), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
