// GET  /api/clients?q=&limit=&offset=  → list, or detail with ?id=uuid
// POST /api/clients                    → create
// PATCH /api/clients?id=uuid           → update
import { cors, jsonBody } from './lib/cors.js';
import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db } from './lib/db.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const c = db();
    const id = req.query?.id;

    if (req.method === 'GET') {
      if (id) {
        const { data } = await c.from('clients')
          .select('*')
          .eq('id', id)
          .eq('tenant_id', tenant.id)
          .maybeSingle();
        if (!data) return res.status(404).json({ ok: false, error: 'not_found' });

        // Enrich with last 20 bookings + total spent
        const { data: bookings } = await c.from('bookings')
          .select('id, start_time, service_id, staff_id, total_amount, outcome')
          .eq('client_id', id)
          .order('start_time', { ascending: false })
          .limit(20);

        const { data: payments } = await c.from('payments')
          .select('amount, kind, status, created_at')
          .eq('client_id', id)
          .eq('status', 'succeeded');

        const lifetimeCents = (payments || []).reduce((s, p) => {
          if (p.kind === 'charge' || p.kind === 'tip') return s + Number(p.amount || 0);
          if (p.kind === 'refund') return s - Number(p.amount || 0);
          return s;
        }, 0);

        return res.json({ ok: true, client: data, bookings: bookings || [], lifetime_cents: lifetimeCents });
      }

      const q = String(req.query?.q || '').trim().toLowerCase();
      const limit = Math.min(500, Number(req.query?.limit) || 100);
      const offset = Number(req.query?.offset) || 0;

      let query = c.from('clients')
        .select('id, first_name, last_name, name, phone, email, visit_count, no_show_count, created_at')
        .eq('tenant_id', tenant.id)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      const { data, error } = await query;
      if (error) throw error;

      let list = data || [];
      if (q) {
        list = list.filter(c => (
          String(c.name || '').toLowerCase().includes(q) ||
          String(c.first_name || '').toLowerCase().includes(q) ||
          String(c.last_name || '').toLowerCase().includes(q) ||
          String(c.phone || '').includes(q) ||
          String(c.email || '').toLowerCase().includes(q)
        ));
      }

      return res.json({ ok: true, clients: list });
    }

    if (req.method === 'POST') {
      const body = jsonBody(req);
      const { data, error } = await c.from('clients').insert({
        tenant_id: tenant.id,
        first_name: body.first_name || null,
        last_name: body.last_name || null,
        name: body.name || [body.first_name, body.last_name].filter(Boolean).join(' ') || null,
        phone: body.phone || null,
        email: body.email || null
      }).select().single();
      if (error) throw error;
      return res.json({ ok: true, client: data });
    }

    if (req.method === 'PATCH') {
      if (!id) return res.status(400).json({ ok: false, error: 'missing_id' });
      const body = jsonBody(req);
      const patch = {};
      ['first_name', 'last_name', 'name', 'phone', 'email', 'rebook_nudge_opt_out'].forEach(k => {
        if (k in body) patch[k] = body[k];
      });
      const { data, error } = await c.from('clients')
        .update(patch)
        .eq('id', id)
        .eq('tenant_id', tenant.id)
        .select().single();
      if (error) throw error;
      return res.json({ ok: true, client: data });
    }

    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
