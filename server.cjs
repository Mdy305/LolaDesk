const WebSocket = require('ws');
const { DeepgramClient } = require('@deepgram/sdk');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// Initialize Production Client Clusters
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

let supabase = null;
if (supabaseUrl && supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log("✅ Supabase Production Database Connected.");
  } catch (err) {
    console.log("⚠️ Supabase connection error:", err.message);
  }
} else {
  console.log("❌ CRITICAL: Supabase credentials are missing. App features will be locked.");
}

const deepgram = new DeepgramClient(process.env.DEEPGRAM_API_KEY);

console.log(`📡 LolaDesk Marketplace Engine Online on Port ${PORT}`);

wss.on('connection', async (ws) => {
  let isAiSpeaking = false;
  let elevenLabsWS = null;
  let callStartTime = Date.now();
  let tenantId = null;
  let systemPrompt = "You are an elite frontdesk assistant.";

  // THE MULTI-TENANT BRAIN ROUTER (SUPABASE INTERACTION)
  const configureDynamicTenant = async (dialedNumber) => {
    if (!supabase) return;
    try {
      console.log(`🔍 Routing call packets dialed to: ${dialedNumber}`);
      
      const { data, error } = await supabase
        .from('tenants')
        .select('*')
        .eq('telnyx_phone_number', dialedNumber)
        .single();
        
      if (data) {
        tenantId = data.id;
        systemPrompt = data.custom_ai_prompt || `You are Lola, the receptionist for ${data.business_name}.`;
        console.log(`🚀 Database Synced! Loaded configuration files for: ${data.business_name}`);
      } else {
        console.log(`⚠️ Number ${dialedNumber} not found in Supabase table routing schema.`);
      }
    } catch (err) {
      console.error('Database read error:', err.message);
    }
  };

  // MODEL CONTEXT PROTOCOL (MCP) TOOL EXECUTION BRIDGE
  const executeMcpTool = async (toolName, argumentsObj) => {
    console.log(`🛠️ MCP Server Intercept: Executing tool [${toolName}] for Tenant ID: ${tenantId}`);
    try {
      const response = await fetch(`${process.env.MCP_SERVER_URL}/execute`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.MCP_AUTH_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ tool: toolName, args: argumentsObj, tenantId: tenantId })
      });
      const data = await response.json();
      return data.result;
    } catch (err) {
      console.error('MCP Tool Execution failed:', err.message);
      return "Error checking backend scheduling profiles.";
    }
  };

  const dgConnection = deepgram.listen.live({
    model: 'nova-2-general',
    language: 'en-US',
    smart_format: true,
    encoding: 'linear16',
    sample_rate: 8000, 
    channels: 1,
    endpointing: 120 
  });

  const connectVoiceEngine = () => {
    elevenLabsWS = new WebSocket(
      `wss://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}/stream-input?optimize_streaming_latency=4`
    );

    elevenLabsWS.on('open', () => {
      elevenLabsWS.send(JSON.stringify({
        text: " ",
        voice_settings: { stability: 0.5, similarity_boost: 0.8 },
        xi_api_key: process.env.ELEVENLABS_API_KEY
      }));
    });

    elevenLabsWS.on('message', (data) => {
      const response = JSON.parse(data);
      if (response.audio) {
        isAiSpeaking = true;
        ws.send(JSON.stringify({ event: "media", media: { payload: response.audio } }));
      }
    });
  };

  connectVoiceEngine();

  dgConnection.on('open', () => {
    dgConnection.on('Transcript', async (transcription) => {
      const text = transcription.channel.alternatives?.transcript;
      
      if (text && text.trim().length > 0) {
        console.log(`🗣️ Customer: ${text}`);

        if (isAiSpeaking) {
          ws.send(JSON.stringify({ event: "clear" })); 
          isAiSpeaking = false;
          elevenLabsWS.close(); 
          connectVoiceEngine(); 
        }

        elevenLabsWS.send(JSON.stringify({ text: `${text} `, try_trigger_generation: true }));
      }
    });
  });

  ws.on('message', async (message) => {
    try {
      const packet = JSON.parse(message);
      if (packet.event === 'start') {
        const dialedNumber = packet.start.to || packet.start.customParameters?.tenantNumber;
        await configureDynamicTenant(dialedNumber);
      }
      if (packet.event === 'media') {
        dgConnection.send(Buffer.from(packet.media.payload, 'base64'));
      }
    } catch (e) {}
  });

  ws.on('close', async () => {
    console.log('📴 Call disconnected.');
    dgConnection.finish();
    if (elevenLabsWS) elevenLabsWS.close();

    const callDurationMinutes = Math.ceil((Date.now() - callStartTime) / 1000 / 60);

    if (tenantId && supabase) {
      console.log(`📊 Overage Accounting: Charging ${callDurationMinutes} minutes to tenant.`);
      try {
        await supabase.rpc('increment_tenant_call_minutes', { 
          tenant_id_param: tenantId, 
          duration_minutes: callDurationMinutes 
        });
      } catch (err) {}
    }
  });
});
