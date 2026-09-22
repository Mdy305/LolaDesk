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
    const { data: staff } = await c.from('staff').select('id, name, first_name, last_name, role, color, active').eq('tenant_id', tenant.id);
    const staffList = staff || [];

    const { data: bookings } = await c.from('bookings')
      .select('id, staff_id, service_id, total_amount, outcome, start_time')
      .eq('tenant_id', tenant.id)
      .gte('start_time', since.toISOString())
      .in('outcome', ['completed','arrived']);
    const bkList = bookings || [];

    const revenueBy = {}; const countBy = {};
    for (const b of bkList) {
      const sid = b.staff_id;
      if (!sid) continue;
      revenueBy[sid] = (revenueBy[sid] || 0) + Number(b.total_amount || 0);
      countBy[sid] = (countBy[sid] || 0) + 1;
    }

    const rows = staffList.map(s => ({
      id: s.id,
      name: s.first_name || s.last_name ? [s.first_name, s.last_name].filter(Boolean).join(' ') : s.name,
      role: s.role,
      color: s.color,
      active: s.active,
      revenue: revenueBy[s.id] || 0,
      count: countBy[s.id] || 0
    })).filter(r => r.revenue > 0 || r.count > 0);

    return res.json({ ok: true, staff: rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
