import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export const handleWebhook = async (req, res) => {
  const { event_type, payload } = req.body;
  const tenant_id = req.headers['x-tenant-id'];

  try {
    const { data: tenant } = await supabase.from('tenants').select('*').eq('id', tenant_id).single();
    
    if (event_type === 'call.initiated') {
      return res.status(200).json({
        action: "initialize_session",
        payload: { system_prompt: tenant.config.prompt, voice_id: tenant.config.voice_id }
      });
    }

    if (event_type === 'ai_agent.tool_call') {
      return res.status(200).json({ tool_call_id: payload.tool_call_id, output: JSON.stringify({ status: "success" }) });
    }

    return res.status(200).send({ status: "ok" });
  } catch (error) {
    return res.status(500).json({ error: "Tenant context error" });
  }
};
