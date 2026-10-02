/**
 * GET /api/lola/pulse — one question, answered: is Lola taking care of my business right now?
 * → { ok, live, headline, parts:[…], needs:[…], counts }
 *   "Lola is answering · 6 calls · 3 booked today · nothing needs you"
 */
import { bearer, getUserFromToken } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { db } from '../lib/db.js';
import { awayBrief } from '../lib/owner-brief.js';
import { dayBoundsUtc } from '../lib/timezone.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export async function lolaPulse(c, tenant, { now = new Date() } = {}) {
  let tz = 'America/New_York';
  try { const { data } = await c.from('booking_settings').select('timezone').eq('tenant_id', tenant.id).maybeSingle(); if (data?.timezone) tz = data.timezone; } catch (_) {}
  let since;
  try { since = dayBoundsUtc(now, tz).start; } catch (_) {}
  if (!since) since = new Date(now.getTime() - 12 * 3600e3).toISOString();
  let line = tenant.phone_number || null;
  if (!line) { try { const { data } = await c.from('tenant_numbers').select('phone_number').eq('tenant_id', tenant.id).limit(1); line = data?.[0]?.phone_number || null; } catch (_) {} }
  const paused = /^(canceled|cancelled|suspended|expired)$/i.test(String(tenant.subscription_status || ''));
  const brief = await awayBrief(c, tenant, since, { now }).catch(() => null);
  const k = brief?.counts || { calls: 0, booked: 0, needs_you: 0 };
  let chats = 0;
  try { const { data } = await c.from('conversations').select('id,channel').eq('tenant_id', tenant.id).gte('started_at', since); chats = (data || []).filter((x) => x.channel !== 'operator').length; } catch (_) {}
  const live = !!line && !paused;
  const parts = [];
  if (!live) {
    return { ok: true, live: false, headline: paused ? 'Lola is paused — your plan needs attention' : 'Lola isn’t answering yet — give her a phone number',
      action: paused ? { label: 'Fix billing', href: '/subscription' } : { label: 'Get a number', href: '/telecom' }, parts, needs: [], counts: k };
  }
  if (k.calls) parts.push(plural(k.calls, 'call'));
  if (chats) parts.push(plural(chats, 'conversation'));
  parts.push(k.booked ? `${k.booked} booked today` : 'no new bookings yet');
  const needs = (brief?.needs || []).slice(0, 3).map((n) => ({ name: n.name, action: n.action, phone: n.phone }));
  parts.push(k.needs_you ? `${k.needs_you} need${k.needs_you === 1 ? 's' : ''} you` : 'nothing needs you');
  return { ok: true, live: true, headline: ['Lola is answering', ...parts].join(' · '), parts, needs, counts: { ...k, conversations: chats } };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ ok: false });
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no salon' });
    const c = db(); if (!c) return res.status(503).json({ ok: false });
    return res.status(200).json(await lolaPulse(c, tenant));
  } catch (e) { return res.status(500).json({ ok: false, error: String(e?.message || e) }); }
}
