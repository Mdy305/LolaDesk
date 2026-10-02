/**
 * /api/lola/booking-mode — how Lola closes a booking (owner).
 *   GET → { mode: 'loladesk'|'link', booking_url }
 *   POST { mode } → 'link' = Lola texts the salon's own booking link (needs a booking link in Salon details)
 */
import { getUserFromToken, bearer } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { db } from '../lib/db.js';
import { bookingMode, setBookingMode } from '../lib/link-booking.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const user = await getUserFromToken(bearer(req)).catch(() => null);
  if (!user) return res.status(401).json({ ok: false, error: 'not signed in' });
  const tenant = await resolveTenantForUser(user).catch(() => null);
  const c = db();
  if (!tenant?.id || !c) return res.status(404).json({ ok: false, error: 'no salon' });
  if (req.method === 'GET') { const m = await bookingMode(tenant, c); return res.json({ ok: true, mode: m.mode, booking_url: m.url || null }); }
  if (req.method === 'POST') {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (b.mode === 'link' && !/^https:\/\//i.test(String(tenant.booking_url || ''))) return res.status(400).json({ ok: false, error: 'Add your booking link above first (Boulevard, Vagaro, Fresha…), then choose this.' });
    const mode = await setBookingMode(c, tenant.id, b.mode);
    return res.json({ ok: true, mode });
  }
  return res.status(405).json({ ok: false });
}
