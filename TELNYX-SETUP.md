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

---

## Profit & experience levers (built-in)

**Missed-call text-back** — when a caller goes silent twice, Lola gives one warm
"are you still there?" re-prompt, then says goodbye and instantly texts them
from the same number: *"Hi, it's Lola from {salon} 💗 Sorry we got cut off! I
can book you right here…"* The lead that used to evaporate lands in the Inbox
as a warm SMS conversation. Opt-outs are respected; each send logs `sms_sent`
+ `textback_sent` usage events. No config needed — it's on for every tenant.

**No dead-air hangups** — TeXML `<Gather>` only posts back on speech; silence
used to end the document and drop the call with no goodbye. A `<Redirect>`
now brings silence back into `/api/telnyx-voice?silence=N` for the re-prompt →
goodbye flow above.

**Per-salon speech hints** — every `<Gather>` carries a `hints` list built from
the tenant's actual service menu ("balayage", "dermaplaning", …) plus core
booking vocabulary, so recognition is tuned to what THIS salon's callers say.

**Cached synthesis** — the greeting, re-prompt, goodbye, and deterministic
replies repeat on every call; they now synthesize through ElevenLabs once per
15-minute window and replay instantly from `api/lib/tts-cache.js`'s keyed
cache. Faster first ring, zero repeated `tts_chars` spend on identical lines.

**Number resale margin** — `NUMBER_RETAIL_MONTHLY` (default $5) and
`NUMBER_RETAIL_TOLLFREE_MONTHLY` (default $9) set what salons pay; Telnyx
wholesale is ~$1/$2. Search results return both `cost` and `monthly`, the
UI shows retail, and every purchase logs a `number_rent` usage event with the
margin in metadata for the billing layer to invoice.

---

## The two-number architecture (this is the SaaS margin model)

You need exactly **two Telnyx webhooks configured, once, forever** — every
tenant you ever sign shares them:

**1. The booking line(s)** — each salon's public Lola number
   · Voice webhook → `POST https://www.loladesk.com/api/telnyx-voice`
   · Messaging webhook → `POST https://www.loladesk.com/api/telnyx-sms`
   · Tenant is resolved by the **called** number (`tenants.phone_number`).
   · These numbers are the resale revenue line (`NUMBER_RETAIL_MONTHLY`).

**2. The Jarvis line** — ONE shared owner number for your whole customer base
   · Voice webhook → `POST https://www.loladesk.com/api/operator-voice`
   · Tenant is resolved by the **caller** (`tenants.operator_phone`,
     registered by each owner in Settings via `/api/operator-setup`).
   · Unknown callers are refused and hung up — never a demo tenant.
   · Reads (schedule, revenue, rebooking radar) work on caller ID alone;
     anything destructive (move / cancel / broadcast) requires the spoken
     PIN, verified against `operator_pin_hash` with an HMAC-signed action
     token carried between turns — nothing stored server-side.

**Why this makes the unit economics sing:** the Jarvis feature costs you
one number (~$1/mo TOTAL, not per tenant) plus usage, while "run your salon
by voice from your car" is exactly the kind of feature that justifies the
Pro/Medspa tier price. Every marginal tenant on the Jarvis line is ~100%
gross margin. The per-tenant Telnyx AI Assistant path
(`/api/operator-provision`) still exists for white-glove enterprise
accounts that want a private line.

**Owner command grammar** (deterministic — works with every AI provider
down): "what's my day tomorrow" · "how much did we make this month" ·
"who's due to rebook" · "cancel Sarah's appointment tomorrow" ·
"move Maria to Friday at 3pm" · "text my VIPs saying flash sale today" ·
"book Jane for a blowout tomorrow at 2pm" · then "PIN + confirm" for
anything destructive.

**The Calls page now fills itself:** every answered client call creates a
`calls` row and accumulates a rolling transcript per turn, upgrading the
outcome to `booked` when a booking lands — this is the page that renews
subscriptions, because it's where owners watch Lola earn her keep.

---

## eSIM resale ("Lola Link") — the third revenue line

`/api/telnyx-esim` turns Telnyx Wireless into a per-tenant add-on. Wholesale:
$0.70 one-time per OTA eSIM, **$2/mo active**, **$0.20/mo suspended**, data
tiered ~$0.0125–0.078/MB — and the tiers are computed across your WHOLE
account, so every new tenant pushes all tenants into cheaper data. Your COGS
per tenant falls as you grow; retail stays flat.

**Play 1 — Uptime failover (sell this one first).** "Lola never sleeps": an
eSIM in a $40 failover router (or the front-desk tablet's second profile)
keeps bookings flowing when salon Wi-Fi dies. Failover months use almost no
data, so COGS ≈ $2. At `ESIM_RETAIL_MONTHLY=15` that's ~87% gross margin —
and it's the easiest yes in the pitch, because every salon has lived the
Wi-Fi-down afternoon.

**Play 2 — the LolaPad.** A tablet at reception running the dashboard,
online out of the box, zero salon IT. Honest economics: Telnyx wireless is
IoT-priced, NOT broadband — so every SIM ships with a hard `data_limit`
(`ESIM_INCLUDED_MB=500`) and overage bills at `ESIM_RETAIL_PER_MB`. The
dashboard is light; the cap is the guardrail that keeps this play profitable.

**Play 3 — the device roadmap.** Photo-campaign cameras, door counters,
smart mirrors: trickle-data devices are exactly what IoT pricing exists for,
and each one deepens the moat.

**Why this retains tenants:** hardware on the counter is churn armor — 
cancelling LolaDesk now means unplugging a device the front desk relies on.
And the suspend lever reframes churn itself: `action:'disable'` parks the
SIM at $0.20/mo instead of cancelling, so a lapsed salon's winback is ONE
`enable` call — their device lights back up like nothing happened.

**Billing wiring:** ordering logs `esim_rent` at retail (wholesale + margin
in metadata, same pattern as `number_rent`); the status endpoint computes
`over_mb` × `ESIM_RETAIL_PER_MB` for the invoice roll-up.
