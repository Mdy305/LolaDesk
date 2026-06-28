# Telnyx Setup — Voice, Messaging & Numbers

LolaDesk runs the full Telnyx suite. This is what powers the phone, the texting, and the number-selling revenue line.

## The three handlers

| File | What it does |
|------|---------------|
| `api/telnyx-voice.js` | Lola **answers phone calls**. Telnyx hits this URL on every call; it returns TeXML that makes Lola speak (in her real ElevenLabs voice — see below), listen, and book. Resolves which salon owns the called number and persists conversation memory to Supabase. |
| `api/telnyx-sms.js` | Lola **replies to texts**. Inbound SMS → Lola answers → texts back. Handles STOP/HELP/START keywords for 10DLC compliance *before* any AI involvement. Also exports `sendSMS()` for outbound (booking links, missed-call text-back, future campaigns) — every send checks the opt-out flag first. |
| `api/telnyx-numbers.js` | **Search & buy numbers**. Powers the `/numbers` marketplace where salons get their Lola line. Auto-attaches voice + SMS on purchase. |

## Lola's voice on calls

Real callers hear Lola's actual ElevenLabs voice — the same one used in the dashboard's voice chat (`api/speak.js`) — not a generic TTS voice. `telnyx-voice.js` synthesizes each reply through ElevenLabs (`api/lib/elevenlabs.js`), caches the audio briefly (`api/lib/tts-cache.js` + `api/voice-audio.js`), and points TeXML's `<Play>` verb at that cached URL.

**Requires `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`.** If either is missing, or synthesis fails on a given turn, that turn falls back to Telnyx's built-in `Polly.Joanna-Neural` voice automatically — callers never hear dead air, but you also won't get the "real Lola" experience until those env vars are set correctly. If live calls sound like a generic voice, check those two vars first.

This trades a small amount of latency (~0.5–1.5s per turn for ElevenLabs synthesis + fetch, vs. instant for Telnyx's built-in `<Say>`) for full brand-voice consistency. That's intentional.

## Reply length and barge-in

Lola's call replies default to one short sentence (`buildSystemPrompt` in `telnyx-voice.js`, `maxTokens: 90`) — calls feel snappier when there's less to sit through before she's done talking and listening again. This is a meaningful but partial fix for "feels robotic": **callers still can't interrupt her mid-sentence.** Telnyx's TeXML `<Gather>` has no documented `bargeIn` attribute — true interruption requires Telnyx's Call Control + real-time media streaming API, a genuinely larger rebuild tracked as Phase E in `ROADMAP.md`. Don't be surprised this isn't there yet; it's a known, deliberately deferred gap, not an oversight.

## Environment variables (Vercel → Settings → Environment Variables)

See `.env.example` for the complete, current list — that file is the source of truth. The ones specific to Telnyx + voice:

```
ANTHROPIC_API_KEY          Lola's brain (or set LLM_PROVIDER=telnyx to use Telnyx Inference instead)
TELNYX_API_KEY             Voice, SMS, and number provisioning
TELNYX_VOICE_APP_ID        Your TeXML app id (auto-attach voice to new numbers)
TELNYX_MESSAGING_PROFILE   Your messaging profile id (auto-attach SMS)
ELEVENLABS_API_KEY         Lola's real voice
ELEVENLABS_VOICE_ID        Lola's specific cloned/custom voice id
TELNYX_PUBLIC_KEY          Optional: verify Telnyx webhook signatures (recommended)
```

After adding these, **redeploy** so the functions pick them up.

## One-time Telnyx portal setup

**1. Voice (TeXML app)**
- Portal → Voice → Programmable Voice → **Create TeXML App**
- Voice URL: `https://YOUR-APP.vercel.app/api/telnyx-voice` · Method: **POST**
- Copy the app's Connection ID → that's your `TELNYX_VOICE_APP_ID`

**2. Messaging profile**
- Portal → Messaging → **Create messaging profile** (API v2)
- Inbound webhook URL: `https://YOUR-APP.vercel.app/api/telnyx-sms`
- Copy the profile ID → that's your `TELNYX_MESSAGING_PROFILE`
- **10DLC registration**: before sending meaningful SMS volume, register your messaging campaign/brand with Telnyx's 10DLC onboarding — carriers will filter or block unregistered traffic. STOP/HELP/START are handled in code (see above) but campaign registration is a separate, required step on Telnyx's side.

**3. API key**
- Portal → Auth → **Create API Key** → that's your `TELNYX_API_KEY`

**4. (Recommended) Webhook signature verification**
- Portal → API Keys / Public Keys → copy your Telnyx public signing key
- Set `TELNYX_PUBLIC_KEY` in Vercel
- The app will verify `telnyx-signature-ed25519` + `telnyx-timestamp` on webhook calls

## How a salon gets a working number

1. Salon opens `/numbers` in the dashboard
2. Searches by area code → sees available local numbers
3. Clicks **Get this number**
4. `telnyx-numbers.js` orders it AND attaches your TeXML voice app + messaging profile
5. Lola is instantly live on that number — answers calls and texts immediately, in her real voice

## The revenue model (this is the money part)

| Line | Telnyx cost | You charge | Margin |
|------|-------------|------------|--------|
| Phone number rent | ~$1/mo | $5/mo | recurring |
| Inbound voice | ~$0.012/min | bundled in plan | overage above bundle |
| Outbound voice (rebooking calls) | ~$0.012/min | bundled | drives salon revenue |
| SMS | ~$0.004/msg | bundled | overage above bundle |
| ElevenLabs synthesis | per-character, varies by plan | bundled | factor into Pro/Med Spa pricing — voice minutes now cost both Telnyx AND ElevenLabs |

Every salon needs a number → that's recurring rent from day one. Usage rides on top, tracked per-tenant in the `usage_events` table (`kind`: `voice_call`, `ai_token`, `tts_chars`, `sms_sent`, `sms_received`) — that's your billing/margin data source once you wire usage-based Stripe metering.

## Testing voice locally

You can't fully test inbound voice without a real Telnyx number pointed at a public URL. Once deployed:
1. Buy a number (via `/numbers` or the portal)
2. Point its TeXML app at `/api/telnyx-voice`
3. Call the number → Lola answers in her real voice

## Production notes

- Conversation memory persists to Supabase (`getOrStartConversation` / `getConversationHistory` in `api/lib/db.js`) — Lola remembers callers across calls, not just within one call. Per-turn state also rides in TeXML's `client_state` for speed within a single call.
- `/api/voice-audio` caches synthesized audio in a single serverless instance's memory for ~60 seconds — fine at current scale. If you see occasional fallback-voice turns under high concurrent call volume, that's a Vercel multi-instance cache miss; see the scaling note at the bottom of `api/lib/tts-cache.js` for the Supabase Storage upgrade path.
- The 7-agent Telnyx-native system in `api/telnyx-agents.js` (and the "copy config" button in `agents.html`) is a **separate, experimental architecture** — no phone number currently routes to it. The live path is `telnyx-voice.js`'s custom TeXML + Claude/Telnyx-Inference loop described above. Don't be surprised these two systems both reference Lola; only one is wired to real calls today.
- Porting callbacks should target `https://YOUR-APP.vercel.app/api/webhooks/telnyx`.
