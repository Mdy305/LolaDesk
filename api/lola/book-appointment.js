// POST /api/lola/book-appointment
// { to_number, from_number, service_id, staff_id?, start_iso, client_name? }
// LolaBrain calls this to actually commit a booking. Returns confirmation.
import { db } from '../lib/db.js';
import { sendSMS } from '../lib/telnyx.js';

function verifyToolAuth(req) {
  const secret = process.env.LOLA_TOOL_SECRET;
  if (!secret) return true;
  return req.headers?.['x-lola-tool-secret'] === secret;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!verifyToolAuth(req)) return res.status(401).json({ error: 'unauthorized' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { to_number, from_number, service_id, staff_id, start_iso, client_name } = body;
    if (!to_number || !service_id || !start_iso || !from_number) {
      return res.status(400).json({ error: 'missing_params' });
    }

    const c = db();
    const { data: tn } = await c.from('tenant_numbers')
      .select('tenant_id').eq('phone_e164', to_number).maybeSingle();
    if (!tn?.tenant_id) return res.status(404).json({ error: 'tenant_not_found' });
    const tenant_id = tn.tenant_id;

    // Upsert client by phone.
    let { data: client } = await c.from('clients')
      .select('id, first_name, last_name, name')
      .eq('tenant_id', tenant_id)
      .eq('phone', from_number)
      .maybeSingle();
    if (!client) {
      const first = (client_name || '').split(' ')[0] || null;
      const last = (client_name || '').split(' ').slice(1).join(' ') || null;
      const { data: inserted } = await c.from('clients').insert({
        tenant_id,
        phone: from_number,
        first_name: first,
        last_name: last,
        name: client_name || null
      }).select().single();
      client = inserted;
    }

    // Service info for total_amount + end_time.
    const { data: service } = await c.from('services')
      .select('name, duration_min, price')
      .eq('id', service_id)
      .eq('tenant_id', tenant_id)
      .maybeSingle();
    if (!service) return res.status(404).json({ error: 'service_not_found' });

    const startTime = new Date(start_iso);
    const endTime = new Date(startTime.getTime() + Number(service.duration_min || 60) * 60000);

    const { data: booking, error } = await c.from('bookings').insert({
      tenant_id,
      client_id: client.id,
      service_id,
      staff_id: staff_id || null,
      start_time: startTime.toISOString(),
      end_time: endTime.toISOString(),
      total_amount: Number(service.price || 0),
      outcome: 'confirmed',
      source: 'lola_phone',
      created_at: new Date().toISOString()
    }).select().single();
    if (error) throw error;

    // Fire an SMS confirmation.
    const humanTime = startTime.toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
      timeZone: 'America/New_York'
    });
    const { data: tenant } = await c.from('tenants').select('name, phone_e164').eq('id', tenant_id).maybeSingle();
    try {
      await sendSMS({
        from: to_number,
        to: from_number,
        text: `You're booked for ${service.name} on ${humanTime} at ${tenant?.name || 'the salon'}. Reply STOP to opt out. Reply CANCEL to cancel.`
      });
    } catch {}

    return res.json({
      ok: true,
      booking_id: booking.id,
      when: humanTime,
      service: service.name,
      message: `Booked. I'll send ${client.first_name || 'you'} a text confirmation right now.`
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
