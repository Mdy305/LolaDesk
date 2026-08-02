/**
 * /api/fix-voice-multi-tenant — Ensure the phone number routes through
 * the multi-tenant TeXML handler (telnyx-voice.js), NOT a single AI assistant.
 *
 * This endpoint:
 * 1. Finds the TeXML app with webhook → loladesk.com/api/telnyx-voice
 * 2. Gets its connection ID
 * 3. Attaches our phone number to that connection
 * 4. Updates the tenant with salon details in the database
 * 5. Returns the full verification
 */
const TELNYX = 'https://api.telnyx.com/v2';

function h() {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.TELNYX_API_KEY}` };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const appUrl = (process.env.APP_URL || 'https://loladesk.com').replace(/\/+$/, '');
  const results = { steps: [] };

  try {
    // ── STEP 1: Find the TeXML app with our webhook URL ──
    const texmlRes = await fetch(`${TELNYX}/texml_applications?page[size]=100`, { headers: h() });
    const texmlData = await texmlRes.json();
    const allApps = texmlData?.data || [];

    // Find the app that points to our multi-tenant handler
    let texmlApp = allApps.find(a =>
      (a.webhook_url || a.voice_url || '').includes('loladesk.com/api/telnyx-voice')
    );

    // If not found, find one that we can update
    if (!texmlApp) {
      // Try to find a TeXML app named "LolaDesk" or similar
      texmlApp = allApps.find(a =>
        (a.friendly_name || a.name || '').toLowerCase().includes('loladesk')
      );
    }

    // If still not found, check all connections for one named "LolaDesk"
    if (!texmlApp) {
      results.steps.push({ step: 'find_texml', status: 'not_found', available: allApps.map(a => ({ id: a.id, name: a.friendly_name || a.name, webhook: a.webhook_url || a.voice_url })) });
    } else {
      results.steps.push({ step: 'find_texml', status: 'found', id: texmlApp.id, name: texmlApp.friendly_name || texmlApp.name, webhook: texmlApp.webhook_url || texmlApp.voice_url });
    }

    // ── STEP 2: Find the connection for our TeXML app ──
    // In Telnyx, each TeXML app has an associated connection. We need to
    // find the connection_id to attach phone numbers.
    // Let's list all connections and find the one that matches.
    const connRes = await fetch(`${TELNYX}/connections?page[size]=100`, { headers: h() });
    const connData = await connRes.json();
    const allConns = connData?.data || [];

    // The "LolaDesk" connection is what our number is currently on
    const loladeskConn = allConns.find(c =>
      (c.friendly_name || c.connected_name || '').includes('LolaDesk')
    );

    // Also find the connection for the TeXML app with our webhook
    let targetConnId = null;
    if (texmlApp) {
      // The TeXML app ID might be the connection ID, or we need to find it
      // Let's check if any connection's id matches the TeXML app id
      const matchConn = allConns.find(c => c.id === texmlApp.id);
      if (matchConn) {
        targetConnId = matchConn.id;
      }
    }

    // If we have the "LolaDesk" connection, use that — it's the one our
    // number is already on, and it likely routes to our TeXML handler
    if (!targetConnId && loladeskConn) {
      targetConnId = loladeskConn.id;
    }

    results.steps.push({
      step: 'find_connection',
      status: targetConnId ? 'found' : 'not_found',
      loladesk_connection: loladeskConn ? { id: loladeskConn.id, name: loladeskConn.friendly_name || loladeskConn.connected_name } : null,
      target_connection_id: targetConnId,
      all_connections: allConns.map(c => ({ id: c.id, name: c.friendly_name || c.connected_name, webhook: c.webhook_url }))
    });

    // ── STEP 3: Check/update the connection's webhook URL ──
    // If the connection doesn't have a webhook URL pointing to our handler,
    // we need to update the TeXML app to set it
    if (texmlApp) {
      const currentWebhook = texmlApp.webhook_url || texmlApp.voice_url || '';
      const expectedWebhook = `${appUrl}/api/telnyx-voice`;

      if (!currentWebhook.includes('loladesk.com/api/telnyx-voice')) {
        // Update the TeXML app's webhook URL
        const updateRes = await fetch(`${TELNYX}/texml_applications/${texmlApp.id}`, {
          method: 'PATCH',
          headers: h(),
          body: JSON.stringify({ webhook_url: expectedWebhook })
        });
        const updateData = await updateRes.json();
        results.steps.push({
          step: 'update_webhook',
          status: updateRes.ok ? 'updated' : 'failed',
          old_webhook: currentWebhook,
          new_webhook: expectedWebhook,
          response: updateData
        });
      } else {
        results.steps.push({ step: 'update_webhook', status: 'already_set', webhook: currentWebhook });
      }
    }

    // ── STEP 4: Attach phone number to the right connection ──
    const phoneNumber = body.phone_number || '+13058925377';

    // List phone numbers to find our number's resource ID
    const phoneRes = await fetch(`${TELNYX}/phone_numbers?page[size]=100`, { headers: h() });
    const phoneData = await phoneRes.json();
    const phoneRecord = (phoneData?.data || []).find(n => n.phone_number === phoneNumber);

    if (!phoneRecord) {
      results.steps.push({ step: 'find_phone', status: 'not_found', target: phoneNumber });
    } else {
      results.steps.push({ step: 'find_phone', status: 'found', id: phoneRecord.id, number: phoneNumber, status: phoneRecord.status });

      // Get current voice settings
      const voiceRes = await fetch(`${TELNYX}/phone_numbers/${phoneRecord.id}/voice`, { headers: h() });
      const voiceData = await voiceRes.json();
      const currentConn = voiceData?.data?.connection_id;
      const currentConnName = voiceData?.data?.connection_name;

      results.steps.push({
        step: 'current_voice',
        connection_id: currentConn,
        connection_name: currentConnName
      });

      // If the connection needs to be changed, do it
      if (targetConnId && currentConn !== targetConnId) {
        const switchRes = await fetch(`${TELNYX}/phone_numbers/${phoneRecord.id}/voice`, {
          method: 'PATCH',
          headers: h(),
          body: JSON.stringify({ connection_id: targetConnId })
        });
        const switchData = await switchRes.json();
        results.steps.push({
          step: 'switch_connection',
          status: switchRes.ok ? 'switched' : 'failed',
          from: currentConn,
          to: targetConnId,
          detail: switchData?.data?.connection_name
        });
      } else {
        results.steps.push({ step: 'switch_connection', status: 'already_correct' });
      }
    }

    // ── STEP 5: Update tenant in database ──
    if (body.tenant && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      try {
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
          auth: { persistSession: false }
        });

        // Find tenant by phone number or by the one we just provisioned
        let { data: tenant } = await supabase
          .from('tenants')
          .select('*')
          .eq('phone_number', phoneNumber)
          .maybeSingle();

        if (!tenant) {
          // Find the most recent tenant without a phone number
          const { data } = await supabase
            .from('tenants')
            .select('*')
            .is('phone_number', null)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          tenant = data;
        }

        if (tenant) {
          const update = {
            phone_number: phoneNumber,
            name: body.tenant.name || tenant.name || 'LolaDesk Salon',
            location: body.tenant.location || tenant.location || 'Miami, FL',
            hours: body.tenant.hours || tenant.hours || 'Monday to Saturday, 9am to 8pm',
            services: body.tenant.services || tenant.services || [],
            team: body.tenant.team || tenant.team || [],
            updated_at: new Date().toISOString()
          };

          const { data: updated, error } = await supabase
            .from('tenants')
            .update(update)
            .eq('id', tenant.id)
            .select()
            .maybeSingle();

          results.steps.push({
            step: 'update_tenant',
            status: error ? 'failed' : 'updated',
            tenant_id: tenant.id,
            error: error?.message,
            tenant: updated ? {
              id: updated.id,
              name: updated.name,
              phone_number: updated.phone_number,
              hours: updated.hours,
              services_count: Array.isArray(updated.services) ? updated.services.length : 0
            } : null
          });
        } else {
          results.steps.push({ step: 'update_tenant', status: 'no_tenant_found' });
        }
      } catch (dbErr) {
        results.steps.push({ step: 'update_tenant', status: 'error', error: String(dbErr?.message || dbErr) });
      }
    }

    // ── STEP 6: Verify the complete flow ──
    // Check that our voice handler endpoint is accessible
    try {
      const handlerCheck = await fetch(`${appUrl}/api/telnyx-voice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'From=+13055551234&To=' + phoneNumber
      });
      results.steps.push({
        step: 'verify_handler',
        status: handlerCheck.ok ? 'accessible' : 'error',
        http_status: handlerCheck.status
      });
    } catch (e) {
      results.steps.push({ step: 'verify_handler', status: 'fetch_failed', error: String(e?.message || e) });
    }

    return res.status(200).json({ ok: true, results });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e), results });
  }
}
