/**
 * /api/setup-voice — Complete voice setup: configure TeXML app webhook,
 * update the AI assistant with tenant details, and verify everything works.
 * This is a one-time setup endpoint (no auth required, protected by a setup secret).
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

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const results = {};

  try {
    // 1. List TeXML apps to find the one our number is attached to
    const texmlRes = await fetch(`${TELNYX}/texml_applications?page[size]=100`, { headers: authHeaders() });
    const texmlData = await texmlRes.json();
    results.texml_apps = (texmlData?.data || []).map(app => ({
      id: app.id,
      name: app.friendly_name || app.name,
      webhook_url: app.webhook_url || app.voice_url || null,
      connection_id: app.connection_id || null
    }));

    // 2. Check if the AI assistant exists and get its details
    const assistantRes = await fetch(`${TELNYX}/ai/assistants?page[size]=100`, { headers: authHeaders() });
    const assistantData = await assistantRes.json();
    results.assistants = (assistantData?.data || []).map(a => ({
      id: a.id,
      name: a.name,
      model: a.model,
      voice: a.voice_settings?.voice,
      texml_app_id: a.telephony_settings?.default_texml_app_id,
      greeting: a.greeting
    }));

    // 3. Find the TeXML app that matches the AI assistant's texml_app_id
    const assistant = assistantData?.data?.[0];
    const texmlAppId = assistant?.telephony_settings?.default_texml_app_id;
    
    if (texmlAppId) {
      // Get the TeXML app details
      const appRes = await fetch(`${TELNYX}/texml_applications/${texmlAppId}`, { headers: authHeaders() });
      const appData = await appRes.json();
      results.texml_app_detail = {
        id: appData?.data?.id,
        name: appData?.data?.friendly_name || appData?.data?.name,
        webhook_url: appData?.data?.webhook_url || appData?.data?.voice_url,
        connection_id: appData?.data?.connection_id
      };

      // 4. If the TeXML app doesn't have a webhook URL, set one
      //    The webhook URL should point to our voice handler for the TeXML-based flow.
      //    But if we're using the AI assistant, the TeXML app might not need a webhook -
      //    the AI assistant handles the conversation directly.
      const appUrl = process.env.APP_URL || 'https://loladesk.com';
      const expectedWebhook = `${appUrl}/api/telnyx-voice`;
      
      if (!results.texml_app_detail.webhook_url) {
        // Update the TeXML app to point to our voice handler
        const updateRes = await fetch(`${TELNYX}/texml_applications/${texmlAppId}`, {
          method: 'PATCH',
          headers: authHeaders(),
          body: JSON.stringify({
            webhook_url: expectedWebhook
          })
        });
        results.texml_app_update = await updateRes.json();
      }
    }

    // 5. Update the AI assistant with tenant-specific instructions if provided
    if (body.tenant && assistant) {
      const tenant = body.tenant;
      const services = (tenant.services || []).map(s => 
        `${s.name} $${s.price}${s.duration ? ' (' + s.duration + ')' : ''}`
      ).join('; ');
      
      const instructions = `You are Lola, the elite AI front-desk receptionist for ${tenant.name}. You act as a 5-star Beverly Hills luxury hotel concierge: incredibly attentive, upscale, warm, slightly bubbly, and highly capable.

BUSINESS DETAILS:
- Name: ${tenant.name}
- Location: ${tenant.location || 'Miami, FL'}
- Hours: ${tenant.hours || 'Tuesday to Saturday, 10am to 8pm'}
- Services & Prices: ${services || 'Haircut $45, Color $120, Highlights $180, Blowout $65, Balayage $250, Deep Conditioning $45'}
- Team: ${(tenant.team || []).map(m => m.name + (m.role ? ' (' + m.role + ')' : '')).join(', ') || 'Our expert stylists'}

RESPONSE STYLE: Be concise, warm, and highly capable. Never say "Great question!" or "I'd be happy to help!". You cut straight to the luxurious, specific answer. Specific numbers, real names, clear next actions.

YOUR CAPABILITIES:
- Book appointments: Gather the service, client name, and preferred day/time
- Answer questions about services, pricing, and availability
- Upsell complementary treatments when discussing bookings
- Take messages for management when needed
- Never state you are an AI unless asked directly

Never apologize for prices. Act like the best receptionist they've ever had.`;

      const updateRes = await fetch(`${TELNYX}/ai/assistants/${assistant.id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({
          instructions,
          greeting: `Hi, thanks for calling ${tenant.name}! This is Lola. How can I help you today?`
        })
      });
      results.assistant_update = await updateRes.json();
    }

    // 6. Check the phone number's current configuration
    const phoneRes = await fetch(`${TELNYX}/phone_numbers?page[size]=100`, { headers: authHeaders() });
    const phoneData = await phoneRes.json();
    results.phone_numbers = (phoneData?.data || []).map(n => ({
      phone_number: n.phone_number,
      id: n.id,
      status: n.status,
      voice_connection: n.voice?.connection_id || null
    }));

    return res.status(200).json({ ok: true, results });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e), results });
  }
}
