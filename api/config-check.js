/**
 * api/config-check.js — Diagnostic endpoint to verify Lola is fully wired
 * Returns detailed status: what's configured, what's missing, what's broken
 */

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const config = {
    status: 'checking',
    timestamp: new Date().toISOString(),
    critical: {
      telnyx_api_key: !!process.env.TELNYX_API_KEY,
      elevenlabs_api_key: !!process.env.ELEVENLABS_API_KEY,
      elevenlabs_voice_id: !!process.env.ELEVENLABS_VOICE_ID,
      supabase_url: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
      supabase_key: !!process.env.SUPABASE_SERVICE_ROLE_KEY
    },
    optional: {
      telnyx_public_key: !!process.env.TELNYX_PUBLIC_KEY,
      integration_encryption_key: !!process.env.INTEGRATION_ENCRYPTION_KEY,
      stripe_api_key: !!process.env.STRIPE_API_KEY,
      app_url: process.env.APP_URL || 'NOT SET'
    },
    issues: [],
    missing: [],
    ready_for_launch: false
  };

  // Check critical
  if (!config.critical.telnyx_api_key) {
    config.issues.push('❌ TELNYX_API_KEY not set — voice calls will fail');
    config.missing.push('TELNYX_API_KEY');
  }
  if (!config.critical.elevenlabs_api_key) {
    config.issues.push('❌ ELEVENLABS_API_KEY not set — Lola cannot speak');
    config.missing.push('ELEVENLABS_API_KEY');
  }
  if (!config.critical.elevenlabs_voice_id) {
    config.issues.push('❌ ELEVENLABS_VOICE_ID not set — Lola has no voice');
    config.missing.push('ELEVENLABS_VOICE_ID');
  }
  if (!config.critical.supabase_url || !config.critical.supabase_key) {
    config.issues.push('❌ Supabase not configured — conversations will not persist');
    if (!config.critical.supabase_url) config.missing.push('NEXT_PUBLIC_SUPABASE_URL');
    if (!config.critical.supabase_key) config.missing.push('SUPABASE_SERVICE_ROLE_KEY');
  }

  // Check optional but recommended
  if (!config.optional.app_url || config.optional.app_url === 'NOT SET') {
    config.issues.push('⚠️  APP_URL not set — Telnyx webhooks may not callback correctly');
  }

  // Test Telnyx connectivity (if key exists)
  if (config.critical.telnyx_api_key) {
    try {
      const res = await fetch('https://api.telnyx.com/v2/ai/openai/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'moonshotai/Kimi-K2.6',
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 10
        })
      });
      config.telnyx_available = res.ok || res.status === 400; // 400 is OK (test message rejected) means API is live
    } catch (e) {
      config.issues.push('⚠️  Telnyx API unreachable — check TELNYX_API_KEY');
    }
  }

  // Test ElevenLabs connectivity (if key + voice exist)
  if (config.critical.elevenlabs_api_key && config.critical.elevenlabs_voice_id) {
    try {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`, {
        method: 'POST',
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: 'Test',
          model_id: 'eleven_turbo_v2_5'
        })
      });
      config.elevenlabs_available = res.ok;
      if (!res.ok) {
        const err = await res.text().catch(() => '');
        config.issues.push(`⚠️  ElevenLabs API error: ${res.status} ${err.slice(0, 100)}`);
      }
    } catch (e) {
      config.issues.push(`⚠️  ElevenLabs unreachable: ${e.message}`);
    }
  }

  // Test Supabase (if configured)
  if (config.critical.supabase_url && config.critical.supabase_key) {
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      const { error } = await sb.from('tenants').select('id').limit(1);
      config.supabase_available = !error;
      if (error) {
        config.issues.push(`⚠️  Supabase error: ${error.message}`);
      }
    } catch (e) {
      config.issues.push(`⚠️  Supabase connection failed: ${e.message}`);
    }
  }

  // Overall status
  config.ready_for_launch = config.missing.length === 0 && config.issues.filter(i => i.startsWith('❌')).length === 0;
  config.status = config.ready_for_launch ? '✅ READY FOR LAUNCH' : (config.missing.length > 0 ? '❌ NOT READY' : '⚠️  WARNINGS');

  const statusCode = config.ready_for_launch ? 200 : (config.missing.length > 0 ? 503 : 200);
  return res.status(statusCode).json(config);
}
