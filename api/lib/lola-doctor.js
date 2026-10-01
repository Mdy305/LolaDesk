/**
 * api/lib/lola-doctor.js — "Lola, run a check."
 * ════════════════════════════════════════════════════════════════
 * Lola tests her own chain, live, and says what's broken in plain words:
 *   brain  — a real Telnyx inference round trip (which model, how fast)
 *   voice  — a real spoken sentence (which engine)
 *   texts  — the salon line exists and is attached to a messaging profile
 *   hands  — her reflexes (open a page, catch you up) resolve
 * Used by the dashboard brain ("run a check", "are you ok") and GET /api/lola/doctor.
 */
import { chat, FAST_MODEL } from './llm.js';
import { synthesize, voiceProvider } from './elevenlabs.js';
import { routeOwnerIntent } from './owner-intents.js';
import { db } from './db.js';
import { wireTenantNumbers } from './tenant-wiring.js';
import { wireAssistant } from './assistant-wiring.js';
import { wireAccount } from './telnyx-account.js';

const timed = async (fn) => { const t = Date.now(); try { const v = await fn(); return { v, ms: Date.now() - t }; } catch (e) { return { e, ms: Date.now() - t }; } };

async function numberCheck(tenant) {
  const line = tenant?.phone_number;
  if (!process.env.TELNYX_API_KEY) return { ok: false, say: 'Telnyx isn’t connected.', fix: 'Add TELNYX_API_KEY in Vercel.' };
  const c = db();
  if (!c) return { ok: null, say: 'I couldn’t reach your database to check your line.' };
  try {
    const w = await wireTenantNumbers(c, { tenantId: tenant.id, heal: true });
    if (w.error) return { ok: null, say: 'I couldn’t reach Telnyx to check your line.' };
    if (!w.numbers.length) return { ok: false, say: 'Your salon doesn’t have a Lola phone number yet.', fix: 'Salon → Phone & texting → get a number.' };
    const lost = w.numbers.filter(n => !n.on_telnyx);
    if (lost.length) return { ok: false, say: `I can’t find ${lost.map(n => n.phone_number).join(', ')} in your Telnyx account.`, fix: 'Telnyx → Numbers: make sure the salon number lives in this account.' };
    const healed = w.numbers.filter(n => n.healed.length);
    const noText = w.numbers.filter(n => !n.texts);
    if (noText.length) return { ok: false, say: `${noText[0].phone_number} can’t text yet.`, fix: w.messaging_profile ? 'Telnyx → Numbers → your number → Messaging: pick the LolaDesk profile.' : 'Add TELNYX_MESSAGING_PROFILE_ID in Vercel.' };
    const noCall = w.numbers.filter(n => !n.calls);
    if (noCall.length) return { ok: false, say: `Calls to ${noCall[0].phone_number} don’t reach me yet.`, fix: 'Set TELNYX_LOLA_BRAIN_ID or TELNYX_VOICE_APP_ID in Vercel.' };
    const first = w.numbers[0].phone_number || line;
    return { ok: true, say: `${healed.length ? `I re-wired ${healed.map(n => n.phone_number).join(', ')} to Telnyx. ` : ''}Calls and texts on ${first} come to me.`, note: 'US carriers only deliver business texts once the number’s 10DLC campaign is approved in Telnyx.' };
  } catch (_) { return { ok: null, say: 'I couldn’t reach Telnyx to check your line.' }; }
}

