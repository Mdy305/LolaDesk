/**
 * /api/hooks/booking?t=<salon>&k=<key> — the salon's own booking system (Boulevard via Zapier,
 * or anything that can POST) tells Lola about appointments the moment they change.
 * POST { event: new|rescheduled|cancelled, id, start, end|duration, staff, service, client }
 */
import { db } from '../lib/db.js';
import { checkKey, inboundEvent } from '../lib/zapier-bridge.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  const tenantId = String(q.t || '');
  if (!tenantId || !checkKey(tenantId, q.k)) return res.status(401).json({ ok: false, error: 'This hook link is not valid — copy it again from LolaDesk Settings.' });
  const c = db();
  if (!c) return res.status(503).json({ ok: false });
  const { data: tenant } = await c.from('tenants').select('id,name').eq('id', tenantId).maybeSingle();
  if (!tenant) return res.status(404).json({ ok: false, error: 'unknown salon' });
  if (req.method === 'GET') return res.json({ ok: true, salon: tenant.name, ready: true });
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  const tz = await c.from('booking_settings').select('timezone').eq('tenant_id', tenantId).maybeSingle().then((r) => r.data?.timezone).catch(() => null) || 'America/New_York';
  const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch (_) { return {}; } })() : (req.body || {});
  const items = Array.isArray(body) ? body : [body];
  const results = [];
  for (const it of items.slice(0, 100)) results.push(await inboundEvent(c, tenant, it, { tz }));
  const ok = results.every((r) => r.ok);
  return res.status(ok ? 200 : 400).json(items.length === 1 ? results[0] : { ok, results });
}
