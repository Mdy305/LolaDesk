const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'ignored' });
  }

  const { event_type, payload } = req.body || {};

  try {
    if (event_type === 'call.initiated') {
      const dialedNumber = payload.to || payload.custom_parameters?.tenantNumber;
      
      // 🧠 DYNAMIC MULTI-TENANT ROUTER
      // Matches the incoming dialed phone number straight onto your Supabase salon profiles
      const { data: tenant } = await supabase
        .from('tenants')
        .select('id')
        .eq('telnyx_phone_number', dialedNumber)
        .single();

      // 🚀 THE PRODUCTION LINK SWITCH
      // REPLACE the placeholder URL below with your actual active Railway public network address
      const productionCloudUrl = "wss://your-mcp-voice-service.up.railway.app";

      const streamTeXML = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
          <Connect>
              <Stream url="${productionCloudUrl}" track="both_tracks">
                  <Parameter name="tenantId" value="${tenant?.id || 'unknown'}" />
                  <Parameter name="tenantNumber" value="${dialedNumber}" />
              </Stream>
          </Connect>
      </Response>`;
      
      res.setHeader('Content-Type', 'application/xml');
      return res.status(200).send(streamTeXML);
    }
    
    return res.status(200).json({ status: 'processed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
