/**
 * /api/operator-provision — Create / update the owner-facing "Jarvis" assistant.
 * ════════════════════════════════════════════════════════════════════════
 * This registers a SECOND Telnyx AI Assistant (separate from the public,
 * client-facing Lola). It speaks to the owner/staff and is wired with the
 * privileged tools that POST to /api/operator-tools.
 *
 *   GET  /api/operator-provision            → list assistants
 *   POST /api/operator-provision  { tenant } → create the operator assistant
 *
 * After provisioning, attach the assistant to a TeXML Voice App + a private
 * number (the owner's operator line), or use Telnyx's WebRTC/in-app path for
 * 16 kHz HD audio. See OPERATOR-SETUP.md.
 *
 * ENV: TELNYX_API_KEY, TELNYX_VOICE_ID, APP_URL, OPERATOR_TOOLS_SECRET
 *
 * NOTE ON TOOL SHAPE: Telnyx's AI Assistant "tools" schema evolves; the field
 * names below (type:'webhook' + JSON-schema parameters) follow their webhook-
 * tool model. If a field is rejected, adjust to the current Telnyx reference —
 * the important, stable contract is the webhook itself: POST { tool, ...args }
 * to /api/operator-tools with the x-lola-operator-secret header. You can also
 * add these same tools by hand in the Telnyx portal pointing at that URL.
 */

const TELNYX = 'https://api.telnyx.com/v2';
const DEFAULT_MODEL = 'Qwen/Qwen3-235B-A22B';

function authHeaders(){
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.TELNYX_API_KEY}` };
}
function appUrl(){ return process.env.APP_URL || 'https://www.loladesk.com'; }
function toolsUrl(){ return `${appUrl()}/api/operator-tools`; }

// One webhook tool, in Telnyx's AI Assistant schema: name/description live
// INSIDE the `webhook` object, args are `body_parameters` (JSON Schema). The
// constant tool name + tenant slug ride in the URL query so they're always
// present; the model only fills the args in `props`.
function webhookTool(name, description, props = {}, required = [], slug = ''){
  const url = `${toolsUrl()}?tool=${encodeURIComponent(name)}${slug ? `&tenant=${encodeURIComponent(slug)}` : ''}`;
  return {
    type: 'webhook',
    webhook: {
      name,
      description,
      url,
      method: 'POST',
      headers: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'x-lola-operator-secret', value: process.env.OPERATOR_TOOLS_SECRET || '' }
      ],
      body_parameters: { type: 'object', properties: props, required }
    }
  };
}

function buildTools(tenant){
  const slug = tenant?.slug || '';
  const dateProp = { date: { type: 'string', description: 'Day to read, e.g. "today", "tomorrow", or YYYY-MM-DD.' } };

  return [
    webhookTool('whats_my_day', "Read the appointments on the books for a given day.",
      dateProp, [], slug),

    webhookTool('find_revenue', "Total booked revenue for a period.",
      { range: { type: 'string', enum: ['today', 'week', 'month'], description: 'Period to total.' },
        date: { type: 'string', description: 'A specific day instead of a range (YYYY-MM-DD).' } },
      [], slug),

    webhookTool('who_is_due', "List clients overdue for a rebooking.",
      { since_days: { type: 'integer', description: 'How many days since last visit counts as overdue. Default 42.' } },
      [], slug),

    webhookTool('move_appointment',
      "Reschedule a booking. DESTRUCTIVE: call once to preview, then call again with confirm=true, the confirm_token, and the owner's PIN.",
      { client_name: { type: 'string' }, date: { type: 'string', description: 'Current day of the appointment.' },
        time: { type: 'string', description: 'Current time, e.g. "3pm".' },
        new_date: { type: 'string' }, new_time: { type: 'string', description: 'New time, e.g. "4:30pm".' },
        confirm: { type: 'boolean' }, confirm_token: { type: 'string' }, pin: { type: 'string' } },
      [], slug),

    webhookTool('cancel_appointment',
      "Cancel a booking. DESTRUCTIVE: preview first, then confirm=true + confirm_token + PIN.",
      { client_name: { type: 'string' }, date: { type: 'string' }, time: { type: 'string' },
        confirm: { type: 'boolean' }, confirm_token: { type: 'string' }, pin: { type: 'string' } },
      [], slug),

    webhookTool('broadcast_text',
      "Text a group of clients. DESTRUCTIVE: preview first, then confirm=true + confirm_token + PIN.",
      { segment: { type: 'string', enum: ['all', 'vip', 'due'], description: 'Who to text.' },
        message: { type: 'string', description: 'The exact message to send.' },
        confirm: { type: 'boolean' }, confirm_token: { type: 'string' }, pin: { type: 'string' } },
      ['message'], slug),

    webhookTool('book_for_client', "Add a booking for a client.",
      { client_name: { type: 'string' }, client_phone: { type: 'string' }, service: { type: 'string' },
        date: { type: 'string' }, time: { type: 'string' }, stylist: { type: 'string' } },
      ['service'], slug)
  ];
}

function buildInstructions(tenant){
  const salon = tenant?.name || 'your salon';
  const owner = tenant?.owner_name || 'the owner';
  return `You are Lola in OWNER MODE — the private voice assistant for ${owner}, who owns ${salon}. You are talking to the owner or a trusted staff member, NOT a client. Think of yourself as a sharp, calm chief of staff for the front desk: fast, exact, and never chatty.

