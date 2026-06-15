/**
 * /api/telnyx-agents — Provision the LolaDesk multi-agent team in Telnyx
 * ════════════════════════════════════════════════════════════════════
 * This calls Telnyx's AI Assistant API to create all 7 agents:
 *   Lola (orchestrator), Booker, Sales, Concierge, Recovery, Support, Handoff
 *
 * The orchestrator hands off to specialists via Telnyx's multi-agent
 * handoff feature. Each specialist can route back to Lola or to Handoff.
 *
 * GET  /api/telnyx-agents              → list current Lola assistants
 * POST /api/telnyx-agents              → create / update the full 7-agent team
 *
 * ENV VARS:
 *   TELNYX_API_KEY
 *
 * Telnyx AI Assistant endpoint shape (v2):
 *   POST https://api.telnyx.com/v2/ai/assistants
 *   {
 *     name, model, instructions, voice_settings, tools, transfer_targets
 *   }
 *
 * Notes: Telnyx evolves this API quickly. We use the documented shape as
 * of the Voice AI Agents launch; verify against the latest portal docs.
 */

const TELNYX = 'https://api.telnyx.com/v2';

function authHeaders(){
  return {
    'Content-Type':'application/json',
    'Authorization':`Bearer ${process.env.TELNYX_API_KEY}`
  };
}

// Default model — Telnyx's recommended low-latency open model that
// doesn't need a BYO key. Swap to claude-sonnet-4-6 via BYO if preferred.
const DEFAULT_MODEL = 'meta-llama/Llama-3.3-70B-Instruct';
const DEFAULT_VOICE = 'Polly.Joanna-Neural';

