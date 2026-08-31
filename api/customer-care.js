/**
 * /api/customer-care — LolaDesk's OWN customer-service line.
 * ═══════════════════════════════════════════════════════════════════════
 * Every salon gets Lola for its front desk. This is Lola for LolaDesk
 * itself: a caller dials the company number and Lola answers with app
 * knowledge — onboarding, plans, billing, troubleshooting — instead of a
 * salon's services. Provisioning is platform-level (one assistant, one
 * number for the whole company), admin-gated like the other operator tools.
 *
 *   GET  /api/customer-care   → current provisioning state (never secrets)
 *   POST /api/customer-care   → create/reuse the customer-care assistant and
 *                               attach one of the owner's owned numbers
 *     { phone_number?: '+1…' }  — optional; defaults to the first owned
 *                                 number NOT already tracked to a salon.
 *
 * Idempotent: the assistant is found by name and reused; the number +
 * assistant pair is persisted in platform_settings so a redeploy or a
 * second call never duplicates. The Telnyx key never leaves the server.
 */
import { bearer, getUserFromToken } from './lib/auth.js';
import { db } from './lib/db.js';

const TELNYX = 'https://api.telnyx.com/v2';
const SETTING_KEY = 'customer_care';
const ASSISTANT_NAME = 'LolaDesk Customer Care';