WHAT YOU DO
- Read the day's schedule, report booked revenue, and surface clients who are due to rebook.
- Move, cancel, and create appointments.
- Send a text to a group of clients (all, VIPs, or those overdue).
Always use a tool to get real numbers and names. Never guess a figure, a client, or a time — if a tool didn't give it to you, say you'll check.

CONFIRMING CHANGES (critical)
Moving an appointment, cancelling one, and texting clients are DESTRUCTIVE. For these:
1) Call the tool once WITHOUT confirm to preview. It returns a spoken summary and a confirm_token.
2) Read the summary back and ask the owner to say their PIN and the word "confirm".
3) Only then call the SAME tool again with confirm=true, the confirm_token, and the spoken pin.
Never skip the PIN. If the PIN is wrong, do not retry silently — tell them it didn't match. If a request is ambiguous (more than one matching appointment), ask which one before previewing.

STYLE
Concise and direct — you're a tool the owner uses while working, not a conversation. Lead with the answer ("You've got 6 today, $1,840 booked"). No pleasantries, no "happy to help". Confirm what you did in one line.`;
}

async function createAssistant(tenant, model){
  const body = {
    name: `Lola Ops${tenant?.name ? ` — ${tenant.name}` : ''}`,
    model: model || DEFAULT_MODEL,
    instructions: buildInstructions(tenant),
    description: `Owner-facing operator assistant for ${tenant?.name || 'a salon'}.`,
    tools: buildTools(tenant)
  };
  if(process.env.TELNYX_VOICE_ID) body.voice_settings = { voice: process.env.TELNYX_VOICE_ID };

  const r = await fetch(`${TELNYX}/ai/assistants`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
  const data = await r.json();
  return { status: r.status, data };
}

async function listAssistants(){
  const r = await fetch(`${TELNYX}/ai/assistants`, { headers: authHeaders() });
  return r.json();
}

// List the models your account can use — runs server-side so the API key
// never leaves Vercel. GET /api/operator-provision?models=1
async function listModels(){
  const r = await fetch(`${TELNYX}/ai/models`, { headers: authHeaders() });
  return r.json();
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();

  if(!process.env.TELNYX_API_KEY) return res.status(500).json({ error: 'Missing TELNYX_API_KEY' });
  if(!process.env.OPERATOR_TOOLS_SECRET) return res.status(500).json({ error: 'Missing OPERATOR_TOOLS_SECRET' });

  try{
    if(req.method === 'GET'){
      if(req.query && req.query.models){
        return res.status(200).json({ ok: true, models: await listModels() });
      }
      return res.status(200).json({ ok: true, assistants: await listAssistants() });
    }
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const result = await createAssistant(body.tenant || null, body.model);
    return res.status(200).json({ ok: result.status < 300, result });
  }catch(e){
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
