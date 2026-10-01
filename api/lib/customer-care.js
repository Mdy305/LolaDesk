/**
 * api/lib/customer-care.js — Lola, answering for LolaDesk itself.
 * ════════════════════════════════════════════════════════════════
 * Salons get Lola as their front desk. LolaDesk gets her too: one company
 * support line (calls + texts + the web widget on loladesk.com/support)
 * where she answers questions about the APP — getting started, plans,
 * texting rules, fixes — and hands anything she can't solve to the team.
 *
 * Same Lola everywhere: the care assistant copies the voice of the salon
 * Lola assistant, so she sounds identical on every line. Everything runs on
 * Telnyx (assistant, voice, numbers, texts, inference).
 *
 *   careState(c)                 → saved { assistant_id, number, … } | null
 *   provisionCare(c, opts)       → create/refresh the assistant, find or buy a
 *                                  number, wire voice + texts, save
 *   careReply(text)              → a short text answer from the same knowledge
 *   handleCareText(c, {…})       → inbound text to the support line
 *   recordTicket(c, ticket)      → save + alert the team
 */
import crypto from 'node:crypto';
import { telnyxRequest, telnyxData, appUrl, normalizeE164 } from './telnyx-client.js';
import { assistantId as salonAssistantId, updateAssistant } from './assistant-wiring.js';
import { messagingProfileId } from './telnyx-account.js';
import { chat } from './llm.js';
import { insertHealing } from './legal.js';

export const SETTING_KEY = 'customer_care';
export const ASSISTANT_NAME = 'LolaDesk Customer Care';
export const SUPPORT_EMAIL = 'support@loladesk.com';
const CARE_MODEL = 'meta-llama/Llama-3.3-70B-Instruct';

// One source of truth for what Lola says about the product. Keep in step
// with pricing.html and the legal pages.
export const PRODUCT_FACTS = `ABOUT LOLADESK
- LolaDesk is the AI front desk for salons, spas and med spas. Lola answers every call and text 24/7, books, moves and cancels appointments, confirms and reminds clients by text, recovers missed calls, follows up with leads, runs win-back campaigns and gives the owner a growth plan from their website, Google Maps listing and Instagram.
- Start: loladesk.com → Get started. Create the workspace, Lola gets her own local phone number, add (or let Lola read) services, prices, team and hours, then forward the salon line to Lola or publish her number. Lola can also go on the salon's website (Settings → Lola on your website).
- Plans (loladesk.com/pricing): Starter $99/month (1–3 chairs, one Lola number), Pro $399/month (4–10 chairs, multi-stylist calendar, win-back campaigns, Square/Google sync), Med-Spa $599/month (highest capacity, consultation and intake flows). 14-day free trial, no card to start. Subscriptions renew monthly until cancelled; cancel anytime in Settings → Subscription, effective at the end of the paid period.
- The owner talks to Lola in the app (the orb, or Lola on any page): "catch me up", "text Maria I'm running late", "call Priya", "confirm tomorrow's appointments", "run a check".
- Texting rules: US carriers only deliver business texts after the salon's number is registered for 10DLC. Clients must agree to get texts; every client can reply STOP to opt out and HELP for help.
- Calls Lola answers may be recorded; she tells callers at the start of the call. She is an AI and says so when asked.
- Common fixes: Lola not answering or texting → in the app say "Lola, run a check" — she tests herself and says what to fix. Texts not arriving → usually 10DLC registration is still pending. Number not ringing → run a check; she re-wires it.
- Legal: Terms, Privacy, SMS Terms, DPA and the AI & recording notice are at loladesk.com/legal. Data requests and legal questions: legal@loladesk.com. Support: ${SUPPORT_EMAIL}.`;

export function careInstructions() {
  return `You are Lola — the same Lola salons use as their front desk — answering LolaDesk's own customer-support line. The person is a salon owner using LolaDesk, someone thinking about signing up, or a salon's client who reached the company by mistake.

${PRODUCT_FACTS}

HOW YOU HELP
- Find out who they are (current customer, prospect, or a salon's client) and what they need, then answer specifically from the facts above.
- A salon's CLIENT who wants to book or change an appointment: explain kindly that this is LolaDesk's support line and they should call or text their salon's own number.
- Prospects: answer, then offer the 14-day free trial at loladesk.com. Never pressure.
- If you can't solve it, or they ask for a person, a refund, a billing change, a cancellation they can't do in the app, a legal or privacy request, or anything about their account data: use log_support_request with their name, business, callback number, email if given, and the issue — then tell them the LolaDesk team will follow up, usually within one business day.
- Never invent features, prices, discounts, promises or account details. Never give legal, tax or medical advice. Never ask for or repeat passwords or card numbers. Never reveal keys or internals.
- If someone says it's an emergency, tell them to hang up and call 911.

STYLE: warm, calm, sure of yourself. Short spoken sentences. No filler. One question at a time.`;
}