function isAdmin(email){
  const list = String(process.env.ADMIN_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return !!email && list.includes(String(email).toLowerCase());
}
function authHeaders(){
  return {
    'Content-Type':'application/json',
    'Authorization':`Bearer ${process.env.TELNYX_API_KEY}`
  };
}
function normalizedName(v){ return String(v||'').toLowerCase().replace(/[^a-z0-9]/g,''); }

const DEFAULT_MODEL = 'meta-llama/Llama-3.3-70B-Instruct';

// LolaDesk's company-support persona — helps CALLERS of the app, not a salon.
function buildCareAgent(){
  return {
    name: ASSISTANT_NAME,
    description: 'LolaDesk customer care — helps callers with the LolaDesk app: getting started, onboarding, plans, billing, and support.',
    model: DEFAULT_MODEL,
    voice_settings: { voice: process.env.ELEVENLABS_VOICE_ID || process.env.TELNYX_VOICE_ID || '' },
    instructions: `You are Lola, the customer-care voice assistant for LolaDesk — the AI receptionist platform for salons and med spas. You are talking to a LolaDesk customer, a prospect, or someone calling about the company. You are NOT a salon's front desk — you help people with the LolaDesk APP itself.

WHAT YOU KNOW ABOUT THE PRODUCT:
- LolaDesk is the AI front desk: Lola answers every call, books appointments, sends SMS confirmations and reminders, recovers missed calls, and follows up with leads — 24/7.
- Getting started: sign up at loladesk.com, add the salon's services and hours in Settings, connect a number, and Lola is live.
- Plans: Solo, Salon, and Chain tiers (see loladesk.com/pricing). Billing is handled through the dashboard.
- Common fixes: a number not ringing usually means it isn't attached to the voice app yet (Settings → Numbers); SMS not sending usually means the messaging profile or opt-out flag; a salon that isn't bookable is missing services or staff in Settings.

HOW TO HELP:
- Greet warmly and identify whether they are a current customer, a prospect, or a partner.
- Answer app questions directly and specifically. Never invent features, prices, or account details you don't have.
- If they report an issue you can't fix on the phone, take their name, salon, and a callback number and say you'll flag the team — then keep it short.
- Never reveal internal credentials, API keys, or technical implementation details.

RESPONSE STYLE: concise, warm, confident. Short sentences, no corporate filler, no "Great question!". You are the front line of a premium SaaS company — act like it.`,
    transfer_targets: []
  };
}

async function telnyxJson(path, { method = 'GET', body } = {}){
  const r = await fetch(`${TELNYX}${path}`, {
    method,
    headers: authHeaders(),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  let data = null;
  try{ data = await r.json(); }catch{}
  if(!r.ok) throw new Error(`Telnyx ${method} ${path} → ${r.status}: ${String(data?.error?.message || data?.error || '').slice(0,140)}`);
  return data;
}

async function listAssistants(){
  const j = await telnyxJson('/ai/assistants');
  const list = Array.isArray(j?.data) ? j.data : (Array.isArray(j) ? j : []);
  return list;
}
function findCare(list){
  return list.find(a => ['loladeskcustomercare','customercare','loladesksupport','loladesk'].includes(normalizedName(a.name)))
    || null;
}
async function createCareAssistant(){
  const j = await telnyxJson('/ai/assistants', { method:'POST', body: buildCareAgent() });
  return j?.data || j;
}

async function listOwnedNumbers(){
  const j = await telnyxJson('/phone_numbers?page[size]=100');
  return Array.isArray(j?.data) ? j.data : [];
}

async function attachVoice(pnId, texmlAppId){
  return telnyxJson(`/phone_numbers/${pnId}/voice`, {
    method:'PATCH', body: { connection_id: texmlAppId }
  });
}
async function attachMessaging(pnId){
  const profile = process.env.TELNYX_MESSAGING_PROFILE;
  if(!profile) return { skipped:true, reason:'TELNYX_MESSAGING_PROFILE not set' };
  return telnyxJson(`/phone_numbers/${pnId}/messaging`, {
    method:'PATCH', body: { messaging_profile_id: profile }
  });
}

async function getSetting(c){
  try{
    const { data } = await c.from('platform_settings').select('value').eq('key', SETTING_KEY).maybeSingle();
    return data?.value || null;
  }catch{ return null; }
}
async function setSetting(c, value){
  const { error } = await c.from('platform_settings')
    .upsert({ key: SETTING_KEY, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if(error) throw new Error(`persist failed (run 20260901_customer_care migration): ${String(error.message || error).slice(0,160)}`);
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.setHeader('Cache-Control','no-store');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method not allowed' });

  const user = await getUserFromToken(bearer(req));
  if(!user) return res.status(401).json({ ok:false, error:'Not signed in' });
  if(!isAdmin(user.email)) return res.status(403).json({ ok:false, error:'Not authorized' });

  const c = db();
  if(!c) return res.status(503).json({ ok:false, error:'Database not configured' });

  // ── GET: current state (no Telnyx calls, never secrets) ──────────────
  if(req.method === 'GET'){
    const saved = await getSetting(c);
    const hasKey = Boolean(process.env.TELNYX_API_KEY);
    return res.json({
      ok:true,
      configured: !!(hasKey && saved?.number && saved?.assistant_id),
      assistant: saved?.assistant_id ? { id:saved.assistant_id, name:saved.assistant_name || ASSISTANT_NAME } : null,
      number: saved?.number || null,
      texml_app_id: saved?.texml_app_id || null,
      note: hasKey ? 'POST /api/customer-care to provision (or re-provision) the line.' : 'TELNYX_API_KEY is missing.'
    });
  }

  // ── POST: provision / re-provision ────────────────────────────────────
  if(!process.env.TELNYX_API_KEY) return res.status(500).json({ ok:false, error:'Missing TELNYX_API_KEY' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});
  const requested = body.phone_number ? String(body.phone_number) : null;

  try{
    // 1. Assistant — reuse by name, create only when absent.
    const assistants = await listAssistants();
    let care = findCare(assistants);
    let created = false;
    if(!care){ care = await createCareAssistant(); created = true; }
    const assistantId = care?.id || care?.assistant?.id || null;
    const texmlAppId = care?.telephony_settings?.default_texml_app_id
      || care?.telephony_settings?.texml_app_id || null;
    if(!assistantId) throw new Error('Telnyx did not return an assistant id');
    if(!texmlAppId) throw new Error('The customer-care assistant has no TeXML voice app — enable one in the Telnyx portal for this assistant');

    // 2. Number — requested, else first owned number not tracked to a salon.
    const owned = await listOwnedNumbers();
    if(!owned.length) return res.status(400).json({ ok:false, error:'No owned Telnyx numbers to attach' });
    let tracked = [];
    try{
      const { data } = await c.from('tenant_numbers').select('phone_number').limit(200);
      tracked = data || [];
    }catch{ tracked = []; }
    const trackedSet = new Set(tracked.map(r => String(r?.phone_number||'')));
    let pick = owned.find(n => String(n.phone_number) === requested)
      || (!requested ? owned.find(n => !trackedSet.has(String(n.phone_number))) : null);
    if(requested && !pick) return res.status(400).json({ ok:false, error:`${requested} is not an owned Telnyx number` });
    if(!pick) return res.status(400).json({ ok:false, error:'All owned numbers are already tracked to salons — no free line to attach' });

    // 3. Attach voice (+ messaging profile when configured).
    const voice = await attachVoice(pick.id, texmlAppId);
    const messaging = await attachMessaging(pick.id);

    // 4. Persist the pair so it survives redeploys and is idempotent.
    await setSetting(c, {
      assistant_id: assistantId,
      assistant_name: ASSISTANT_NAME,
      number: pick.phone_number,
      texml_app_id: texmlAppId,
      provisioned_at: new Date().toISOString()
    });

    return res.status(200).json({
      ok:true,
      created_assistant: created,
      assistant: { id: assistantId, name: ASSISTANT_NAME },
      number: pick.phone_number,
      texml_app_id: texmlAppId,
      attached: { voice: voice?.ok !== false, messaging: messaging?.ok !== false || messaging?.skipped }
    });
  }catch(e){
    console.error('[CUSTOMER-CARE]', String(e?.message || e).slice(0, 200));
    return res.status(500).json({ ok:false, error:String(e?.message || e).slice(0, 220) });
  }
}