/**
 * api/debug-lola.js — Debug endpoint to inspect Lola's actual system prompt & configuration
 * Useful for diagnosing why Lola doesn't sound right or respond correctly
 */

import { buildLolaSystemPrompt } from './lib/lola-skills.js';
import { db } from './lib/db.js';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  try {
    // Get a sample tenant (first one in the database)
    const supabase = db();
    const { data: tenants, error: tenantError } = await supabase
      .from('tenants')
      .select('*')
      .limit(1);

    if (tenantError || !tenants || tenants.length === 0) {
      return res.status(200).json({
        status: 'no_tenants',
        message: 'No tenants configured in Supabase yet. This is expected for a fresh setup.',
        error: tenantError?.message
      });
    }

    const tenant = tenants[0];

    // Build system prompts for both channels
    const voiceSystemPrompt = buildLolaSystemPrompt({
      tenant,
      channel: 'voice',
      intent: 'booking_new',
      mood: 'neutral',
      memoryBlock: '(Sample: first-time caller, no history)'
    });

    const dashboardSystemPrompt = buildLolaSystemPrompt({
      tenant,
      channel: 'dashboard',
      intent: 'general',
      mood: 'neutral',
      memoryBlock: ''
    });

    return res.status(200).json({
      status: 'ok',
      tenant: {
        id: tenant.id,
        name: tenant.name,
        services: tenant.services ? (Array.isArray(tenant.services) ? tenant.services.slice(0, 2) : 'not an array') : 'none',
        phone: tenant.phone,
        location: tenant.location
      },
      lola_configuration: {
        voice_system_prompt_length: voiceSystemPrompt.length,
        dashboard_system_prompt_length: dashboardSystemPrompt.length,
        voice_channel_configured: voiceSystemPrompt.includes('warm') ? true : false,
        dashboard_channel_configured: dashboardSystemPrompt.includes('profit') ? true : false
      },
      sample_prompts: {
        voice_intro: voiceSystemPrompt.split('\n').slice(0, 10).join('\n'),
        dashboard_intro: dashboardSystemPrompt.split('\n').slice(0, 10).join('\n')
      },
      environment: {
        elevenlabs_configured: !!process.env.ELEVENLABS_API_KEY,
        elevenlabs_voice_id: process.env.ELEVENLABS_VOICE_ID ? process.env.ELEVENLABS_VOICE_ID.slice(0, 8) + '...' : 'NOT SET',
        telnyx_configured: !!process.env.TELNYX_API_KEY,
        node_env: process.env.NODE_ENV
      },
      diagnostics: {
        lola_has_personality: voiceSystemPrompt.includes('warm, intelligent') ? '✅ yes' : '❌ no',
        lola_knows_services: voiceSystemPrompt.includes(tenant.name) ? '✅ yes' : '❌ no',
        lola_uses_memory: voiceSystemPrompt.includes('client memory') ? '✅ yes' : '❌ no'
      }
    });
  } catch (e) {
    return res.status(200).json({
      status: 'error',
      error: e.message,
      stack: e.stack ? e.stack.slice(0, 300) : 'no stack'
    });
  }
}
