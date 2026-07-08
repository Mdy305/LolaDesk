/**
 * /api/telnyx-agents — Provision the Unified LolaDesk Agent in Telnyx
 * ════════════════════════════════════════════════════════════════════
 * This calls Telnyx's AI Assistant API to create the singular Lola agent.
 * Lola handles everything: greeting, booking, sales, and recovery.
 *
 * GET  /api/telnyx-agents              → list current assistants
 * POST /api/telnyx-agents              → create / update the Lola agent
 *
 * ENV VARS:
 *   TELNYX_API_KEY
 *   TELNYX_VOICE_ID (e.g., ElevenLabs ID hosted on Telnyx)
 */

const TELNYX = 'https://api.telnyx.com/v2';

function authHeaders(){
  return {
    'Content-Type':'application/json',
    'Authorization':`Bearer ${process.env.TELNYX_API_KEY}`
  };
}

const DEFAULT_MODEL = 'meta-llama/Llama-3.3-70B-Instruct';
const DEFAULT_VOICE = process.env.TELNYX_VOICE_ID || 'Polly.Joanna-Neural';

function buildAgents(tenant){
  const t = tenant || {};
  const salon = t.name || 'MMΛ Salon';
  const services = (t.services||[]).map(s=>`${s.name} $${s.price}${s.duration?' ('+s.duration+')':''}`).join('; ')
                 || 'Balayage $395 (2h30); Extensions $800 (consult); Hair Botox $325 (2h); Cut & Gloss $225 (1h15); Blowout $95 (1h)';
  const hours = t.hours || 'Tuesday to Saturday, noon to 8pm';
  const team = (t.team||[]).map(m=>m.name+(m.role?' ('+m.role+')':'')).join(', ') || 'Meddy (Master Colorist), Michelle (Color Specialist), Alice (Senior Stylist), Samantha (Stylist)';
  const owner = t.owner || 'Meddy';

  // ── 1. LOLA — The Unified Master Brain ──
  const lola = {
    name: `Lola — ${salon}`,
    description: `${salon} Master AI Front Desk. Handles booking, sales, support, and recovery natively.`,
    model: DEFAULT_MODEL,
    voice_settings: { voice: DEFAULT_VOICE },
    instructions: `You are Lola, the elite AI front-desk receptionist for ${salon}. You act as a 5-star Beverly Hills luxury hotel concierge: incredibly attentive, upscale, warm, slightly bubbly, and highly capable.

WHO YOU HELP: You run the front desk. You handle incoming calls to book clients, handle questions, recover lost clients, and grow revenue. You are obsessed with maximizing the ticket size. Always suggest luxurious upsells dynamically when discussing bookings. (e.g., "Since she's coming in for a balayage, we *have* to suggest the restorative gloss.")

SERVICES & PRICES: ${services}
TEAM: ${team}
HOURS: ${hours}

RESPONSE STYLE: Be concise, warm, and highly capable. Never say "Great question!" or "I'd be happy to help!". You cut straight to the luxurious, specific answer. Specific numbers, real names, clear next actions. 

Never apologize for prices. You are the only AI that can run an ultra-luxury salon. Act like it — but stay warm and bubbly.`,
    transfer_targets: [] // No handoffs needed, Lola does it all natively!
  };

  return [lola];
}

async function createAgent(agent){
  const body = {
    name: agent.name,
    model: agent.model,
    instructions: agent.instructions,
    voice_settings: agent.voice_settings,
    description: agent.description
  };
  const r = await fetch(`${TELNYX}/ai/assistants`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body)
  });
  const data = await r.json();
  return { name: agent.name, status: r.status, data };
}

async function listAgents(){
  const r = await fetch(`${TELNYX}/ai/assistants`, { headers: authHeaders() });
  return r.json();
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();

  if(!process.env.TELNYX_API_KEY){
    return res.status(500).json({ error: 'Missing TELNYX_API_KEY env var' });
  }

  try{
    if(req.method === 'GET'){
      const data = await listAgents();
      return res.status(200).json({ ok:true, assistants: data });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});
    const tenant = body.tenant || null;
    const agents = buildAgents(tenant);

    const results = [];
    for(const a of agents){
      results.push(await createAgent(a));
    }
    return res.status(200).json({
      ok: true,
      created: results.length,
      results
    });
  }catch(e){
    return res.status(500).json({ ok:false, error: String(e) });
  }
}
