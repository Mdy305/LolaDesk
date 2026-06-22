const WebSocket = require('ws');
const { DeepgramClient } = require('@deepgram/sdk');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// Capture matching configuration variants dynamically from your production .env
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL_PRODUCTION;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// 🧠 STEVE JOBS EXTRACTION LAYOUT: Conditional Initialization to Prevent Crash Loop
let supabase = null;
if (supabaseUrl && supabaseKey && supabaseUrl !== "your_supabase_url_here") {
  try {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log("✅ Supabase Production Infrastructure connected successfully.");
  } catch (err) {
    console.log("⚠️ Failed to initialize Supabase client:", err.message);
  }
} else {
  console.log("⚠️ Supabase parameters missing or unpopulated in your environment schema.");
  console.log("💡 Running in Standalone Ultra-Low Latency Telephony Engine mode.");
}

const deepgram = new DeepgramClient(process.env.DEEPGRAM_API_KEY);

console.log(`📡 LolaDesk Seamless Core operational on port ${PORT}`);

wss.on('connection', async (ws) => {
  console.log('📞 Telephony Carrier Stream Route Bound.');
  
  let isAiSpeaking = false;
  let elevenLabsWS = null;
  let callStartTime = Date.now();
  let tenantId = null; 

  // Fallback brain state template if database is unlinked
  const fetchTenantContext = async (phoneNumber) => {
    if (!supabase) return "You are Lola, an elite, warm, and highly capable frontdesk AI concierge for a premium salon. Answer questions cleanly, check scheduling requests, and maximize booking conversion opportunities with a natural conversational flow.";
    try {
      const { data, error } = await supabase
        .from('tenants')
        .select('*')
        .eq('telnyx_phone_number', phoneNumber)
        .single();
      if (data) {
        tenantId = data.id;
        console.log(`🧠 Loaded Custom AI Brain Rules for Marketplace Tenant: ${data.business_name}`);
        return data.custom_ai_prompt;
      }
    } catch (e) {
      console.error('Database query fallback:', e.message);
    }
    return "You are Lola, an elite frontdesk receptionist.";
  };

  // Initialize Deepgram Live Streaming Pipeline with High-Precision VAD Endpointing
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
        ws.send(JSON.stringify({
          event: "media",
          media: { payload: response.audio }
        }));
      }
    });
  };

  connectVoiceEngine();

  dgConnection.on('open', () => {
    dgConnection.on('Transcript', async (transcription) => {
      const text = transcription.channel.alternatives?.[0]?.transcript || transcription.channel.alternatives?.transcript;
      
      if (text && text.trim().length > 0) {
        console.log(`🗣️ Customer: ${text}`);

        // 🛑 NATIVE BARGE-IN INTERRUPTION MANAGEMENT (STEVE JOBS SMOOTHNESS)
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

  ws.on('message', (message) => {
    try {
      const packet = JSON.parse(message);
      
      if (packet.event === 'start') {
        const inboundNumber = packet.start.customParameters?.tenantNumber || packet.start.from;
        fetchTenantContext(inboundNumber);
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

    const callDurationSeconds = Math.ceil((Date.now() - callStartTime) / 1000);
    const callDurationMinutes = Math.ceil(callDurationSeconds / 60);

    if (tenantId && supabase) {
      console.log(`📊 Logged ${callDurationMinutes} call minutes to your Supabase application telemetry schema.`);
      try {
        await supabase.rpc('increment_tenant_call_minutes', { 
          tenant_id_param: tenantId, 
          duration_minutes: callDurationMinutes 
        });
      } catch (err) {}
    }
  });
});
