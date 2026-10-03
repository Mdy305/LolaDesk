/**
 * api/lib/assistant-wiring.js — Lola's Telnyx assistant, wired by LolaDesk.
 * ════════════════════════════════════════════════════════════════════
 * Nobody should hand-edit webhook URLs in the Telnyx portal. This reads the
 * LolaBrain assistant and makes sure every tool she calls on the phone points
 * at the LolaDesk endpoint that actually runs it — for EVERY salon, because
 * the salon is resolved from the number that was called:
 *
 *   tool named like a skill (book_appointment, detect_upsell_opportunity…)
 *     → https://www.loladesk.com/api/lola-tools?tool=<name>&to={{telnyx_agent_target}}&from={{telnyx_end_user_target}}&salon={{loladesk_salon}}
 *   dynamic variables (the salon's name, menu, hours on each call)
 *     → https://www.loladesk.com/api/agent-variables
 *
 * A tool pointing at the post-call insights webhook, another domain, or a
 * path LolaDesk doesn't serve is "miswired". heal:true re-points it, keeping
 * everything else about the tool exactly as it was. Tools LolaDesk doesn't
 * know are reported, never touched.
 */
import { telnyxRequest, telnyxData, appUrl } from './telnyx-client.js';
import { greetingDiscloses, discloseGreeting } from './legal.js';
import { telnyxSafeVariables } from './booking-link.js';
import { toolKey, toolKeyOk } from './tool-key.js';


// Appended once to Lola's phone instructions (Florida is all-party consent; TCPA; honesty about being an AI).
export const GREETING_VAR = '{{lola_greeting}}';
export const COMPLIANCE_MARK = '[LolaDesk compliance]';
export const COMPLIANCE_RULES = `\n\n${COMPLIANCE_MARK}\n- Your greeting tells every caller the call may be recorded and that you are an AI assistant. Never skip or contradict it.\n- If anyone asks whether you are a person or a bot, say plainly that you are the salon's AI assistant.\n- If a caller does not want to be recorded, offer to have the salon call them back and log it.\n- Never give medical, legal or financial advice. In an emergency, tell them to hang up and call 911.\n- Only text people about their own appointments or what they asked for; if anyone says STOP, confirm and stop.`;

const SKILL_NAMES = new Set(['check_availability', 'book_appointment', 'confirm_booking', 'reschedule_appointment', 'cancel_appointment',
  'capture_lead', 'recall_client', 'get_pricing', 'recommend_service', 'list_services', 'handle_recovery', 'escalate', 'detect_upsell_opportunity', 'inject_memory', 'take_message']);
// Dedicated endpoints that are also fine for a tool to call directly.
const GOOD_PATHS = new Set(['/api/lola-tools', '/api/lola/book-appointment', '/api/lola/check-availability', '/api/lola/get-context',
  '/api/lola/fill-gap', '/api/lola/voice-fill-gap', '/api/lola/waitlist-candidates']);
const DYNVAR_PATHS = new Set(['/api/agent-variables', '/api/lola/dynamic-variables']);

/** Telnyx documents assistant updates as POST /ai/assistants/{id}; older accounts took PATCH. Try both. */
const errText = (e) => String(e?.message || '') + ' ' + JSON.stringify(e?.details || e?.body || '');
const badVariable = (e) => /dynamic.?variables|must be a boolean, string, or integer/i.test(errText(e));
const dupTools = (e) => /tool.{0,40}(must be unique|not unique)|names must be unique/i.test(errText(e));
const toolName = (t) => norm(t?.webhook?.name || t?.function?.name || t?.name || '');

/**
 * Telnyx refuses ANY update while two tools share a name ("Webhook tools names must be unique").
 * Keep one tool per name: the one already wired to LolaDesk correctly, else one on our host, else the
 * first. Tools without a name (hangup, transfer…) are always kept.
 */