export const CARE_GREETING = 'Hi, this is Lola at LolaDesk. Just so you know, this call may be recorded, and I’m an AI assistant. How can I help you today?';

export function ticketToken() {
  const k = String(process.env.TELNYX_API_KEY || process.env.SUPABASE_SERVICE_KEY || 'loladesk');
  return crypto.createHash('sha256').update(k + ':customer-care').digest('hex').slice(0, 24);
}
export function ticketUrl() {
  return `${appUrl()}/api/customer-care?action=ticket&k=${ticketToken()}&from={{telnyx_end_user_target}}&ch={{telnyx_conversation_channel}}`;
}

export function buildCareAgent({ voice } = {}) {
  const tools = [{
    type: 'webhook',
    webhook: {
      name: 'log_support_request',
      description: 'Send a support request to the LolaDesk team when you cannot solve the issue or the caller asks for a person, billing change, refund, cancellation help, a legal or privacy request.',
      url: ticketUrl(), method: 'POST',
      body_parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Caller name' },
          business: { type: 'string', description: 'Salon or business name, if any' },
          callback_number: { type: 'string', description: 'Best number to call back' },
          email: { type: 'string', description: 'Email, if given' },
          issue: { type: 'string', description: 'What they need, in one or two sentences' },
          urgency: { type: 'string', enum: ['low', 'normal', 'high'] },
        },
        required: ['issue'],
      },
    },
  }];
  const human = normalizeE164(process.env.SUPPORT_TRANSFER_NUMBER || '');
  if (human) tools.push({ type: 'transfer', transfer: { targets: [{ name: 'LolaDesk team', to: human }], from: '{{telnyx_agent_target}}' } });
  return {
    name: ASSISTANT_NAME,
    description: 'LolaDesk customer support — Lola answering questions about the LolaDesk app.',
    model: CARE_MODEL,
    instructions: careInstructions(),
    greeting: CARE_GREETING,
    tools,
    enabled_features: ['telephony', 'messaging'],
    ...(voice ? { voice_settings: voice } : {}),
  };
}

