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

const SKILL_NAMES = new Set(['check_availability', 'book_appointment', 'confirm_booking', 'reschedule_appointment', 'cancel_appointment',
  'capture_lead', 'get_pricing', 'recommend_service', 'list_services', 'handle_recovery', 'escalate', 'detect_upsell_opportunity', 'inject_memory']);
// Dedicated endpoints that are also fine for a tool to call directly.
const GOOD_PATHS = new Set(['/api/lola-tools', '/api/lola/book-appointment', '/api/lola/check-availability', '/api/lola/get-context',
  '/api/lola/fill-gap', '/api/lola/voice-fill-gap', '/api/lola/waitlist-candidates']);
const DYNVAR_PATHS = new Set(['/api/agent-variables', '/api/lola/dynamic-variables']);

export const assistantId = () => process.env.TELNYX_LOLA_BRAIN_ID || process.env.TELNYX_ASSISTANT_ID || null;

const norm = (n) => String(n || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
export function toolUrl(name) {
  // salon={{loladesk_salon}}: on a salon's website widget the call carries the header
  // X-LolaDesk-Salon (Telnyx turns X- headers into dynamic variables), so web calls know the salon too.
  return `${appUrl()}/api/lola-tools?tool=${encodeURIComponent(norm(name))}&to={{telnyx_agent_target}}&from={{telnyx_end_user_target}}&salon={{loladesk_salon}}&call={{call_control_id}}&ch={{telnyx_conversation_channel}}`;
}
function parse(u) { try { return new URL(String(u || '').replace(/\{\{[^}]*\}\}/g, 'x')); } catch (_) { return null; } }
function ourHost(h) { const a = parse(appUrl()); return !!a && (h === a.hostname || h.replace(/^www\./, '') === a.hostname.replace(/^www\./, '')); }

/** What's wrong with one webhook tool (null = fine). */
export function diagnoseTool(tool) {
  const w = tool && tool.webhook; if (!w) return null;
  const name = norm(w.name), u = parse(w.url);
  if (!SKILL_NAMES.has(name)) {
    if (!u || !ourHost(u.hostname) || !GOOD_PATHS.has(u.pathname)) return { name: w.name, url: w.url, problem: 'unknown_tool', fixable: false };
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
    return null;
  }
  if (GOOD_PATHS.has(u.pathname)) return null;
  return { name: w.name, url: w.url, problem: u.pathname.includes('insights') ? 'insights_url' : 'wrong_path', fixable: true };
}

export async function wireAssistant({ heal = false } = {}) {
  const id = assistantId();
  if (!id) return { ok: false, error: 'TELNYX_LOLA_BRAIN_ID is not set' };
  if (!process.env.TELNYX_API_KEY) return { ok: false, error: 'TELNYX_API_KEY is not set' };
  let a;
  try { a = telnyxData(await telnyxRequest('/ai/assistants/' + encodeURIComponent(id), { timeoutMs: 9000 })); }
  catch (e) { return { ok: false, error: 'Could not read the assistant from Telnyx: ' + String(e?.message || e) }; }
  if (!a || typeof a !== 'object') return { ok: false, error: 'Assistant not found in Telnyx' };
  const tools = Array.isArray(a.tools) ? a.tools : [];
  const issues = [], fixed = [], unknown = [];
  const next = tools.map((t) => {
    const d = diagnoseTool(t);
    if (!d) return t;
    if (!d.fixable) { unknown.push({ name: d.name, url: d.url }); return t; }
    issues.push(d);
    const url = toolUrl(t.webhook.name);
    fixed.push({ name: t.webhook.name, from: t.webhook.url || null, to: url, problem: d.problem });
    return { ...t, webhook: { ...t.webhook, url, method: t.webhook.method || 'POST' } };
  });
  const dv = parse(a.dynamic_variables_webhook_url);
  const dynOk = !!dv && ourHost(dv.hostname) && DYNVAR_PATHS.has(dv.pathname);
  const patch = {};
  if (fixed.length) patch.tools = next;
  if (!dynOk) patch.dynamic_variables_webhook_url = appUrl() + '/api/agent-variables';
  let healed = false, error = null;
  if (heal && Object.keys(patch).length) {
    try { await telnyxRequest('/ai/assistants/' + encodeURIComponent(id), { method: 'PATCH', body: patch, timeoutMs: 12000 }); healed = true; }
    catch (e) { error = 'Telnyx refused the update: ' + String(e?.message || e); }
  }
  return {
    ok: (!fixed.length && dynOk) || (healed && !error),
    assistant: { id, name: a.name || null, tools: tools.length },
    miswired: fixed, unknown_tools: unknown,
    dynamic_variables: { ok: dynOk, url: a.dynamic_variables_webhook_url || null, set_to: dynOk ? null : patch.dynamic_variables_webhook_url },
    healed, error,
  };
}