export function dedupeTools(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const rank = (t) => { const d = diagnoseTool(t); const u = parse(t?.webhook?.url); return !d ? 3 : (u && ourHost(u.hostname)) ? 2 : 1; };
  const best = new Map();
  list.forEach((t, i) => { const n = toolName(t); if (!n) return; const cur = best.get(n); if (!cur || rank(t) > rank(list[cur.i])) best.set(n, { i }); });
  const keep = new Set([...best.values()].map((x) => x.i));
  const removed = [];
  const out = list.filter((t, i) => { const n = toolName(t); if (!n || keep.has(i)) return true; removed.push(t?.webhook?.name || t?.function?.name || n); return false; });
  return { tools: out, removed };
}
export async function updateAssistant(id, body, { timeoutMs = 12000 } = {}) {
  const path = '/ai/assistants/' + encodeURIComponent(id);
  if (body && body.dynamic_variables && typeof body.dynamic_variables === 'object') body = { ...body, dynamic_variables: telnyxSafeVariables(body.dynamic_variables) };
  if (body && Array.isArray(body.tools)) body = { ...body, tools: dedupeTools(body.tools).tools };
  const send = async (b) => {
    try { return await telnyxRequest(path, { method: 'POST', body: b, timeoutMs }); }
    catch (e) {
      if (![404, 405].includes(Number(e?.status))) throw e;
      return telnyxRequest(path, { method: 'PATCH', body: b, timeoutMs });
    }
  };
  try { return await send(body); }
  catch (e) {
    // Telnyx re-validates the assistant's STORED defaults on every update: one null (booking_url)
    // blocks every change, even a voice switch. Clean the stored values and send it again once.
    // Same for duplicate tool names: repair BOTH stored problems in the one retry.
    if (!badVariable(e) && !dupTools(e)) throw e;
    const cur = telnyxData(await telnyxRequest(path, { timeoutMs })) || {};
    const dv = telnyxSafeVariables({ ...((cur.dynamic_variables && typeof cur.dynamic_variables === 'object') ? cur.dynamic_variables : {}), ...((body && body.dynamic_variables) || {}) });
    const tools = dedupeTools(Array.isArray(body?.tools) ? body.tools : cur.tools).tools;
    return send({ ...body, dynamic_variables: dv, ...(tools.length ? { tools } : {}) });
  }
}

