// GET /api/cron/rebook-nudge
// Vercel cron target. Once/day: find clients whose last visit was ~28 days ago
// (per tenant's rebook_followup_days) and hasn't been reminded yet.
// Sends a personalized SMS via Telnyx.
import { db } from '../lib/db.js';
import { sendSMS } from '../lib/telnyx.js';

function isAuthorized(req) {
  if (req.headers?.['x-vercel-cron']) return true;
  const secret = req.query?.secret || req.headers?.['x-cron-secret'];
  return secret && secret === process.env.CRON_SECRET;
}

function nudgeText({ firstName, tenantName }) {
  const name = firstName ? `Hi ${firstName}` : 'Hi there';
  return `${name} — it's been a few weeks since your last visit at ${tenantName}. Want to grab your next spot? Reply here and I'll get you booked. — Lola`;
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const c = db();
  const results = [];

  try {
    // Iterate each tenant's booking settings.
    const { data: settings } = await c.from('booking_settings')
      .select('tenant_id, rebook_followup_days');

    for (const s of (settings || [])) {
      const days = Number(s.rebook_followup_days || 28);
      const target = new Date(Date.now() - days * 86400000);
      const windowStart = new Date(target.getTime() - 12 * 3600000);
      const windowEnd = new Date(target.getTime() + 12 * 3600000);

      // Load tenant name + sending number.
      const { data: tenant } = await c.from('tenants')
        .select('id, name, phone_e164')
        .eq('id', s.tenant_id).maybeSingle();
      const { data: tnum } = await c.from('tenant_numbers')
        .select('phone_e164').eq('tenant_id', s.tenant_id).maybeSingle();
      const fromNumber = tnum?.phone_e164 || tenant?.phone_e164;
      if (!tenant || !fromNumber) continue;

      // Bookings that were completed around windowStart–windowEnd.
      const { data: bookings } = await c.from('bookings')
        .select('client_id, start_time')
        .eq('tenant_id', s.tenant_id)
        .eq('outcome', 'completed')
        .gte('start_time', windowStart.toISOString())
        .lt('start_time', windowEnd.toISOString());

      const clientIds = [...new Set((bookings || []).map(b => b.client_id).filter(Boolean))];
      if (clientIds.length === 0) continue;

      // Load clients (skip opted-out).
      const { data: clients } = await c.from('clients')
        .select('id, first_name, name, phone, rebook_nudge_opt_out, last_rebook_nudge_at')
        .in('id', clientIds)
        .eq('rebook_nudge_opt_out', false);

      for (const cl of (clients || [])) {
        if (!cl.phone) continue;
        // De-dupe: skip if we sent one in the last 21 days.
        if (cl.last_rebook_nudge_at && (Date.now() - new Date(cl.last_rebook_nudge_at).getTime()) < 21 * 86400000) continue;

        try {
          await sendSMS({
            from: fromNumber,
            to: cl.phone,
            text: nudgeText({ firstName: cl.first_name, tenantName: tenant.name })
          });
          await c.from('clients').update({ last_rebook_nudge_at: new Date().toISOString() }).eq('id', cl.id);
          results.push({ tenant_id: s.tenant_id, client_id: cl.id, status: 'sent' });
        } catch (err) {
          results.push({ tenant_id: s.tenant_id, client_id: cl.id, status: 'failed', error: String(err?.message || err) });
        }
      }
    }

    return res.json({ ok: true, processed: results.length, results });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
