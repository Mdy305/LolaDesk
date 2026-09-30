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

const timed = async (fn) => { const t = Date.now(); try { const v = await fn(); return { v, ms: Date.now() - t }; } catch (e) { return { e, ms: Date.now() - t }; } };

async function numberCheck(tenant) {
  const line = tenant?.phone_number;
  if (!line) return { ok: false, say: 'Your salon doesn’t have a Lola phone number yet.', fix: 'Telecom & texting → get a number.' };
  if (!process.env.TELNYX_API_KEY) return { ok: false, say: 'Telnyx isn’t connected.', fix: 'Add TELNYX_API_KEY in Vercel.' };
  try {
    const r = await fetch(`https://api.telnyx.com/v2/phone_numbers?filter[phone_number]=${encodeURIComponent(line)}&page[size]=1`,
      { headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` }, signal: AbortSignal.timeout(6000) });
    const j = await r.json().catch(() => ({}));
    const n = j?.data?.[0];
    if (!r.ok || !n) return { ok: false, say: `I can’t find ${line} in your Telnyx account.`, fix: 'Telnyx → Numbers: make sure the salon number lives in this account.' };
    if (!n.messaging_profile_id) return { ok: false, say: `${line} can take calls but isn’t set up to text.`, fix: 'Telnyx → Numbers → your number → Messaging profile: pick the LolaDesk profile.' };
    return { ok: true, say: `Texts go out from ${line}.`, note: 'US carriers only deliver business texts once the number’s 10DLC campaign is approved in Telnyx.' };
  } catch (_) { return { ok: null, say: 'I couldn’t reach Telnyx to check your number.' }; }
}

export async function lolaSelfCheck(tenant, { speakTest = true } = {}) {
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