// ── Which Telnyx assistant IS Lola ──
// The id in Vercel can be stale (assistant re-created), carry a stray space/newline from a paste, or
// lack the "assistant-" prefix. Then every call is silent: nothing answers. resolveAssistant() checks
// the env id with Telnyx and, if Telnyx doesn't know it, finds Lola on the account itself:
// the assistant named Lola/LolaBrain (never the support line), with a phone app, newest first.
const envAssistantId = () => String(process.env.TELNYX_LOLA_BRAIN_ID || process.env.TELNYX_ASSISTANT_ID || '').replace(/\s+/g, '').replace(/^["']|["']$/g, '') || null;
let resolvedA = null, resolvedAt = 0;
export const assistantId = () => (resolvedA && resolvedA.id) || envAssistantId();
export function _resetAssistantCache() { resolvedA = null; resolvedAt = 0; }
export async function resolveAssistant({ force = false } = {}) {
  if (!force && resolvedA && Date.now() - resolvedAt < 10 * 60e3) return resolvedA;
  if (!process.env.TELNYX_API_KEY) return { id: envAssistantId(), source: 'env', ok: false, error: 'no_key' };
  const env = envAssistantId();
  const tries = env ? [...new Set([env, /^assistant-/.test(env) ? null : 'assistant-' + env].filter(Boolean))] : [];
  for (const id of tries) {
    try {
      const a = telnyxData(await telnyxRequest('/ai/assistants/' + encodeURIComponent(id), { timeoutMs: 8000 }));
      if (a && a.id) { resolvedA = { id: a.id, name: a.name || null, source: id === env ? 'env' : 'env_fixed', ok: true, texml_app_id: a.telephony_settings?.default_texml_app_id || null, env_id: env, assistant: a }; resolvedAt = Date.now(); return resolvedA; }
    } catch (e) { if (![400, 404, 422].includes(Number(e?.status))) return { id: env, source: 'env', ok: false, error: String(e?.message || e).slice(0, 140) }; }
  }
  let list = [];
  try { list = telnyxData(await telnyxRequest('/ai/assistants', { query: { 'page[size]': 100 }, timeoutMs: 9000 })) || []; }
  catch (e) { return { id: env, source: 'env', ok: false, error: String(e?.message || e).slice(0, 140) }; }
  list = (Array.isArray(list) ? list : []).filter((a) => a && a.id && !/support|customer care|loladesk care/i.test(String(a.name || '')));
  const score = (a) => (/lola/i.test(a.name || '') ? 4 : 0) + (/brain/i.test(a.name || '') ? 2 : 0) + (a.telephony_settings?.default_texml_app_id ? 2 : 0) + (Array.isArray(a.tools) && a.tools.length ? 1 : 0);
  list.sort((x, y) => score(y) - score(x) || String(y.updated_at || y.created_at || '').localeCompare(String(x.updated_at || x.created_at || '')));
  const a = list[0];
  if (!a) return { id: null, source: 'none', ok: false, env_id: env, error: 'no_assistant_on_account' };
  resolvedA = { id: a.id, name: a.name || null, source: 'discovered', ok: true, texml_app_id: a.telephony_settings?.default_texml_app_id || null, env_id: env, assistant: a };
  resolvedAt = Date.now();
  return resolvedA;
}

const norm = (n) => String(n || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
export function toolUrl(name) {
  // salon={{loladesk_salon}}: on a salon's website widget the call carries the header
  // X-LolaDesk-Salon (Telnyx turns X- headers into dynamic variables), so web calls know the salon too.
  return `${appUrl()}/api/lola-tools?tool=${encodeURIComponent(norm(name))}&to={{telnyx_agent_target}}&from={{telnyx_end_user_target}}&salon={{loladesk_salon}}&call={{call_control_id}}&ch={{telnyx_conversation_channel}}&k=${toolKey()}`;
}
/** Same endpoint, signed: replaces any old k=, keeps every other parameter (incl. {{…}} placeholders). */
function signKeep(url) {
  const raw = String(url || '');
  const [base, q = ''] = raw.split('?');
  const parts = q.split('&').filter((x) => x && !/^k=/.test(x));
  parts.push('k=' + toolKey());
  return base + '?' + parts.join('&');
}
/** The salon-details webhook, signed (caller memory is only shared with a signed request). */
export const variablesUrl = () => `${appUrl()}/api/agent-variables?k=${toolKey('variables')}`;
function parse(u) { try { return new URL(String(u || '').replace(/\{\{[^}]*\}\}/g, 'x')); } catch (_) { return null; } }
function ourHost(h) { const a = parse(appUrl()); return !!a && (h === a.hostname || h.replace(/^www\./, '') === a.hostname.replace(/^www\./, '')); }

/** What's wrong with one webhook tool (null = fine). */
export function diagnoseTool(tool) {
  const w = tool && tool.webhook; if (!w) return null;
  const name = norm(w.name), u = parse(w.url);
  if (!SKILL_NAMES.has(name)) {
    if (!u || !ourHost(u.hostname) || !GOOD_PATHS.has(u.pathname)) return { name: w.name, url: w.url, problem: 'unknown_tool', fixable: false };
    // One of our dedicated /api/lola/* endpoints: keep it, but it must carry the signature.
    if (!toolKeyOk(u.searchParams.get('k'))) return { name: w.name, url: w.url, problem: 'unsigned_keep', fixable: true };
    return null;
  }
  if (!u) return { name: w.name, url: w.url, problem: 'no_url', fixable: true };
  if (!ourHost(u.hostname)) return { name: w.name, url: w.url, problem: 'other_domain', fixable: true };
  if (u.pathname === '/api/lola-tools') {
    const q = u.searchParams;
    if (norm(q.get('tool') || '') !== name && !/"tool"/.test(JSON.stringify(w.body_parameters || {}))) return { name: w.name, url: w.url, problem: 'tool_not_named', fixable: true };
    if (!/telnyx_agent_target/.test(String(w.url)) && !/telnyx_agent_target|"to"/.test(JSON.stringify(w.body_parameters || {}))) return { name: w.name, url: w.url, problem: 'salon_unknown', fixable: true };
    if (!/loladesk_salon/.test(String(w.url))) return { name: w.name, url: w.url, problem: 'web_salon_unknown', fixable: true };
    if (!/call_control_id/.test(String(w.url))) return { name: w.name, url: w.url, problem: 'conversation_unlinked', fixable: true };
    if (!toolKeyOk(q.get('k'))) return { name: w.name, url: w.url, problem: 'unsigned', fixable: true };
    if (w.method && String(w.method).toUpperCase() !== 'POST') return { name: w.name, url: w.url, problem: 'method', fixable: true };
    return null;
  }
  if (GOOD_PATHS.has(u.pathname)) return toolKeyOk(u.searchParams.get('k')) ? null : { name: w.name, url: w.url, problem: 'unsigned_keep', fixable: true };
  return { name: w.name, url: w.url, problem: u.pathname.includes('insights') ? 'insights_url' : 'wrong_path', fixable: true };
}

export async function wireAssistant({ heal = false } = {}) {
  if (!process.env.TELNYX_API_KEY) return { ok: false, error: 'TELNYX_API_KEY is not set' };
  const found = await resolveAssistant();
  const id = found.id;
  if (!id) return { ok: false, error: found.error === 'no_assistant_on_account' ? 'There is no AI assistant on the Telnyx account' : 'TELNYX_LOLA_BRAIN_ID is not set' };
  let a;
  try { a = telnyxData(await telnyxRequest('/ai/assistants/' + encodeURIComponent(id), { timeoutMs: 9000 })); }
  catch (e) { return { ok: false, error: 'Could not read the assistant from Telnyx: ' + String(e?.message || e) }; }
  if (!a || typeof a !== 'object') return { ok: false, error: 'Assistant not found in Telnyx' };
  const allTools = Array.isArray(a.tools) ? a.tools : [];
  const { tools, removed: duplicateTools } = dedupeTools(allTools);
  const issues = [], fixed = [], unknown = [];
  const next = tools.map((t) => {
    const d = diagnoseTool(t);
    if (!d) return t;
    if (!d.fixable) { unknown.push({ name: d.name, url: d.url }); return t; }
    issues.push(d);
    const url = d.problem === 'unsigned_keep' ? signKeep(t.webhook.url) : toolUrl(t.webhook.name);
    fixed.push({ name: t.webhook.name, from: t.webhook.url || null, to: url, problem: d.problem });
    return { ...t, webhook: { ...t.webhook, url, method: 'POST' } };   // /api/lola-tools only answers POST
  });
  const dv = parse(a.dynamic_variables_webhook_url);
  const dynOk = !!dv && ourHost(dv.hostname) && DYNVAR_PATHS.has(dv.pathname) && toolKeyOk(dv.searchParams.get('k'), 'variables');
  // Tools every Lola must have (added once, never duplicated).
  const REQUIRED = [{ name: 'recall_client', description: 'When a caller or website visitor gives their phone number, look them up to greet a returning client by name and remember their last visit.', props: { client_phone: { type: 'string', description: 'The number they gave' } } }];
  const have = new Set(next.map((t) => norm(t?.webhook?.name || t?.function?.name || '')));
  const added = [];
  for (const r of REQUIRED) if (!have.has(r.name)) { next.push({ type: 'webhook', webhook: { name: r.name, description: r.description, url: toolUrl(r.name), method: 'POST', body_parameters: { type: 'object', properties: r.props } } }); added.push(r.name); }
  const patch = {};
  if (fixed.length || added.length || duplicateTools.length) patch.tools = next;
  // Her first words come from the call itself ({{lola_greeting}}: "Hey Sarah, welcome back…" for a
  // returning client), with the recording + AI notice; the default (no webhook answer) discloses too.
  // Telnyx refuses the WHOLE assistant update if any stored default is null/object
  // ("Value for key 'booking_url' must be a boolean, string, or integer") — so sanitize them, and heal them.
  const dvRaw = (a.dynamic_variables && typeof a.dynamic_variables === 'object') ? a.dynamic_variables : {};
  // Empty stored defaults become safe words (used only if the salon-details webhook can't answer in time).
  const SAFE_DEFAULTS = { company_name: 'our salon', business_type: 'salon', caller_known: 'false' };
  const dv0 = telnyxSafeVariables(Object.fromEntries(Object.entries(dvRaw).map(([k, v]) => [k, v == null && SAFE_DEFAULTS[k] ? SAFE_DEFAULTS[k] : v])));
  const dvBroken = Object.keys(dvRaw).filter((k) => JSON.stringify(dvRaw[k]) !== JSON.stringify(dv0[k]));
  if (dvBroken.length) patch.dynamic_variables = { ...dv0 };
  const personal = String(a.greeting || '').trim() === GREETING_VAR;
  const fallbackGreeting = personal ? dv0.lola_greeting : a.greeting;
  const disclosure = { greeting: personal && greetingDiscloses(dv0.lola_greeting), rules: String(a.instructions || '').includes(COMPLIANCE_MARK) };
  if (!disclosure.greeting) {
    patch.greeting = GREETING_VAR;
    patch.dynamic_variables = { ...(patch.dynamic_variables || dv0), lola_greeting: discloseGreeting(greetingDiscloses(fallbackGreeting) ? fallbackGreeting : (fallbackGreeting || '')) };
  }
  if (!disclosure.rules && a.instructions) patch.instructions = String(a.instructions) + COMPLIANCE_RULES;
  if (!dynOk) patch.dynamic_variables_webhook_url = variablesUrl();
  // The salon-details webhook runs ~10 lookups; give it room so callers never get the generic defaults.
  if (!(Number(a.dynamic_variables_webhook_timeout_ms) >= 2500)) patch.dynamic_variables_webhook_timeout_ms = 3000;
  // Salon websites talk to this same Lola through the Telnyx widget (WebRTC anonymous login): Telnyx
  // requires telephony_settings.supports_unauthenticated_web_calls = true. Safe because every tool is
  // signed and changing a booking needs the caller's own verified phone line (see /api/lola-tools).
  const webCalls = a.telephony_settings?.supports_unauthenticated_web_calls === true;
  let webCallsError = null;
  if (!webCalls) patch.telephony_settings = { ...(a.telephony_settings || {}), supports_unauthenticated_web_calls: true };
  // Her ONE voice (the valet-girl Lola from ElevenLabs) on the phone too — see lib/one-voice.js.
  let voice = null;
  try {
    const ov = await import('./one-voice.js');
    const isLola = ov.voiceIsLola(a.voice_settings);
    voice = { current: a.voice_settings?.voice || null, ok: isLola, possible: !!ov.lolaPhoneVoice(), error: null };
    if (!isLola && voice.possible && heal) { try { patch.voice_settings = await ov.lolaVoiceSettings(a.voice_settings); } catch (e) { voice.error = String(e?.message || e); } }
  } catch (_) { voice = null; }
  let healed = false, error = null;
  if (heal && Object.keys(patch).length) {
    // The essentials (signed tools, salon details, greeting, rules) go first and alone, so an optional
    // setting Telnyx might refuse can never block them; each optional setting is then tried on its own.
    const OPTIONAL = ['dynamic_variables_webhook_timeout_ms', 'telephony_settings', 'voice_settings'];
    const core = Object.fromEntries(Object.entries(patch).filter(([k]) => !OPTIONAL.includes(k)));
    const extras = OPTIONAL.filter((k) => k in patch);
    try { if (Object.keys(core).length) await updateAssistant(id, core); healed = true; }
    catch (e) { error = 'Telnyx refused the update: ' + String(e?.message || e); }
    for (const k of extras) {
      try { await updateAssistant(id, { [k]: patch[k] }); healed = healed || !error; }
      catch (e) {
        // telephony_settings: retry with only the one flag (never drop the number routing Telnyx keeps).
        if (k === 'telephony_settings') { try { await updateAssistant(id, { telephony_settings: { default_texml_app_id: a.telephony_settings?.default_texml_app_id, supports_unauthenticated_web_calls: true } }); continue; } catch (_) {} }
        if (k === 'voice_settings' && voice) voice.error = String(e?.message || e);
        else if (k === 'telephony_settings') webCallsError = String(e?.message || e).slice(0, 160);
      }
    }
  }
  return {
    web_calls: webCalls || (healed && !error && !webCallsError),
    web_calls_error: webCallsError,
    ok: (!fixed.length && !added.length && !duplicateTools.length && dynOk && webCalls && disclosure.greeting && (disclosure.rules || !a.instructions) && (!voice || voice.ok || !voice.possible)) || (healed && !error && !voice?.error),
    voice: voice ? { current: voice.current, ok: voice.ok || (healed && !!patch.voice_settings), set_to: healed && patch.voice_settings ? patch.voice_settings.voice : null, error: voice.error } : null,
    assistant: { id, name: a.name || null, tools: tools.length },
    miswired: fixed, added_tools: added, unknown_tools: unknown, duplicate_tools: duplicateTools,
    disclosure: { ok: disclosure.greeting && (disclosure.rules || !a.instructions), greeting_set_to: patch.greeting ? patch.dynamic_variables.lola_greeting : null, rules_added: !!patch.instructions },
    dynamic_variables: { ok: dynOk && !dvBroken.length, url: a.dynamic_variables_webhook_url || null, set_to: dynOk ? null : patch.dynamic_variables_webhook_url, fixed_values: dvBroken },
    healed, error,
  };
}