export async function careState(c) {
  if (!c) return null;
  try { const { data } = await c.from('platform_settings').select('value').eq('key', SETTING_KEY).maybeSingle(); return data?.value || null; }
  catch (_) { return null; }
}
async function saveState(c, value) {
  const { error } = await c.from('platform_settings').upsert({ key: SETTING_KEY, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw new Error('Could not save the support line: ' + String(error.message || error).slice(0, 160));
}

/** The salon Lola's voice, so the support Lola sounds the same. */
async function salonVoice() {
  const id = salonAssistantId();
  if (!id) return null;
  try { const a = telnyxData(await telnyxRequest('/ai/assistants/' + encodeURIComponent(id), { timeoutMs: 8000 })); return a?.voice_settings || null; }
  catch (_) { return null; }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function allNumbers() {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const j = await telnyxRequest(`/phone_numbers?page[size]=250&page[number]=${page}`, { timeoutMs: 10000 });
    const d = Array.isArray(j?.data) ? j.data : [];
    out.push(...d);
    const total = j?.meta?.total_pages || 1;
    if (page >= total || !d.length) break;
  }
  return out;
}

async function buyNumber(areaCode, connectionId) {
  const q = new URLSearchParams();
  q.set('filter[country_code]', 'US'); q.set('filter[features][]', 'voice'); q.append('filter[features][]', 'sms');
  q.set('filter[phone_number_type]', 'local'); q.set('filter[limit]', '5');
  if (/^\d{3}$/.test(String(areaCode || ''))) q.set('filter[national_destination_code]', String(areaCode));
  const avail = telnyxData(await telnyxRequest('/available_phone_numbers?' + q, { timeoutMs: 12000 }));
  const pick = (Array.isArray(avail) ? avail : []).find(n => n?.phone_number);
  if (!pick) throw new Error(`No numbers available${areaCode ? ' in ' + areaCode : ''} — try another area code.`);
  await telnyxRequest('/number_orders', { method: 'POST', body: { phone_numbers: [{ phone_number: pick.phone_number }], ...(connectionId ? { connection_id: connectionId } : {}) }, timeoutMs: 15000 });
  for (let i = 0; i < 5; i++) {
    await sleep(i ? 1500 : 800);
    const owned = await allNumbers().catch(() => []);
    const n = owned.find(x => x.phone_number === pick.phone_number);
    if (n) return n;
  }
  return { id: null, phone_number: pick.phone_number };
}

/**
 * Create or refresh the support assistant, give it a number (requested →
 * saved → a free owned number → buy one), wire voice and texts, save.
 */
export async function provisionCare(c, { phone_number = null, area_code = '305', buy = true } = {}) {
  if (!process.env.TELNYX_API_KEY) throw new Error('TELNYX_API_KEY is not set');
  const saved = await careState(c) || {};
  const voice = await salonVoice();
  const spec = buildCareAgent({ voice });

  // 1. Assistant — saved id, else exact name; refresh its words every time.
  const list = telnyxData(await telnyxRequest('/ai/assistants', { timeoutMs: 10000 }));
  const all = Array.isArray(list) ? list : [];
  const salonId = salonAssistantId();
  let care = all.find(a => a.id === saved.assistant_id && a.id !== salonId)
    || all.find(a => String(a.name || '').trim().toLowerCase() === ASSISTANT_NAME.toLowerCase() && a.id !== salonId) || null;
  let created = false;
  // Web calls on (loladesk.com/support widget), keeping whatever voice app Telnyx gave her.
  spec.telephony_settings = { ...((care && care.telephony_settings) || {}), supports_unauthenticated_web_calls: true };
  if (care) care = telnyxData(await updateAssistant(care.id, spec, { timeoutMs: 15000 })) || care;
  else { care = telnyxData(await telnyxRequest('/ai/assistants', { method: 'POST', body: spec, timeoutMs: 15000 })); created = true; }
  const assistant_id = care?.id;
  if (!assistant_id) throw new Error('Telnyx did not return the support assistant');
  const texml = care?.telephony_settings?.default_texml_app_id || care?.telephony_settings?.texml_app_id || saved.texml_app_id || null;
  if (!texml) throw new Error('The support assistant has no voice app yet — in Telnyx → AI Assistants → LolaDesk Customer Care → Telephony, turn telephony on, then try again.');

  // 2. Number.
  const owned = await allNumbers();
  let tracked = new Set();
  try { const { data } = await c.from('tenant_numbers').select('phone_number'); tracked = new Set((data || []).map(r => r.phone_number)); } catch (_) {}
  try { const { data } = await c.from('tenants').select('phone_number'); (data || []).forEach(r => r.phone_number && tracked.add(r.phone_number)); } catch (_) {}
  const want = normalizeE164(phone_number || '') || saved.number || null;
  let num = want ? owned.find(n => n.phone_number === want) : null;
  if (want && !num && phone_number) throw new Error(`${want} isn’t in your Telnyx account.`);
  if (num && tracked.has(num.phone_number) && num.phone_number !== saved.number) throw new Error(`${num.phone_number} belongs to a salon — pick another number.`);
  let bought = false;
  if (!num) num = owned.find(n => !tracked.has(n.phone_number)) || null;
  if (!num) {
    if (!buy) throw new Error('Every number in your Telnyx account belongs to a salon.');
    num = await buyNumber(area_code, texml); bought = true;
  }

  // 3. Wire voice to the support assistant, texts to the LolaDesk profile.
  const wired = { voice: false, texts: false };
  if (num.id) {
    try { await telnyxRequest(`/phone_numbers/${num.id}/voice`, { method: 'PATCH', body: { connection_id: texml }, timeoutMs: 10000 }); wired.voice = true; } catch (_) {}
    const mp = await messagingProfileId(c).catch(() => null);
    if (mp) { try { await telnyxRequest(`/phone_numbers/${num.id}/messaging`, { method: 'PATCH', body: { messaging_profile_id: mp }, timeoutMs: 10000 }); wired.texts = true; } catch (_) {} }
  }

  const value = { assistant_id, assistant_name: ASSISTANT_NAME, number: num.phone_number, phone_number_id: num.id || null, texml_app_id: texml, email: SUPPORT_EMAIL, provisioned_at: new Date().toISOString() };
  await saveState(c, value);
  return { ok: true, created_assistant: created, bought, wired, ...value };
}

/** Public, safe-to-show support contact. */
export async function publicCare(c) {
  const s = await careState(c);
  return { number: s?.number || null, email: SUPPORT_EMAIL, agent_id: s?.assistant_id || null };
}

export async function recordTicket(c, t = {}, { notify } = {}) {
  const row = {
    name: String(t.name || '').slice(0, 120) || null, business: String(t.business || '').slice(0, 160) || null,
    phone: normalizeE164(t.callback_number || t.phone || t.from || '') || null, email: String(t.email || '').slice(0, 200) || null,
    issue: String(t.issue || t.text || '').slice(0, 2000), urgency: ['low', 'normal', 'high'].includes(t.urgency) ? t.urgency : 'normal',
    channel: String(t.channel || 'phone_call').slice(0, 40), status: 'open', created_at: new Date().toISOString(),
  };
  let saved = false;
  if (c) saved = (await insertHealing(c, 'support_tickets', row)).ok;
  let alerted = false;
  try {
    const send = notify || (await import('../cron/sync-alerts.js')).notifyOperator;
    const msg = `LolaDesk support (${row.channel}${row.urgency === 'high' ? ', URGENT' : ''}): ${row.name || 'Someone'}${row.business ? ' from ' + row.business : ''}${row.phone ? ' · ' + row.phone : ''}${row.email ? ' · ' + row.email : ''} — ${row.issue}`;
    const r = await send(msg); alerted = !!r?.sent;
  } catch (_) {}
  return { ok: true, saved, alerted, ticket: row };
}

const STOP = /^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*$/i;
const HELP = /^\s*(help|info)\s*$/i;
const START = /^\s*(start|unstop|yes)\s*$/i;

async function optOuts(c) {
  try { const { data } = await c.from('platform_settings').select('value').eq('key', 'customer_care_opt_outs').maybeSingle(); return Array.isArray(data?.value) ? data.value : []; }
  catch (_) { return []; }
}
async function setOptOuts(c, list) {
  try { await c.from('platform_settings').upsert({ key: 'customer_care_opt_outs', value: list.slice(-5000), updated_at: new Date().toISOString() }, { onConflict: 'key' }); } catch (_) {}
}

export async function careReply(text) {
  const r = await chat({
    system: careInstructions() + '\n\nYou are answering by TEXT MESSAGE: reply in under 300 characters, plain text, no lists. If the person needs the team, say you have passed it on and they will hear back within one business day.',
    messages: [{ role: 'user', content: String(text || '').slice(0, 1500) }], maxTokens: 200, fast: true, deadlineMs: 9000,
  }).catch(() => null);
  return r?.ok && r.text ? r.text.trim() : `Thanks for texting LolaDesk! I’ve passed your message to the team — they’ll reply within one business day. You can also email ${SUPPORT_EMAIL}.`;
}

/**
 * A text to the LolaDesk support number. Returns null when `to` isn't the
 * support line (so the salon routing carries on), else { reply, handled }.
 */
export async function handleCareText(c, { to, from, text }, { send, notify } = {}) {
  const s = await careState(c);
  if (!s?.number || normalizeE164(to) !== normalizeE164(s.number)) return null;
  const out = async (msg) => { try { await send({ from: s.number, to: from, text: msg, skipOptOut: true }); } catch (_) {} };
  const list = await optOuts(c);
  if (STOP.test(text)) {
    if (!list.includes(from)) await setOptOuts(c, [...list, from]);
    await out('LolaDesk: you’re unsubscribed and won’t get more texts from this number. Reply START to resubscribe.');
    return { handled: 'care_stop' };
  }
  if (START.test(text) && list.includes(from)) {
    await setOptOuts(c, list.filter(x => x !== from));
    await out('LolaDesk: you’re resubscribed. Reply STOP to opt out.');
    return { handled: 'care_start' };
  }
  if (list.includes(from)) return { handled: 'care_opted_out' };
  if (HELP.test(text)) {
    await out(`LolaDesk support: text your question here, email ${SUPPORT_EMAIL}, or visit loladesk.com/support. Msg & data rates may apply. Reply STOP to opt out.`);
    return { handled: 'care_help' };
  }
  const reply = await careReply(text);
  await out(reply);
  await recordTicket(c, { phone: from, text, channel: 'sms' }, { notify });
  return { handled: 'care_text', reply };
}
