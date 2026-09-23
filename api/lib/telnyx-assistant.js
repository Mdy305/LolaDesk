// Telnyx number + AI Assistant provisioning.
// Docs: https://developers.telnyx.com/api/numbers-and-number-orders
//       https://developers.telnyx.com/api/ai-assistants
const TELNYX_API = 'https://api.telnyx.com/v2';

function key() {
  const k = process.env.TELNYX_API_KEY;
  if (!k) throw new Error('TELNYX_API_KEY missing');
  return k;
}

async function tx(path, opts = {}) {
  const r = await fetch(TELNYX_API + path, {
    ...opts,
    headers: {
      'Authorization': 'Bearer ' + key(),
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j?.errors?.[0]?.detail || j?.errors?.[0]?.title || r.statusText;
    throw new Error(`Telnyx ${path} — ${r.status}: ${msg}`);
  }
  return j.data ?? j;
}

// ── Numbers ──────────────────────────────────────────────────

export async function searchNumbers({ area_code, limit = 8 }) {
  const p = new URLSearchParams({
    'filter[country_code]': 'US',
    'filter[phone_number_type]': 'local',
    'filter[limit]': String(limit),
    'filter[features]': 'sms,voice,mms'
  });
  if (area_code) p.set('filter[national_destination_code]', area_code);
  const data = await tx('/available_phone_numbers?' + p.toString());
  return (data || []).map(n => ({
    phone_number: n.phone_number,
    region: n.region_information?.[0]?.region_name || null,
    rate_center: n.region_information?.[0]?.rate_center || null,
    monthly_cost: n.cost_information?.monthly_cost || null,
    upfront_cost: n.cost_information?.upfront_cost || null
  }));
}

export async function orderNumber({ phone_number }) {
  const order = await tx('/number_orders', {
    method: 'POST',
    body: JSON.stringify({ phone_numbers: [{ phone_number }] })
  });
  return order;
}

// Fetch the newly-provisioned number record (needed to know its id).
export async function findPhoneNumberRecord({ phone_number }) {
  const p = new URLSearchParams({ 'filter[phone_number]': phone_number });
  const rows = await tx('/phone_numbers?' + p.toString());
  return Array.isArray(rows) ? rows[0] : rows;
}

// ── AI Assistants ────────────────────────────────────────────

const DEFAULT_VOICE = 'Telnyx.KokoroTTS.af_heart';

// Build the system prompt Lola uses per tenant.
function buildInstructions({ tenant, business_profile }) {
  const bp = business_profile || {};
  const services = (bp.services || []).map(s =>
    `- ${s.name}${s.price ? ` — $${s.price}` : ''}${s.duration_min ? ` (${s.duration_min} min)` : ''}`
  ).join('\n') || '(none listed yet)';
  const hours = bp.hours ? JSON.stringify(bp.hours) : '(not set)';
  const staff = (bp.staff || []).map(s => `- ${s.name}${s.role ? ` (${s.role})` : ''}`).join('\n') || '(owner only)';

  return `You are Lola — the front-desk AI for ${tenant.name || 'the salon'}.
You answer the phone, book appointments, answer questions, and text confirmations.
Speak warmly, briefly, and like a real person. Never sound scripted.

BUSINESS
- Name: ${tenant.name || 'the salon'}
- Timezone: ${tenant.timezone || 'America/New_York'}

SERVICES
${services}

HOURS
${hours}

STAFF
${staff}

BOOKING RULES
- Confirm the client's name, phone, service, and preferred time in that order.
- Offer the next 3 open slots when they give a rough time ("tomorrow afternoon").
- Deposits are handled by our system — never quote fees Lola isn't sure of; instead say "I'll text you the deposit link right after this call."
- If unsure, always offer to have a human call back — never invent a fact.

STYLE
- Two sentences at a time, max.
- If a client is upset, acknowledge before solving.
- Never mention that you are an AI unless directly asked.

END OF CALL
- Thank them by name.
- Confirm the exact date/time you booked.
- Say the confirmation will arrive by text in a moment.`;
}

export async function createAssistant({ tenant, business_profile, voice_id, greeting }) {
  const instructions = buildInstructions({ tenant, business_profile });
  const body = {
    name: `Lola — ${tenant.name || 'salon'}`,
    model: 'meta-llama/Meta-Llama-3.1-70B-Instruct',
    instructions,
    voice_settings: {
      voice: voice_id || DEFAULT_VOICE
    },
    greeting: greeting || `Hi, thank you for calling ${tenant.name || 'us'}. This is Lola — how can I help?`,
    transcription: { model: 'distil-whisper/distil-large-v2' }
  };
  const data = await tx('/ai/assistants', {
    method: 'POST',
    body: JSON.stringify(body)
  });
  return data;
}

export async function updateAssistant({ assistant_id, tenant, business_profile, voice_id, greeting }) {
  const instructions = buildInstructions({ tenant, business_profile });
  const body = { instructions };
  if (voice_id) body.voice_settings = { voice: voice_id };
  if (greeting) body.greeting = greeting;
  return tx(`/ai/assistants/${assistant_id}`, {
    method: 'PATCH',
    body: JSON.stringify(body)
  });
}

// Attach the Telnyx AI Assistant as the voice application on the number.
// This is what makes an inbound call automatically route to Lola.
export async function linkNumberToAssistant({ phone_number_id, assistant_id }) {
  return tx(`/phone_numbers/${phone_number_id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      voice: {
        connection_id: null,
        translated_number: null,
        call_forwarding: { enabled: false },
        caller_id_name_enabled: 'inbound',
        cnam_listing_enabled: false,
        // Voice application via AI Assistant
        media_features: { rtp_auto_adjust_enabled: true },
        usage_payment_method: 'pay-per-minute'
      },
      messaging: {
        messaging_profile_id: process.env.TELNYX_MESSAGING_PROFILE_ID || null
      }
    })
  }).then(async () => {
    // Then attach the AI Assistant via the assistant application endpoint.
    return tx(`/ai/assistants/${assistant_id}/phone_numbers`, {
      method: 'POST',
      body: JSON.stringify({ phone_number_id })
    });
  });
}

// Outbound call — used by the "test call" step and by the widget flow.
export async function callFromAssistant({ assistant_id, to, from }) {
  return tx(`/ai/assistants/${assistant_id}/calls`, {
    method: 'POST',
    body: JSON.stringify({ to, from, connection_id: null })
  });
}
