# LOLABRAIN VOICE — ONE LOLA, ONE VOICE

> **The rule:** Lola is the brain of the entire platform — like Siri is for Apple.
> There is exactly **one Lola**, speaking in **one canonical voice**
> (`ELEVENLABS_VOICE_ID`). No per-tenant voice pickers. No substitute voices.
> Ever.

## Why

Lola is a brand, not a setting. Every caller, every owner, every dashboard
greeting must hear the **same** Lola — the voice the platform was built around.
If a tenant could swap in "Alexa" or "Siri," Lola stops being a product and
becomes a menu. One voice means the voice *is* the brand: instantly
recognizable, consistently warm, unmistakably Lola.

## The canonical voice path

```
Browser (dashboard / onboarding)            Phone (Telnyx)
        │                                         │
        ▼                                         ▼
  POST /api/speak                         POST /api/telnyx-voice
  POST /api/speak-lola                    (inbound call webhook)
        │                                         │
        └──────────────┬──────────────────────────┘
                       ▼
        api/lib/elevenlabs.js  ── synthesize()
                       │
                       │  ALWAYS voice = ELEVENLABS_VOICE_ID
                       │  (the exact voice created for Lola — never a
                       │   clone, never a modified copy)
                       ▼
        telnyx-voice.js speakCached()  →  voice-audio bucket (Supabase Storage)
                       │
                       ▼
        Public CDN cache key = sha1(voiceId|line)  →  served on hit,
        synthesized + uploaded on miss (fast, consistent, cheap)
```

The owner "Jarvis" line (`/api/operator-voice`) and the SMS operator channel
(`api/telnyx-sms.js`) go through the **same** canonical voice and the same
cache. Every surface of the product speaks the identical Lola.

## Enforcement points (already live)

| Where | What it does |
|---|---|
| `api/lib/elevenlabs.js` | Refuses to synthesize without `ELEVENLABS_VOICE_ID`; no other voice is ever passed |
| `api/speak.js`, `api/speak-lola.js` | Public synthesis endpoints — canonical voice only |
| `app.js` `speak()` | If the canonical voice can't be produced, **stays silent** — no `speechSynthesis` fallback |
| `dashboard.html` `playBriefing()` | Routes through `window.speak` (canonical); no browser-TTS fallback |
| `lola-resonance.js` | Hardcodes `voiceType: 'lola'` |
| `api/operator-voice.js` | Owner line — same canonical voice, same `voice-audio` cache keys |
| `telnyx-voice.js` `speakCached()` | Phone line TTS — canonical voice, storage-cached, never in-memory |

## Rejected — the old multi-voice idea (do not build)

Earlier drafts of this file proposed a "choose your voice" system:
**Jarvis / Whisper / Alexa / Siri** modes with separate ElevenLabs voice IDs and
per-voice pitch/rate tuning. That idea is **dead**:

- A multi-voice menu contradicts the one-Lola brand (voice pickers were already
  removed from the onboarding UI).
- It would fragment the `voice-audio` cache and the brand across tenants.
- "Jarvis" / "Whisper" / "Siri" are *capability* references, not voices — Lola
  is already Jarvis-like in behavior (always-on, conversational, instant) in
  her own voice.

### Vestigial column

`tenants.lolabrain_voice` (set by `api/onboarding/step3-configure.js`) is
written but **never read** — no code consumes it to choose a voice. It exists
only for backward compatibility with that rejected idea. Treat it as a
fixed `'lola'` constant; do not build on it.

## Deployment requirements

- `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` must be set in every
  environment (Vercel production included).
- `ELEVENLABS_VOICE_ID` must point at the **exact voice created for Lola** —
  verify with `/api/voices` (`current`) before launch.
- The `voice-audio` bucket is public-read so the CDN URLs serve the cache.

*One Lola. One voice. Every call, every dashboard, every tenant.*
