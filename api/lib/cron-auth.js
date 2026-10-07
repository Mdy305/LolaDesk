/**
 * api/lib/cron-auth.js — the ONE way a cron route is authorized.
 * Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}`. Nothing else counts: the
 * `x-vercel-cron` header and `?secret=` query are spoofable / leak into logs. No CRON_SECRET
 * configured → every request is refused (fail closed).
 */
import crypto from 'node:crypto';

export function cronAuthorized(req) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  if (!secret) return false;
  const h = String(req?.headers?.authorization || req?.headers?.Authorization || '');
  const a = Buffer.from(h), b = Buffer.from('Bearer ' + secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
