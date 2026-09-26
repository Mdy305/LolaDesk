// POST /api/call-center/take-over
// Body: { call_id?, telnyx_call_id? }
// Owner clicks "Take over" on an active Lola call.
// We originate a Telnyx call to the owner's mobile, and once they answer,
// bridge them into the existing call control. Lola gets muted / dropped.
//
// This uses your existing TELNYX_API_KEY. It looks up the owner's phone
// from the tenants table (owner_phone), the tenant's outbound number
// from tenant_voice / tenant_number_routing (whichever your app uses),
// and issues a Telnyx "transfer" action on the running call.
export default async function handler(req, res) {
  let cors, jsonBody, bearer, getUserFromToken, resolveTenantForUser, dbFn;
  try {
    ({ cors, jsonBody } = await import('../lib/cors.js'));
    ({ bearer, getUserFromToken } = await import('../lib/auth.js'));
    ({ resolveTenantForUser } = await import('../lib/tenant-access.js'));
    ({ db: dbFn } = await import('../lib/db.js'));
  } catch (e) { return res.status(500).json({ ok: false, error: 'import_failed', message: String(e?.message || e) }); }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  try {
    if (cors && cors(req, res)) return;
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    if (!process.env.TELNYX_API_KEY) return res.status(500).json({ ok: false, error: 'telnyx_api_key_missing' });

    const body = (jsonBody ? jsonBody(req) : null) || {};
    let telnyxId = body.telnyx_call_id || null;

    const c = dbFn();
    // Look up the local call row → get telnyx_call_id and originating from-number
    let callRow = null;
    if (body.call_id) {
      try {
        const { data } = await c.from('calls').select('*').eq('id', body.call_id).eq('tenant_id', tenant.id).maybeSingle();
        callRow = data;
        if (callRow?.telnyx_call_id && !telnyxId) telnyxId = callRow.telnyx_call_id;
        if (callRow?.call_control_id && !telnyxId) telnyxId = callRow.call_control_id;
      } catch (_) {}
    }
    if (!telnyxId) return res.status(400).json({ ok: false, error: 'telnyx_call_id_required', hint: 'Include telnyx_call_id in body, or ensure the calls row has one.' });

    // Owner's mobile — required for the bridge target
    const ownerPhone = tenant.owner_phone || tenant.phone || user.phone || '';
    if (!ownerPhone) return res.status(400).json({ ok: false, error: 'owner_phone_missing', hint: 'Set tenants.owner_phone or user.phone.' });

    // Best-effort Telnyx transfer. Different Telnyx SDKs/versions have slightly
    // different endpoint shapes; the v2 REST call transfer works for TeXML calls too.
    const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(telnyxId)}/actions/transfer`;
    let telnyxRes;
    try {
      telnyxRes = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          to: ownerPhone,
          from: callRow?.to || tenant.outbound_number || undefined,
          answering_machine_detection: 'premium',
          time_limit_secs: 3600
        })
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'telnyx_request_failed', message: String(e?.message || e) });
    }

    const raw = await telnyxRes.text();
    let telnyxJson = null; try { telnyxJson = JSON.parse(raw); } catch {}

    if (!telnyxRes.ok) {
      return res.status(502).json({
        ok: false,
        error: 'telnyx_transfer_failed',
        status: telnyxRes.status,
        detail: telnyxJson?.errors?.[0]?.detail || raw.slice(0, 400)
      });
    }

    // Update the call row to note the take-over
    try {
      if (callRow?.id) {
        await c.from('calls').update({
          take_over_at: new Date().toISOString(),
          take_over_by: user.id || null,
          status: 'transferred'
        }).eq('id', callRow.id);
      }
    } catch (_) {}

    return res.json({ ok: true, data: { transferred_to: ownerPhone, telnyx: telnyxJson || null } });
  } catch (e) {
    console.error('[take-over]', e?.message);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
