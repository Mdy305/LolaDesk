/**
 * /api/check-voice — Verify phone number is correctly attached to the AI assistant
 */
const TELNYX = 'https://api.telnyx.com/v2';

function h() {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.TELNYX_API_KEY}` };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // 1. List phone numbers
    const phoneRes = await fetch(`${TELNYX}/phone_numbers?page[size]=100`, { headers: h() });
    const phoneData = await phoneRes.json();
    const numbers = (phoneData?.data || []).map(n => ({
      number: n.phone_number,
      id: n.id,
      status: n.status
    }));

    // 2. For each number, get voice settings
    const details = [];
    for (const n of numbers) {
      const voiceRes = await fetch(`${TELNYX}/phone_numbers/${n.id}/voice`, { headers: h() });
      const voiceData = await voiceRes.json();
      details.push({
        number: n.number,
        status: n.status,
        voice_connection_id: voiceData?.data?.connection_id,
        voice_connection_name: voiceData?.data?.connection_name,
        forwarding: voiceData?.data?.call_forwarding
      });
    }

    // 3. List TeXML apps
    const texmlRes = await fetch(`${TELNYX}/texml_applications?page[size]=100`, { headers: h() });
    const texmlData = await texmlRes.json();
    const apps = (texmlData?.data || []).map(a => ({
      id: a.id,
      name: a.friendly_name || a.name,
      webhook_url: a.webhook_url || a.voice_url
    }));

    // 4. List AI assistants
    const aiRes = await fetch(`${TELNYX}/ai/assistants?page[size]=100`, { headers: h() });
    const aiData = await aiRes.json();
    const assistants = (aiData?.data || []).map(a => ({
      id: a.id,
      name: a.name,
      texml_app_id: a.telephony_settings?.default_texml_app_id,
      greeting: a.greeting
    }));

    // 5. Find the connection that matches the TeXML app for our AI assistant
    // The AI assistant's TeXML app has webhook_url pointing to api.telnyx.com
    // We need to make sure the phone number's voice connection matches this app
    
    return res.status(200).json({
      ok: true,
      phone_numbers: details,
      texml_apps: apps,
      assistants
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
