// api/onboarding/step3-configure.js - Configure LolaBrain voice
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { tenantId, voiceType, personality, selectedServices } = req.body;

  try {
    await supabase
      .from('tenants')
      .update({
        lolabrain_voice: voiceType, // jarvis, whisper, alexa, siri, lola
        lolabrain_personality: personality,
        status: 'onboarding_step3',
      })
      .eq('id', tenantId);

    // Store service selection
    await supabase.from('tenant_memories').upsert({
      tenant_id: tenantId,
      memory_type: 'configuration',
      memory_key: 'services',
      value: selectedServices,
      source: 'onboarding',
    });

    res.json({ ok: true, configured: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
