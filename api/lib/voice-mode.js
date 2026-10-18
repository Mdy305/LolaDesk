/**
 * api/lib/voice-mode.js — who speaks as Lola.
 * Lola's ONE voice is her Telnyx Ultra voice (the owner's own: LOLA_SIGNATURE_VOICE) — Telnyx only,
 * like her brain. VOICE_PROVIDER=elevenlabs is the only way back to the old ElevenLabs voice;
 * LOLA_TELNYX_VOICE swaps the Telnyx voice id without a deploy of code.
 */
export const LOLA_SIGNATURE_VOICE = 'Telnyx.Ultra.81eeddd4-4185-4ffa-81b9-2cf690fa16c7';
export function telnyxVoiceMode() {
  const p = String(process.env.VOICE_PROVIDER || '').trim().toLowerCase();
  return p ? p === 'telnyx' : true;
}
/** A custom (cloned / designed) voice: its id is a UUID, so it is never in Telnyx's stock voice list. */
export const isCustomVoice = (id) => /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ''));
