// GET /api/revenue/staff?range=7d|30d|90d|ytd|all
// Revenue and count per staff member. Powers revenue.html's Staff card.
import { cors } from '../lib/cors.js';
import { bearer, getUserFromToken } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { db } from '../lib/db.js';

const RANGES = { '7d':7, '30d':30, '90d':90 };

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const range = String(req.query?.range || '30d');
    let since;
    if (range === 'all') since = new Date(0);
    else if (range === 'ytd') since = new Date(new Date().getFullYear(), 0, 1);
    else since = new Date(Date.now() - (RANGES[range] || 30) * 86400000);

    const c = db();

    // Join bookings to staff and payments (settled charges + tips).
    const { data: staff } = await c.from('staff').select('*').eq('tenant_id', tenant.id);
    const staffList = staff || [];

    // Bookings carry `status` (there is no `outcome` column — filtering on it
    // returned nothing, so every stylist showed zero). Count what already
    // happened and wasn't cancelled.
    const { data: bookings } = await c.from('bookings')
      .select('*')
      .eq('tenant_id', tenant.id)
      .gte('start_time', since.toISOString())
      .lte('start_time', new Date().toISOString());
    const bkList = (bookings || []).filter(b => !/cancel|no.?show|declin/i.test(String(b.status || '')));

    const revenueBy = {}; const countBy = {}; const minBy = {};
    for (const b of bkList) {
      const sid = b.staff_id;
      if (!sid) continue;
      revenueBy[sid] = (revenueBy[sid] || 0) + Number(b.total_amount ?? b.price ?? 0);
      countBy[sid] = (countBy[sid] || 0) + 1;
      const mins = Number(b.duration_min) || ((Date.parse(b.end_time) - Date.parse(b.start_time)) / 60000) || 60;
      minBy[sid] = (minBy[sid] || 0) + mins;
    }

    const rows = staffList.map(s => ({
      id: s.id,
      name: s.first_name || s.last_name ? [s.first_name, s.last_name].filter(Boolean).join(' ') : s.name,
      role: s.role,
      color: s.color,
      active: s.active ?? s.is_active,
      revenue: revenueBy[s.id] || 0,                       // dollars (kept for older readers)
      revenue_cents: Math.round((revenueBy[s.id] || 0) * 100),
      count: countBy[s.id] || 0,
      bookings: countBy[s.id] || 0,
      hours: Math.round((minBy[s.id] || 0) / 6) / 10
    })).filter(r => r.revenue > 0 || r.count > 0);

    return res.json({ ok: true, staff: rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
