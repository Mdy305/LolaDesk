/**
 * api/lib/paid-hooks.js — the two money hooks the live channels call, loaded lazily.
 * ════════════════════════════════════════════════════════════════════════════
 * service-gate.js (may an expired / cancelled / unpaid salon still use paid
 * services?) and costs.js (what each call / text / voice line / AI turn cost)
 * are owned by the billing layer. The phone line, texts and Lola's tools call
 * them through here so a missing or broken module can never take a call down:
 *   - the gate FAILS OPEN (allowed) when the module is missing or throws;
 *   - cost logging is silent and never throws.
 */
// Tests (and only in-process code) can stand in for the billing modules: globalThis.__lolaPaidHooks = { serviceAllowed, logCost }.
async function gateModule() { const o = globalThis.__lolaPaidHooks; if (o && typeof o.serviceAllowed === 'function') return o; return import('./service-gate.js'); }
async function costModule() { const o = globalThis.__lolaPaidHooks; if (o && typeof o.logCost === 'function') return o; return import('./costs.js'); }
const envNum = (name, dflt) => { const n = Number(process.env[name]); return Number.isFinite(n) && n >= 0 ? n : dflt; };

/** → { ok:boolean, reason?, say? } — ok:true when the gate can't be consulted. */
export async function serviceGate(tenant) {
  if (!tenant || !tenant.id) return { ok: true, skipped: 'no_tenant' };
  try {
    const m = await gateModule();
    if (typeof m.serviceAllowed !== 'function') return { ok: true, skipped: 'no_gate' };
    const r = await m.serviceAllowed(tenant);
    if (r && r.ok === false) return { ok: false, reason: r.reason || 'not_allowed', say: r.say || null };
    return { ok: true };
  } catch (_) {
    return { ok: true, skipped: 'gate_unavailable' };
  }
}

/** Fire-and-forget-safe: resolves to true when logged, false otherwise. Never throws. */
export async function logCostSafe(tenantId, kind, cents, meta = {}) {
  if (!tenantId || !kind || !(Number(cents) > 0)) return false;
  try {
    const m = await costModule();
    if (typeof m.logCost !== 'function') return false;
    await m.logCost(tenantId, kind, Math.ceil(Number(cents)), meta);
    return true;
  } catch (_) { return false; }
}

export const voiceMinuteCents = (seconds) => Math.ceil(Math.max(0, Number(seconds) || 0) / 60) * envNum('TELNYX_VOICE_CENTS_PER_MIN', 1);
/** SMS segments: 160 GSM-7 chars (153 when split), 70 UCS-2 (67 when split). */
export function smsSegments(text) {
  const s = String(text || '');
  if (!s) return 0;
  const ucs = /[^\u0000-\u007f -ÿ€]/.test(s);
  const single = ucs ? 70 : 160, multi = ucs ? 67 : 153;
  const len = [...s].length;
  return len <= single ? 1 : Math.ceil(len / multi);
}
export const smsCents = (text) => smsSegments(text) * envNum('TELNYX_SMS_CENTS', 1);
export const ttsCents = (chars) => Math.ceil((Math.max(0, Number(chars) || 0) / 1000) * envNum('ELEVENLABS_CENTS_PER_1K_CHARS', 18));
export const aiCents = () => envNum('AI_CENTS_PER_CALL', 1);
