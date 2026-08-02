/**
 * /api/fix-call-routing — Attach phone number to the correct TeXML app
 * 
 * The phone number must be connected to TeXML app 2991758319724529273
 * (webhook: https://www.loladesk.com/api/telnyx-voice) for calls to
 * reach our multi-tenant voice handler.
 */
const TELNYX = 'https://api.telnyx.com/v2';

function h() {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.TELNYX_API_KEY}` };
}

// The TeXML app ID that has our webhook → loladesk.com/api/telnyx-voice
const CORRECT_TEXML_APP_ID = '2991758319724529273';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const phoneNumber = body.phone_number || '+13058925377';
  const results = { steps: [] };

  try {
    // 1. Verify the target TeXML app exists and has the right webhook
    const texmlRes = await fetch(`${TELNYX}/texml_applications/${CORRECT_TEXML_APP_ID}`, { headers: h() });
    const texmlData = await texmlRes.json();
    const texmlApp = texmlData?.data;
    
    if (!texmlApp) {
      return res.status(500).json({ 
        error: 'Target TeXML app not found',
        id: CORRECT_TEXML_APP_ID
      });
    }
    
    results.steps.push({
      step: 'verify_texml_app',
      status: 'found',
      id: texmlApp.id,
      name: texmlApp.friendly_name || texmlApp.name,
      webhook_url: texmlApp.webhook_url || texmlApp.voice_url
    });

    // 2. Find our phone number's resource ID
    const phoneRes = await fetch(`${TELNYX}/phone_numbers?page[size]=100`, { headers: h() });
    const phoneData = await phoneRes.json();
    const phoneRecord = (phoneData?.data || []).find(n => n.phone_number === phoneNumber);
    
    if (!phoneRecord) {
      return res.status(404).json({ error: 'Phone number not found', target: phoneNumber });
    }
    
    // 3. Check current voice connection
    const voiceRes = await fetch(`${TELNYX}/phone_numbers/${phoneRecord.id}/voice`, { headers: h() });
    const voiceData = await voiceRes.json();
    const currentConn = voiceData?.data?.connection_id;
    
    results.steps.push({
      step: 'current_connection',
      connection_id: currentConn,
      connection_name: voiceData?.data?.connection_name
    });

    // 4. Switch to the correct TeXML app
    // In Telnyx, the connection_id for a TeXML app is the TeXML app ID itself
    if (currentConn !== CORRECT_TEXML_APP_ID) {
      const switchRes = await fetch(`${TELNYX}/phone_numbers/${phoneRecord.id}/voice`, {
        method: 'PATCH',
        headers: h(),
        body: JSON.stringify({ connection_id: CORRECT_TEXML_APP_ID })
      });
      const switchData = await switchRes.json();
      
      results.steps.push({
        step: 'switch_connection',
        status: switchRes.ok ? 'switched' : 'failed',
        from: currentConn,
        to: CORRECT_TEXML_APP_ID,
        new_connection_name: switchData?.data?.connection_name,
        http_status: switchRes.status,
        detail: switchRes.ok ? null : switchData
      });
    } else {
      results.steps.push({ 
        step: 'switch_connection', 
        status: 'already_correct',
        connection_id: currentConn
      });
    }

    // 5. Also fix any other numbers on the wrong connection
    const otherNumbers = (phoneData?.data || [])
      .filter(n => n.phone_number !== phoneNumber && n.status === 'active');
    
    for (const n of otherNumbers) {
      const vRes = await fetch(`${TELNYX}/phone_numbers/${n.id}/voice`, { headers: h() });
      const vData = await vRes.json();
      if (vData?.data?.connection_id === '2982432232334951429') {
        // This number is on the broken "LolaDesk" connection too
        const fixRes = await fetch(`${TELNYX}/phone_numbers/${n.id}/voice`, {
          method: 'PATCH',
          headers: h(),
          body: JSON.stringify({ connection_id: CORRECT_TEXML_APP_ID })
        });
        const fixData = await fixRes.json();
        results.steps.push({
          step: 'fix_other_number',
          number: n.phone_number,
          status: fixRes.ok ? 'fixed' : 'failed',
          new_connection: fixData?.data?.connection_name
        });
      }
    }

    // 6. Verify the final state
    const verifyRes = await fetch(`${TELNYX}/phone_numbers/${phoneRecord.id}/voice`, { headers: h() });
    const verifyData = await verifyRes.json();
    results.steps.push({
      step: 'verify',
      connection_id: verifyData?.data?.connection_id,
      connection_name: verifyData?.data?.connection_name,
      correct: verifyData?.data?.connection_id === CORRECT_TEXML_APP_ID
    });

    return res.status(200).json({ ok: true, results });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e), results });
  }
}
