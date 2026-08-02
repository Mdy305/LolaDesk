/**
 * /api/debug-voice — Debug the voice call flow
 */
const TELNYX = 'https://api.telnyx.com/v2';

function h() {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.TELNYX_API_KEY}` };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const debug = {};

  // 1. Check env vars
  debug.env = {
    TELNYX_API_KEY: !!process.env.TELNYX_API_KEY,
    TELNYX_PUBLIC_KEY: !!process.env.TELNYX_PUBLIC_KEY,
    TELNYX_VOICE_APP_ID: process.env.TELNYX_VOICE_APP_ID || null,
    ELEVENLABS_API_KEY: !!process.env.ELEVENLABS_API_KEY,
    ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID || null,
    APP_URL: process.env.APP_URL || null,
    SUPABASE_URL: !!process.env.SUPABASE_URL
  };

  try {
    // 2. List phone numbers and their voice connections
    const phoneRes = await fetch(`${TELNYX}/phone_numbers?page[size]=100`, { headers: h() });
    const phoneData = await phoneRes.json();
    debug.phone_numbers = [];
    
    for (const n of (phoneData?.data || [])) {
      const voiceRes = await fetch(`${TELNYX}/phone_numbers/${n.id}/voice`, { headers: h() });
      const voiceData = await voiceRes.json();
      debug.phone_numbers.push({
        number: n.phone_number,
        status: n.status,
        id: n.id,
        voice_connection_id: voiceData?.data?.connection_id,
        voice_connection_name: voiceData?.data?.connection_name
      });
    }

    // 3. List TeXML apps
    const texmlRes = await fetch(`${TELNYX}/texml_applications?page[size]=100`, { headers: h() });
    const texmlData = await texmlRes.json();
    debug.texml_apps = (texmlData?.data || []).map(a => ({
      id: a.id,
      name: a.friendly_name || a.name,
      webhook_url: a.webhook_url || a.voice_url,
      created_at: a.created_at
    }));

    // 4. List connections (these are what phone numbers attach to)
    const connRes = await fetch(`${TELNYX}/connections?page[size]=100`, { headers: h() });
    const connData = await connRes.json();
    debug.connections = (connData?.data || []).map(c => ({
      id: c.id,
      name: c.friendly_name || c.connected_name,
      type: c.connection_type || c.type,
      webhook_url: c.webhook_url,
      texml_app_id: c.texml_application_id || c.application_id || null
    }));

    // 5. For each TeXML app, get its details to find the connection_id
    debug.texml_details = [];
    for (const app of (texmlData?.data || []).slice(0, 10)) {
      const appRes = await fetch(`${TELNYX}/texml_applications/${app.id}`, { headers: h() });
      const appDetail = await appRes.json();
      debug.texml_details.push({
        id: appDetail?.data?.id,
        name: appDetail?.data?.friendly_name || appDetail?.data?.name,
        webhook_url: appDetail?.data?.webhook_url || appDetail?.data?.voice_url,
        connection_id: appDetail?.data?.connection_id,
        raw_keys: Object.keys(appDetail?.data || {}).filter(k => k.includes('conn') || k.includes('voice'))
      });
    }

    // 6. Check the signature verification code
    debug.signature_check = {
      public_key_set: !!process.env.TELNYX_PUBLIC_KEY,
      note: 'If TELNYX_PUBLIC_KEY is set, all non-runtime-parsed requests must pass signature verification. Real Telnyx calls include a signature header.'
    };

    // 7. Test the webhook URL reachability
    const targetNumber = debug.phone_numbers.find(n => n.number === '+13058925377');
    if (targetNumber) {
      debug.target_number = targetNumber;
      
      // Check which TeXML app has the connection our number uses
      const matchingApp = debug.texml_details.find(a => a.connection_id === targetNumber.voice_connection_id);
      debug.matching_texml_app = matchingApp || { 
        note: 'No TeXML app found with matching connection_id',
        looking_for: targetNumber.voice_connection_id 
      };
    }

    return res.status(200).json({ ok: true, debug });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e), debug });
  }
}