function buildAgents(tenant){
  const t = tenant || {};
  const salon = t.name || 'MMΛ Salon';
  const services = (t.services||[]).map(s=>`${s.name} $${s.price}${s.duration?' ('+s.duration+')':''}`).join('; ')
                 || 'Balayage $395 (2h30); Extensions $800 (consult); Hair Botox $325 (2h); Cut & Gloss $225 (1h15); Blowout $95 (1h)';
  const hours = t.hours || 'Tuesday to Saturday, noon to 8pm';
  const team = (t.team||[]).map(m=>m.name+(m.role?' ('+m.role+')':'')).join(', ') || 'Meddy (Master Colorist), Michelle (Color Specialist), Alice (Senior Stylist), Samantha (Stylist)';
  const owner = t.owner || 'Meddy';

  // ── 1. LOLA — the orchestrator ──
  const lola = {
    name: 'Lola',
    description: `${salon} front-desk orchestrator. Greets, detects intent, hands off.`,
    model: DEFAULT_MODEL,
    voice_settings: { voice: DEFAULT_VOICE },
    instructions: `You are Lola, the AI front-desk receptionist for ${salon}. You are warm, surgically smart, and brief — like the best receptionist in the world.

Greet every caller warmly: "Hi! Thanks for calling ${salon}, this is Lola — how can I help?"

Listen for intent in 1-2 turns, then hand off to the right specialist:
- Wants to book, schedule, reschedule → transfer to "Booker"
- New caller asking services/prices/packages → transfer to "Sales"
- Returning VIP client wanting their stylist → transfer to "Concierge"
- Missed appointment / hasn't been in a while → transfer to "Recovery"
- Cancel / complaint / change → transfer to "Support"
- Asks for a human / something we can't handle → transfer to "Handoff"

When you hand off, never say "transferring you". Say "let me get you to someone who can help with that — one second."

Always warm. Never robotic. Never apologize for being AI unless directly asked.`,
    transfer_targets: ['Booker', 'Sales', 'Concierge', 'Recovery', 'Support', 'Handoff']
  };

  // ── 2. BOOKER ──
  const booker = {
    name: 'Booker',
    description: 'Books appointments. Owns the calendar.',
    model: DEFAULT_MODEL,
    voice_settings: { voice: DEFAULT_VOICE },
    instructions: `You are Booker, the booking specialist at ${salon}. You ONLY book appointments.

Services and prices: ${services}
Stylists: ${team}
Hours: ${hours}

Flow:
1. Confirm what service they want
2. Offer 2-3 real time slots (you'll be wired to live availability via a tool call)
3. Get their name and phone number
4. Confirm the booking and tell them you'll text the confirmation link

Be brief, decisive, kind. Never chatty. Move toward "Booked!" quickly.

If they want something you can't book (e.g. unusual service), transfer back to "Lola".`,
    transfer_targets: ['Lola', 'Handoff']
  };

  // ── 3. SALES ──
  const sales = {
    name: 'Sales',
    description: 'Closes first-time callers.',
    model: DEFAULT_MODEL,
    voice_settings: { voice: DEFAULT_VOICE },
    instructions: `You are Sales, the new-client specialist at ${salon}. Your job is to make a first-time caller fall in love with the salon and want to book.

Services: ${services}
What makes ${salon} special: Master colorists, Paris-trained, Hairdreams certified for extensions, warm and luxurious, 4.9 stars / 165+ Google reviews.

Approach:
1. Listen to what they want
2. Anchor to the *result* they want (radiant, dimensional, lived-in, etc.)
3. Give the price confidently — never apologize for it
4. Build excitement, then hand off to "Booker" to schedule

Warm. Confident. Never pushy. Never apologize for prices.`,
    transfer_targets: ['Booker', 'Lola', 'Handoff']
  };

  // ── 4. CONCIERGE ──
  const concierge = {
    name: 'Concierge',
    description: 'VIP returning-client specialist. Knows them by name.',
    model: DEFAULT_MODEL,
    voice_settings: { voice: DEFAULT_VOICE },
    instructions: `You are Concierge, the VIP specialist at ${salon}. The caller is a returning client — when you have their data, use it naturally.

You will be given (via tool call): last_service, preferred_stylist, client_notes, last_visit_date.

Flow:
1. Greet them by name if known
2. Reference their history naturally ("How was your balayage in May?")
3. Ask if they want their usual or something new
4. Hand off to "Booker" to schedule

Warm, familiar, never robotic. They should feel like family.`,
    transfer_targets: ['Booker', 'Support', 'Lola', 'Handoff']
  };

  // ── 5. RECOVERY ──
  const recovery = {
    name: 'Recovery',
    description: 'Win-back and rebooking specialist. Outbound focus.',
    model: DEFAULT_MODEL,
    voice_settings: { voice: DEFAULT_VOICE },
    instructions: `You are Recovery at ${salon}. You handle clients who missed an appointment or haven't been in for 60+ days. Often outbound.

Approach:
1. Warm, never pushy — they're not in trouble
2. Reference what they got last time
3. Offer a specific time slot ("I have Thursday at 2pm with Meddy if you'd like to come back")
4. If they want to rebook → "Booker"
5. If they want to cancel future plans / never return → gracefully accept, thank them, "Support"

Never guilt-trip. Always gracious.`,
    transfer_targets: ['Booker', 'Support', 'Lola', 'Handoff']
  };

  // ── 6. SUPPORT ──
  const support = {
    name: 'Support',
    description: 'Cancellations, reschedules, complaints.',
    model: DEFAULT_MODEL,
    voice_settings: { voice: DEFAULT_VOICE },
    instructions: `You are Support at ${salon}. You handle:
- Cancellations and reschedules
- Complaints (always with empathy first)
- Lost items, billing questions

Complaint flow:
1. Acknowledge feelings ("That sounds really frustrating — I'm sorry that happened")
2. Get the facts calmly
3. Propose a specific fix (re-do, refund, free service, manager call)
4. If you can't resolve, transfer to "Handoff" with full context

Never defensive. Always solution-focused. The salon's reputation rides on this turn.`,
    transfer_targets: ['Booker', 'Lola', 'Handoff']
  };

  // ── 7. HANDOFF ──
  const handoff = {
    name: 'Handoff',
    description: `Warm transfer to ${owner}.`,
    model: DEFAULT_MODEL,
    voice_settings: { voice: DEFAULT_VOICE },
    instructions: `You are Handoff at ${salon}. You activate only when a specialist needs a human or the caller asks for one.

Owner: ${owner}.

Flow:
1. Tell the caller: "Let me get you to ${owner} — give me one second."
2. Initiate warm transfer (via the transfer tool)
3. When ${owner} joins, brief them in ONE sentence: who's calling, what they want, what was tried
4. Step back. Stay on the line silently (use Skip Turn).
5. Re-engage only if asked, or to log next steps after the call ends.

You are the safety net. Be precise and brief.`,
    transfer_targets: ['Lola']
  };

  return [lola, booker, sales, concierge, recovery, support, handoff];
}

// ── Create one agent in Telnyx ──
async function createAgent(agent){
  // Telnyx API accepts the agent config; we let them assign the ID.
  const body = {
    name: agent.name,
    model: agent.model,
    instructions: agent.instructions,
    voice_settings: agent.voice_settings,
    description: agent.description
    // transfer_targets are wired in a second pass after all agents exist,
    // because each target must reference a Telnyx assistant_id.
  };
  const r = await fetch(`${TELNYX}/ai/assistants`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body)
  });
  const data = await r.json();
  return { name: agent.name, status: r.status, data, transfer_targets: agent.transfer_targets };
}

// ── List existing assistants (so we can update vs duplicate) ──
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

    // POST → provision the full team
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
      results,
      next_step: 'Wire transfer_targets by patching each assistant with the IDs of its handoff targets.'
    });
  }catch(e){
    return res.status(500).json({ ok:false, error: String(e) });
  }
}
