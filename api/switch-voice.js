/**
 * /api/switch-voice — Switch phone number to the AI assistant's voice connection
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

  try {
    // 1. List phone numbers to find our number's resource ID
    const phoneRes = await fetch(`${TELNYX}/phone_numbers?page[size]=100`, { headers: h() });
    const phoneData = await phoneRes.json();
    const found = (phoneData?.data || []).find(n => n.phone_number === body.phone_number);

    if (!found) {
      return res.status(404).json({ error: 'Number not found', target: body.phone_number });
    }

    // 2. List all connections to find the AI assistant's connection
    // The AI assistant "LolaBrain" has a connection named "LolaBrain"
    const connRes = await fetch(`${TELNYX}/connections?page[size]=100`, { headers: h() });
    const connData = await connRes.json();
    const connections = (connData?.data || []).filter(c =>
      c.connected_name === 'LolaBrain' ||
      c.friendly_name === 'LolaBrain' ||
      c.id === body.connection_id
    );

    // Also check via the existing number that's already on LolaBrain
    const lolabrainNumber = (phoneData?.data || []).find(n =>
      n.id && n.phone_number !== body.phone_number
    );

    // Get the voice settings of the number already on LolaBrain to find the connection ID
    let lolabrainConnId = body.connection_id;
    if (!lolabrainConnId) {
      // Find a number already connected to LolaBrain
      for (const n of (phoneData?.data || [])) {
        if (n.phone_number === body.phone_number) continue;
        const vRes = await fetch(`${TELNYX}/phone_numbers/${n.id}/voice`, { headers: h() });
        const vData = await vRes.json();
        if (vData?.data?.connection_name === 'LolaBrain') {
          lolabrainConnId = vData?.data?.connection_id;
          break;
        }
      }
    }

    if (!lolabrainConnId) {
      return res.status(500).json({
        error: 'Could not find LolaBrain connection ID',
        connections: connections.map(c => ({ id: c.id, name: c.friendly_name || c.connected_name }))
      });
    }

    // 3. Switch our number to the LolaBrain connection
    const switchRes = await fetch(`${TELNYX}/phone_numbers/${found.id}/voice`, {
      method: 'PATCH',
      headers: h(),
      body: JSON.stringify({ connection_id: lolabrainConnId })
    });
    const switchData = await switchRes.json();

    return res.status(200).json({
      ok: true,
      phone_number: body.phone_number,
      phone_id: found.id,
      previous_connection: switchData?.data?.connection_name,
      connection_id: lolabrainConnId,
      connection_name: 'LolaBrain',
      voice_attached: switchRes.ok,
      detail: switchData?.data
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
