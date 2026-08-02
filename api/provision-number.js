/**
 * /api/provision-number — Find and provision a purchased phone number
 * Lists all phone numbers on the account, finds the matching one,
 * and attaches it to the TeXML voice app + messaging profile.
 */
const TELNYX = 'https://api.telnyx.com/v2';

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!process.env.TELNYX_API_KEY) {
    return res.status(500).json({ error: 'Missing TELNYX_API_KEY' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const targetNumber = body.phone_number;
  if (!targetNumber) return res.status(400).json({ error: 'phone_number required' });

  try {
    // 1. List all phone numbers on the account
    const listRes = await fetch(`${TELNYX}/phone_numbers?page[size]=100`, { headers: authHeaders() });
    const listData = await listRes.json();
    
    if (!listData?.data) {
      return res.status(500).json({ error: 'Failed to list phone numbers', detail: listData });
    }

    // 2. Find the matching number
    const found = listData.data.find(n => n.phone_number === targetNumber);
    if (!found) {
      return res.status(404).json({ 
        error: 'Number not found on account. Order may still be pending.',
        target: targetNumber,
        available: listData.data.map(n => n.phone_number)
      });
    }

    const phoneId = found.id;
    const results = { phone_number: targetNumber, phone_id: phoneId };

    // 3. Attach to TeXML voice app
    const voiceAppId = process.env.TELNYX_VOICE_APP_ID;
    if (voiceAppId) {
      const voiceRes = await fetch(`${TELNYX}/phone_numbers/${phoneId}/voice`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ connection_id: voiceAppId })
      });
      results.voice = await voiceRes.json();
      results.voice_attached = voiceRes.ok;
    }

    // 4. Attach to messaging profile
    const msgProfile = process.env.TELNYX_MESSAGING_PROFILE;
    if (msgProfile) {
      const msgRes = await fetch(`${TELNYX}/messaging_phone_numbers/${encodeURIComponent(targetNumber)}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ messaging_profile_id: msgProfile })
      });
      results.messaging = await msgRes.json();
      results.messaging_attached = msgRes.ok;
    }

    // 5. Update tenant in database if Supabase is configured
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      try {
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
          auth: { persistSession: false }
        });
        // Update any tenant that has this number, or the first tenant if none matches
        const { data: existing } = await supabase
          .from('tenants')
          .select('id, phone_number')
          .eq('phone_number', targetNumber)
          .maybeSingle();
        
        if (!existing) {
          // Update the most recent tenant that has no phone number
          const { data: tenant } = await supabase
            .from('tenants')
            .select('id, phone_number')
            .is('phone_number', null)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          
          if (tenant) {
            await supabase.from('tenants').update({
              phone_number: targetNumber,
              updated_at: new Date().toISOString()
            }).eq('id', tenant.id);
            results.tenant_updated = tenant.id;
          }
        } else {
          results.tenant_already_has_number = existing.id;
        }
      } catch (dbErr) {
        results.db_error = String(dbErr?.message || dbErr);
      }
    }

    return res.status(200).json({ ok: true, results });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
