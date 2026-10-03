/**
 * /api/zap-callback?t=<salon>&k=<key>[&b=<booking>] — the salon's Zap tells
 * LolaDesk which time block it created in their system (Boulevard "Create
 * Timeblock") for one of Lola's bookings, so later booking.rescheduled /
 * booking.cancelled events carry that id (external_id) and the Zap can
 * Delete/Update exactly that block.
 *
 * Authenticated by the same per-salon key as /api/hooks/booking (copied from
 * the callback_url field in every outbound event).
 * POST { booking_id?, timeblock_id | external_id | id }
 */
import { db } from './lib/db.js';
import { checkKey } from './lib/zapier-bridge.js';

const pick = (o, keys) => { for (const k of keys) { const v = k.split('.').reduce((a, p) => (a == null ? a : a[p]), o); if (v != null && v !== '') return v; } return null; };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  const tenantId = String(q.t || '');
  if (!tenantId || !checkKey(tenantId, q.k)) return res.status(401).json({ ok: false, error: 'This callback link is not valid — copy it from the callback_url field LolaDesk sends.' });
  const c = db();
  if (!c) return res.status(503).json({ ok: false });
  if (req.method === 'GET') return res.json({ ok: true, ready: true });
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch (_) { return {}; } })() : (req.body || {});
  const bookingId = String(pick(body, ['booking_id', 'bookingId', 'lola_booking_id']) || q.b || '').trim();
  const externalId = String(pick(body, ['timeblock_id', 'timeblockId', 'timeblock.id', 'external_id', 'externalId', 'id']) || '').trim().slice(0, 200);
  if (!bookingId) return res.status(400).json({ ok: false, error: 'missing booking_id' });
  if (!externalId) return res.status(400).json({ ok: false, error: 'missing timeblock_id (map the id of the time block your Zap created)' });
  // The booking must belong to THIS salon — a key for one salon never touches another's rows.
  const { data: b } = await c.from('bookings').select('id,tenant_id,external_id,external_provider,start_time').eq('id', bookingId).eq('tenant_id', tenantId).maybeSingle();
  if (!b) return res.status(404).json({ ok: false, error: 'booking not found for this salon' });
  // bookings.external_id is the booking's main upstream id: only claim it when
  // no API platform (Square, Vagaro…) already owns it.
  if (!b.external_id || !b.external_provider || b.external_provider === 'zapier') {
    try { await c.from('bookings').update({ external_id: externalId, external_provider: 'zapier' }).eq('id', b.id).eq('tenant_id', tenantId); } catch (_) {}
  }
  const { error } = await c.from('provider_mappings').upsert({
    tenant_id: tenantId, provider: 'zapier', entity_type: 'booking', local_id: b.id, external_id: externalId,
    external_parent_id: null, metadata: { kind: 'timeblock', starts_at: b.start_time || null, at: new Date().toISOString() },
  }, { onConflict: 'tenant_id,provider,entity_type,local_id' });
  if (error) return res.status(500).json({ ok: false, error: error.message || String(error) });
  return res.json({ ok: true, booking_id: b.id, external_id: externalId });
}