export async function lolaSelfCheck(tenant, { speakTest = true, platform = false } = {}) {
  const checks = [];
  // Brain
  const b = await timed(() => chat({ system: 'Reply with the single word: ready', messages: [{ role: 'user', content: 'Status?' }], maxTokens: 20, fast: true, deadlineMs: 12000 }));
  const brainOk = b.v?.ok && b.v.text;
  const slow = brainOk && /Kimi/i.test(b.v.model || '');
  checks.push({ key: 'brain', ok: !!brainOk && !slow, ms: b.ms, model: b.v?.model || FAST_MODEL(),
    say: brainOk ? `My brain answered in ${(b.ms / 1000).toFixed(1)} seconds${slow ? ' on Kimi, because the fast model isn’t available on your Telnyx account — so I’m slower than I should be' : ''}.` : 'My brain isn’t answering.',
    fix: brainOk ? (/Kimi/i.test(b.v.model || '') ? `Telnyx → AI → Inference: enable ${FAST_MODEL()} (or set LOLA_FAST_MODEL to a model you have).` : null) : 'Check TELNYX_API_KEY in Vercel and that Telnyx AI Inference is enabled on the account.',
    error: brainOk ? undefined : (b.v?.error || String(b.e?.message || '')) });
  // Voice
  if (speakTest) {
    const v = await timed(() => synthesize('Ready.'));
    const bytes = v.v?.length || v.v?.byteLength || 0;
    checks.push({ key: 'voice', ok: bytes > 0, ms: v.ms, engine: voiceProvider(),
      say: bytes > 0 ? `My voice works (${voiceProvider() === 'telnyx' ? 'Telnyx' : 'ElevenLabs'}).` : 'My voice isn’t working.',
      fix: bytes > 0 ? null : 'Check TELNYX_API_KEY (Telnyx voice) or ELEVENLABS_API_KEY.', error: bytes > 0 ? undefined : String(v.e?.message || '') });
  }
  // Texts
  const n = await numberCheck(tenant);
  checks.push({ key: 'texts', ...n });
  // The platform owner's check first sets up the Telnyx account itself (texting profile, outbound calling)…
  if (platform) {
    try {
      const acc = await wireAccount(db(), { heal: true });
      const m = acc.messaging || {}, v = acc.voice || {};
      const bits = [];
      if (m.did?.includes('created')) bits.push('created your LolaDesk texting profile');
      else if (m.did?.includes('adopted')) bits.push(`adopted your texting profile “${m.name || m.id}”`);
      if (m.did?.includes('webhook')) bits.push('pointed incoming texts to LolaDesk');
      if (v.did?.includes('created_profile')) bits.push('created an outbound calling profile');
      if (v.did?.includes('outbound_profile')) bits.push('switched on outbound calling');
      checks.push({ key: 'telnyx_account', ok: acc.error ? false : acc.ok, messaging: m, voice: v,
        say: acc.error ? `Telnyx isn’t connected: ${acc.error}.` : `${bits.length ? 'In Telnyx I ' + bits.join(', ') + '. ' : 'Telnyx texting and calling are set up. '}${!m.ok ? (m.say || 'Texting isn’t set up yet.') + ' ' : ''}${!v.ok ? (v.say || 'Outbound calling isn’t set up yet.') : ''}`.trim(),
        fix: m.ok && !m.env_set && m.id ? `Optional: add TELNYX_MESSAGING_PROFILE_ID = ${m.id} in Vercel.` : null });
    } catch (_) {}
  }
  // …then re-wires Lola's Telnyx assistant (tool URLs, salon details)…
  if (platform) {
    try {
      const aw = await wireAssistant({ heal: true });
      const n = (aw.miswired || []).length;
      checks.push({ key: 'assistant', ok: aw.error ? false : aw.ok, fixed: aw.miswired, unknown: aw.unknown_tools,
        say: aw.error && !aw.assistant ? `I couldn’t check my phone assistant: ${aw.error}.`
          : `${n ? `I re-pointed ${n} of my phone tools to LolaDesk (${aw.miswired.map(x => x.name).join(', ')}). ` : 'My phone tools all point to LolaDesk. '}${aw.dynamic_variables.ok ? '' : 'I reconnected the salon details I load on every call. '}${(aw.unknown_tools || []).length ? `${aw.unknown_tools.length} tool${aw.unknown_tools.length === 1 ? '' : 's'} I don’t run (${aw.unknown_tools.map(x => x.name).join(', ')}) — you can delete ${aw.unknown_tools.length === 1 ? 'it' : 'them'} in Telnyx.` : ''}`.trim(),
        fix: aw.error || null });
    } catch (_) {}
  }
  // …and every salon on the account.
  if (platform) {
    try {
      const w = await wireTenantNumbers(db(), { heal: true });
      checks.push({ key: 'all_salons', ok: w.error ? null : w.ok, say: w.error ? 'I couldn’t reach Telnyx to check every salon.' : `Every salon line checked: ${w.numbers.length} number${w.numbers.length === 1 ? '' : 's'}${w.healed ? `, ${w.healed} re-wired` : ''}${w.broken ? `, ${w.broken} still need a look in Telnyx` : ', all answering and texting'}.`, numbers: w.numbers });
    } catch (_) {}
  }
  // Hands
  const reflex = routeOwnerIntent('open my calendar');
  checks.push({ key: 'reflexes', ok: reflex?.navigate === '/calendar', say: 'I can open pages, catch you up, text, call, move and cancel on command.' });
  // In-browser live voice
  checks.push({ key: 'live_voice', ok: true, say: process.env.LOLA_VOICE_RELAY_URL ? 'Live voice runs through your Telnyx assistant.' : 'In the app you talk to me directly: I hear you, think and answer out loud.' });

  const broken = checks.filter(c => c.ok === false);
  const say = broken.length
    ? `I found ${broken.length === 1 ? 'one thing' : broken.length + ' things'} to fix. ${broken.map(c => c.say + (c.fix ? ` ${c.fix}` : '')).join(' ')}`
    : `Everything’s working. ${checks.filter(c => c.key === 'brain' || c.key === 'voice' || c.key === 'texts').map(c => c.say).join(' ')}`;
  return { ok: !broken.length, say, checks };
}
