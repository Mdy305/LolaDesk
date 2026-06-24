import { bearer, getUserFromToken } from './lib/auth.js';
import { db, getClientByPhone, upsertClient } from './lib/db.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { cancelBookingSafe, createBookingSafe, listAvailability, rescheduleBookingSafe } from './lib/calendar-engine.js';

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(200).end();

  try{
    const user = await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({ error:'not authenticated' });
    const tenant = await resolveTenantForUser(user);
    if(!tenant?.id) return res.status(404).json({ error:'no tenant found for this account' });
    const c = db();
    if(!c) return res.status(503).json({ error:'database not configured' });

    if(req.method === 'GET'){
      const q = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
      if((q.action || 'availability') === 'availability'){
        const out = await listAvailability({
          tenant,
          date: q.date,
          durationMin: Number(q.duration_min || 60),
          stylist: q.stylist || null
        });
        return res.status(200).json({ ok:true, ...out });
      }
      return res.status(400).json({ error:'unknown action' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = body.action || 'book';
    if(action === 'book'){
      if(!body.starts_at) return res.status(400).json({ ok:false, error:'starts_at required' });
      let client = null;
      if(body.client_phone){
        client = await upsertClient(tenant.id, { phone: body.client_phone, name: body.client_name });
      }
      const out = await createBookingSafe({
        tenant,
        clientId: client?.id || null,
        service: body.service || 'Appointment',
        stylist: body.stylist || null,
        startsAt: body.starts_at,
        durationMin: Number(body.duration_min || 60),
        price: body.price != null ? Number(body.price) : null
      });
      if(out.ok) return res.status(200).json(out);
      const status = out.conflict ? 409 : 400;
      return res.status(status).json(out);
    }
    if(action === 'reschedule'){
      if(!body.booking_id || !body.starts_at){
        return res.status(400).json({ ok:false, error:'booking_id and starts_at required' });
      }
      const out = await rescheduleBookingSafe({
        tenantId: tenant.id,
        bookingId: body.booking_id,
        newStartsAt: body.starts_at
      });
      if(out.ok) return res.status(200).json(out);
      const status = out.conflict ? 409 : 400;
      return res.status(status).json(out);
    }
    if(action === 'cancel'){
      if(!body.booking_id) return res.status(400).json({ ok:false, error:'booking_id required' });
      const out = await cancelBookingSafe({ tenantId: tenant.id, bookingId: body.booking_id });
      return res.status(out.ok ? 200 : 400).json(out);
    }
    if(action === 'confirm'){
      if(!body.client_phone) return res.status(400).json({ error:'client_phone required' });
      const client = await getClientByPhone(tenant.id, body.client_phone);
      if(!client) return res.status(404).json({ error:'client not found' });
      const { data } = await c.from('bookings')
        .select('*')
        .eq('tenant_id', tenant.id)
        .eq('client_id', client.id)
        .gte('starts_at', new Date().toISOString())
        .neq('status','cancelled')
        .order('starts_at', { ascending: true })
        .limit(1);
      return res.status(200).json({ ok:true, booking:data?.[0] || null });
    }
    return res.status(400).json({ error:'unknown action' });
  }catch(e){
    return res.status(500).json({ error:String(e && e.message || e) });
  }
}
