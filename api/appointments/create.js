// POST /api/appointments/create
// Owner-side walk-in / manual booking. Inserts an appointment row,
// creates or matches the client, and fires a confirmation SMS best-effort.
export default async function handler(req, res) {
  let cors, jsonBody, bearer, getUserFromToken, resolveTenantForUser, dbFn, smsMod;
  try {
    ({ cors, jsonBody } = await import('../lib/cors.js'));
    ({ bearer, getUserFromToken } = await import('../lib/auth.js'));
    ({ resolveTenantForUser } = await import('../lib/tenant-access.js'));
    ({ db: dbFn } = await import('../lib/db.js'));
    smsMod = await import('../lib/sms.js').catch(() => null);
  } catch (e) { return res.status(500).json({ ok: false, error: 'import_failed', message: String(e?.message || e) }); }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    if (cors && cors(req, res)) return;
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const body = (jsonBody ? jsonBody(req) : null) || {};
    const date = String(body.date || '').slice(0, 10);
    const startTime = String(body.start_time || '').slice(0, 5);
    const duration = parseInt(body.duration_minutes, 10) || 60;
    if (!date || !startTime) return res.status(400).json({ ok: false, error: 'date_and_start_time_required' });
    if (!body.client_name && !body.client_id) return res.status(400).json({ ok: false, error: 'client_required' });

    const c = dbFn();
    let clientId = body.client_id || null;

    // If no client_id but we have a phone, try to match; otherwise create.
    if (!clientId) {
      const rawPhone = String(body.client_phone || '').replace(/\D/g, '');
      if (rawPhone) {
        try {
          const { data: match } = await c.from('clients')
            .select('id')
            .eq('tenant_id', tenant.id)
            .ilike('phone', '%' + rawPhone.slice(-10) + '%')
            .maybeSingle();
          if (match?.id) clientId = match.id;
        } catch (_) {}
      }
      if (!clientId) {
        try {
          const { data: created, error } = await c.from('clients').insert({
            tenant_id: tenant.id,
            name: body.client_name,
            phone: body.client_phone || null,
            email: body.client_email || null,
            source: 'owner_booking'
          }).select().single();
          if (error) throw error;
          clientId = created.id;
        } catch (e) {
          // Non-fatal — proceed with just the name on the appointment.
          console.warn('[appointments/create] client insert failed', e?.message);
        }
      }
    }

    const startsAt = `${date}T${startTime}:00`;
    const insertBody = {
      tenant_id: tenant.id,
      client_id: clientId,
      client_name: body.client_name || null,
      client_phone: body.client_phone || null,
      service_id: body.service_id || null,
      service_name: body.service_name || null,
      service: body.service_name || null,
      stylist_id: body.stylist_id || null,
      stylist_name: body.stylist_name || null,
      start_time: startsAt,
      starts_at: startsAt,
      duration_minutes: duration,
      duration_min: duration,
      status: 'confirmed',
      price_cents: parseInt(body.price_cents || 0, 10) || 0,
      notes: body.notes || null,
      source: body.source || 'owner_walk_in',
      created_by: user.id || null,
    };

    let saved = null;
    try {
      const { data, error } = await c.from('appointments').insert(insertBody).select().single();
      if (error) throw error;
      saved = data;
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'appointment_insert_failed', message: String(e?.message || e) });
    }

    // Fire SMS confirmation best-effort
    if (body.client_phone && smsMod?.sendSms) {
      try {
        const humanTime = fmtHumanTime(startTime);
        const humanDate = new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });
        const svc = body.service_name ? ` for ${body.service_name}` : '';
        const stylist = body.stylist_name ? ` with ${body.stylist_name}` : '';
        await smsMod.sendSms({
          tenant,
          to: body.client_phone,
          body: `Booked at ${tenant.name || 'the salon'}: ${humanDate} at ${humanTime}${svc}${stylist}. Reply to change or cancel.`
        });
      } catch (e) { console.warn('[appointments/create] SMS confirmation failed', e?.message); }
    }

    return res.json({ ok: true, data: saved });
  } catch (e) {
    console.error('[appointments/create]', e?.message);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

function fmtHumanTime(hhmm) {
  const m = /(\d{1,2}):(\d{2})/.exec(hhmm || '');
  if (!m) return String(hhmm || '');
  let h = parseInt(m[1], 10);
  const mm = m[2];
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${mm} ${ap}`;
}
