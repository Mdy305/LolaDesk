/**
 * api/lib/unsubscribe-sign.js — signed email-unsubscribe links.
 * sig = HMAC(server-derived secret, tenant|email). The unsubscribe endpoint only flips an opt-out
 * for a link LolaDesk itself put in an email, so nobody can unsubscribe a salon's clients in bulk.
 */
import crypto from 'node:crypto';
import { derivedSecret } from './derived-secret.js';

const key = () => process.env.EMAIL_UNSUB_SECRET || derivedSecret('email-unsubscribe');
const norm = (tenantId, email) => `${String(tenantId || '').trim()}|${String(email || '').trim().toLowerCase()}`;

export function unsubscribeSig(tenantId, email) {
  const k = key();
  if (!k || !tenantId || !email) return '';
  return crypto.createHmac('sha256', k).update(norm(tenantId, email)).digest('base64url').slice(0, 32);
}
export function unsubscribeSigOk(tenantId, email, sig) {
  const want = unsubscribeSig(tenantId, email);
  if (!want || !sig) return false;
  const a = Buffer.from(String(sig)), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export function unsubscribeUrl(base, tenantId, email) {
  const b = String(base || process.env.APP_URL || 'https://www.loladesk.com').replace(/\/+$/, '');
  return `${b}/api/email?email=${encodeURIComponent(String(email || ''))}&tenant=${encodeURIComponent(String(tenantId || ''))}&sig=${unsubscribeSig(tenantId, email)}`;
}
