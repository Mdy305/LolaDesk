// POST /api/lola/check-availability
// { to_number, service_id, staff_id?, date? }
// LolaBrain calls this when the caller asks "what's available Friday?".
// Returns the next 3 open slots that day (or the next 3 across the next 7
// days if no date specified).
import { db } from '../lib/db.js';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function verifyToolAuth(req) {
  const secret = process.env.LOLA_TOOL_SECRET;
  if (!secret) return true;
  return req.headers?.['x-lola-tool-secret'] === secret;
}

function parseHM(hm) { const [h, m] = String(hm).split(':').map(Number); return { h, m }; }

async function tenantFromToNumber(c, to) {
  const { data } = await c.from('tenant_numbers').select('tenant_id').eq('phone_e164', to).maybeSingle();
  return data?.tenant_id || null;
}

function slotsForDay(y, m, d, hours, bookings, durationMin, bufferMin) {
  if (!hours || hours.closed) return [];
  const open = parseHM(hours.open);
  const close = parseHM(hours.close);
  const startMin = open.h * 60 + open.m;
  const closeMin = close.h * 60 + close.m;
  const step = 15;
  const out = [];
  for (let t = startMin; t + durationMin <= closeMin; t += step) {
    const slotStart = new Date(y, m - 1, d, Math.floor(t / 60), t % 60).getTime();
    const slotEnd = slotStart + durationMin * 60 * 1000;
    if (slotStart < Date.now() + 60 * 60 * 1000) continue; // 1h lead
    const conflict = bookings.some(b => {
      const bs = new Date(b.start_time).getTime();
      const be = b.end_time ? new Date(b.end_time).getTime() : bs + 60 * 60000;
      return bs < slotEnd + bufferMin * 60000 && be + bufferMin * 60000 > slotStart;
    });
    if (conflict) continue;
    out.push(new Date(slotStart));
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!verifyToolAuth(req)) return res.status(401).json({ error: 'unauthorized' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { to_number, service_id, staff_id, date } = body;
    if (!to_number || !service_id) return res.status(400).json({ error: 'missing_params' });

    const c = db();
    const tenant_id = await tenantFromToNumber(c, to_number);
    if (!tenant_id) return res.status(404).json({ error: 'tenant_not_found' });

    const [{ data: service }, { data: settings }] = await Promise.all([
      c.from('services').select('duration_min, buffer_after_min, name').eq('id', service_id).eq('tenant_id', tenant_id).maybeSingle(),
      c.from('booking_settings').select('business_hours, closures').eq('tenant_id', tenant_id).maybeSingle()
    ]);
    if (!service) return res.status(404).json({ error: 'service_not_found' });

    const durationMin = Number(service.duration_min || 60);
    const bufferMin = Number(service.buffer_after_min || 0);
    const closures = new Set(settings?.closures || []);

    // Which days to scan.
    const days = [];
    if (date) {
      const [y, m, d] = String(date).split('-').map(Number);
      days.push({ y, m, d });
    } else {
      for (let i = 0; i < 7; i++) {
        const dt = new Date(Date.now() + i * 86400000);
        days.push({ y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() });
      }
    }

    const found = [];
    for (const { y, m, d } of days) {
      if (found.length >= 3) break;
      const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (closures.has(dateStr)) continue;
      const dow = DAYS[new Date(y, m - 1, d).getDay()];
      const hours = settings?.business_hours?.[dow];
      const dayStart = new Date(y, m - 1, d, 0, 0, 0).toISOString();
      const dayEnd = new Date(y, m - 1, d + 1, 0, 0, 0).toISOString();
      let bq = c.from('bookings')
        .select('start_time, end_time, staff_id, outcome')
        .eq('tenant_id', tenant_id)
        .gte('start_time', dayStart)
        .lt('start_time', dayEnd)
        .not('outcome', 'in', '(cancelled,no_show)');
      if (staff_id) bq = bq.eq('staff_id', staff_id);
      const { data: bookings } = await bq;
      const slots = slotsForDay(y, m, d, hours, bookings || [], durationMin, bufferMin);
      for (const s of slots) {
        found.push({
          iso: s.toISOString(),
          date: dateStr,
          human: s.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' })
        });
        if (found.length >= 3) break;
      }
    }

    return res.json({
      service: service.name,
      duration_min: durationMin,
      slots: found,
      count: found.length,
      message: found.length
        ? `I have ${found.length} open ${found.length > 1 ? 'times' : 'time'}: ${found.map(s => s.human).join('; ')}. Which works?`
        : 'I don\'t see any openings for that. Want me to check next week?'
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
