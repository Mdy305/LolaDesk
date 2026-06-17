# LolaDesk — Infrastructure Roadmap

Honest plan for LolaDesk's remaining infrastructure — built properly, with real env vars and real dependencies. This file tracks what's done and what's next so nobody re-builds something that already exists.

---

## Where we are today

**Real and working:**
- Cinematic landing, onboarding wizard, dashboard, 9 interior pages, Agents page (7 specialists), live at loladesk.com
- Telnyx voice + SMS + numbers (3 API handlers), with persistent multi-tenant memory in Supabase
- Lola speaks in her real, consistent ElevenLabs voice on phone calls AND in the dashboard (not a generic TTS voice) — same voice everywhere
- Dashboard: ambient, always-on wake-word listening ("Lola, ...") in addition to tap-to-talk — mic stays passively open, only sends to the AI brain after hearing her name, with a visible mute/disable control and a one-time privacy disclosure
- Phone call replies tightened to ~1 sentence by default for a snappier, less "monologuing" feel
- SMS 10DLC compliance: STOP/HELP/START handled before any AI involvement, opt-out persisted and checked on every outbound send
- OAuth tokens (Square, Boulevard, Shopify, Google Calendar) encrypted at rest (AES-256-GCM)
- Anthropic Claude (or Telnyx Inference) as Lola's brain
- Stripe billing: Checkout, customer portal, signature-verified webhook
- Vercel hosting, GitHub repo, `vercel.json` with safe function limits + security headers
- Real email/password auth (Supabase Auth) — works correctly via `/api/auth/login` and `/api/auth/signup`

**Not yet built:**
- **Auth gating on most interior pages — see Phase F, flagged as a real security gap, not cosmetic.** `login.html`'s "voice login" is an explicit demo stub (its own code comment says so) that signs anyone in after any sound, with no real verification, and most pages don't check for a valid session at all.
- Real-time barge-in on phone calls (caller interrupting Lola mid-sentence) — see Phase E below, this is a genuinely larger architecture change
- WhatsApp messaging (Meta Cloud API or Telnyx WhatsApp)
- Usage-based billing enforcement (the `usage_events` table is logging `voice_call`, `ai_token`, `tts_chars`, `sms_sent`/`received` — Stripe metered billing on top of that data is the next step)
- Square/Boulevard/Vagaro/Mindbody live calendar sync UI in Settings (the connectors and encrypted token storage exist; the "Connect" buttons and live status display in `settings.html` still need wiring to `/api/oauth/connect`)

---

## What's next, in order

### Phase A — Wire the Settings → Integrations UI · ~2 hours
**Why first:** the hard part (OAuth flows, encrypted token storage, the connector abstraction in `api/lib/connectors/`) is already built. What's missing is the visible "Connect Square" button in `settings.html` actually hitting `/api/oauth/connect?provider=square&tenant=<slug>` and showing real connection status afterward.

**What to build:**
- `settings.html`: replace the mock integration cards with a fetch to a new small endpoint (or extend `/api/data?resource=integrations`) that lists `getTenantIntegrations()` status per provider
- Wire each "Connect" button to `GET /api/oauth/connect?provider=<id>&tenant=<slug>` (already exists, just needs a real link)
- Show connected/pending/error state after the OAuth redirect lands back on `/settings?connect=success&provider=square`

**Verification:** owner clicks "Connect Square" in Settings → Square consent screen → returns → Settings shows "Connected" → Bookings page shows their real Square appointments via `check_availability`/`book_appointment` in `lola-tools.js`.

---

### Phase B — Usage-based billing enforcement · ~3 hours
**Why second:** `usage_events` is already being logged on every call, text, and AI turn (see `telnyx-voice.js`, `telnyx-sms.js`). What's missing is actually acting on it — soft-capping plans and prompting upgrades.

**What to build:**
- A small cron or on-request check (e.g. in `data.js`'s overview resource) that sums this month's `usage_events` per tenant against their plan's included quota
- Stripe metered billing or simple overage line items via `createCheckout`'s existing helper, billed monthly
- Dashboard banner: "You're at 80% of your plan — upgrade for $50/mo more" — this is the highest-leverage lever for self-serve revenue growth without a sales team

**Verification:** seed a tenant's `usage_events` past their plan limit → dashboard overview shows the warning → upgrade flow lands them on Stripe Checkout for the next tier.

---

### Phase C — WhatsApp · ~2 hours
**Why third:** salons (and especially med spas) ask for it constantly. Storage and billing are already in place to support it.

**Two real paths — pick one:**

**Option A: Telnyx WhatsApp** (cleanest fit since you already use Telnyx)
- Telnyx Portal → Messaging → WhatsApp → onboard your Meta Business account
- Reuse the existing `telnyx-sms.js` shape (including the STOP/HELP/START compliance gate and opt-out check, which should apply to WhatsApp too) — Telnyx routes WhatsApp inbound to a webhook the same way
- Add `/api/telnyx-whatsapp.js` mirroring the SMS handler

**Option B: Meta WhatsApp Cloud API direct**
- Meta Business → WhatsApp Business → get a phone number ID + access token
- Build `/api/whatsapp-meta.js` with their webhook signature verification
- More work but no Telnyx markup on WhatsApp

**Recommendation:** Option A. Same vendor relationship, faster ship, similar margins. Switch to B later if WhatsApp volume justifies it.

**Env vars added (Option A):**
- `TELNYX_WHATSAPP_PROFILE_ID`

**Verification:** WhatsApp Lola's number → she replies in WhatsApp, in her real ElevenLabs-voiced tone of voice (text, not audio, but same brand personality) → Inbox page shows the thread with a WhatsApp pill.

---

### Phase D — More booking platforms · ~4 hours each
**Why last:** Square and Boulevard connectors already exist (`api/lib/connectors/square.js`, `boulevard.js`) along with Shopify and Google Calendar. Adding Vagaro/Mindbody/Fresha follows the exact same pattern — `getAuthUrl()`, `exchangeCode()`, `listAppointments()`, `createAppointment()` — and plugs straight into the existing `aggregator.js` and `lola-tools.js` without changing either.

**Platforms in priority order:**
1. **Vagaro** — second-biggest in our target market, after Square
2. **Mindbody** — bigger footprint but legacy API, slower to ship
3. **Fresha** — global reach, useful for international expansion

**What each integration includes:**
- A new file in `api/lib/connectors/` following the exact shape of `square.js`
- Register it in `aggregator.js`'s `CONNECTORS` map — nothing else changes, since `oauth/connect.js`, `oauth/callback.js`, and `lola-tools.js` are already provider-agnostic
- Env vars: `<PROVIDER>_CLIENT_ID` + `<PROVIDER>_CLIENT_SECRET`, added to `.env.example`

**Verification:** owner clicks "Connect Vagaro" → consent screen → returns connected → Bookings page shows real Vagaro appointments.

---

### Phase E — Real-time barge-in on phone calls · genuinely bigger project, not a quick fix
**Why this is its own phase, not a quick toggle:** Telnyx's current TeXML `<Gather>` verb has no `bargeIn` attribute — there is no documented flag that lets a caller interrupt Lola mid-sentence. `<Gather>` only starts listening for speech after every nested `<Play>`/`<Say>` finishes playing. True barge-in (caller talks over Lola, she stops and listens immediately — what a real human receptionist does naturally) requires moving off the TeXML request/response model entirely, onto Telnyx's **Call Control API with real-time bidirectional media streaming** (WebSocket audio in both directions, live voice-activity detection, manually cancelling in-flight ElevenLabs playback the instant speech is detected).

**What it would actually take:**
- Rebuild `telnyx-voice.js` around Telnyx Call Control + Media Streaming (`/v2/calls` + WebSocket) instead of TeXML webhooks — a different request/response shape entirely, not an incremental change to the current file
- Real-time VAD (voice activity detection) on the inbound audio stream to detect "caller started talking" within ~100-200ms
- A cancellable playback pipeline: ElevenLabs audio currently plays to completion once started; barge-in needs the ability to kill in-flight playback the instant the caller's speech is detected
- Almost certainly: streaming ElevenLabs synthesis (sentence-by-sentence) rather than synthesizing the full reply upfront, so there's less already-committed audio to interrupt
- Careful testing against false-positive barge-in (background salon noise — dryers, music, other conversations — triggering interruption when the caller didn't actually mean to interrupt)

**Why it's worth it eventually:** this is the single biggest remaining gap between "feels like a good IVR" and "feels like an actual human receptionist." Everything else about the call experience (natural language, no press-1 menus, persistent memory, her real voice) already works well — barge-in is the last mile.

**Not started.** Revisit once Phases A–D are done and there's real call volume to justify the rebuild.

---

### Phase F — Real authentication gating on every interior page · security fix, do before scaling signups
**Found while wiring Settings → Integrations (Phase A):** most interior pages (`dashboard.html`, `bookings.html`, `numbers.html`, `agents.html`) have **no login check at all** — `auth-guard.js` was referenced by 7 other pages (`calls.html`, `clients.html`, `inbox.html`, `lola-live.html`, `marketing.html`, `revenue.html`, `team.html`) but the file never existed in the repo, so those references silently 404'd and did nothing. Combined with `/api/data`'s fallback to the real seeded MMΛ Salon tenant when no auth token is present, **any interior page was viewable by anyone with the URL, showing real salon data.**

A real `auth-guard.js` now exists (added while building Phase A) and is wired into `settings.html` only, since that page was being actively rebuilt at the same time this gap was found. It is **deliberately not yet added to the other pages** — that's the scope of this phase.

**Separately, and more serious:** `login.html`'s "voice login" is an explicit demo stub — the code comment says so directly: *"any spoken phrase signs in (demo). In production: voice biometric / passphrase."* It sets no auth token and just redirects to `dashboard.html` after hearing any sound. Until `dashboard.html` itself enforces `auth-guard.js`, this means literally anyone speaking into the mic reaches the dashboard.

**What this phase needs to do:**
1. Add `<script src="auth-guard.js"></script>` (before `lola-data.js`/`sidebar.js`) to every interior page that shows real tenant data: `dashboard.html`, `bookings.html`, `numbers.html`, `agents.html`, and re-verify it now actually loads (not 404s) on the 7 pages that already referenced it
2. Either implement real voice authentication (a genuinely hard problem — voice biometrics need enrollment + a real verification model, not just "speech was detected") or remove the voice option from `login.html` and keep only email/password until biometric login is properly built
3. Audit `/api/data.js`'s `resolveTenant()` fallback — decide whether an unauthenticated request should get a 401 instead of silently falling back to the real MMΛ Salon tenant

**Do this before any real marketing push or marketplace listing** — right now, every salon's booking, client, and revenue data is one URL away from anyone, not just their own pages.

---

## What we're explicitly NOT building (yet)

Listing them so we both know they're parked, not forgotten:

- **Redis distributed sessions** — Vercel cold starts are real but Supabase row reads are fast enough until you have 50+ concurrent calls
- **Private APN cellular network for terminals** — that's PoS hardware territory, not relevant until LolaDesk sells physical devices
- **Hand-rolled webhook HMAC verification beyond what Stripe already requires** — Stripe's signature check is implemented properly in `lib/stripe.js`; don't add more crypto than the vendor's own spec requires
- **"Aura" visualizer state machine** — the orb already breathes; over-engineering its state machine is a distraction
- **Cross-instance audio cache (Supabase Storage for `/api/voice-audio`)** — in-memory caching is fine at current call volume; the upgrade path is documented in `api/lib/tts-cache.js` for when it's actually needed

When/if any of these become real bottlenecks, add them. Not before.

---

## Recommended next step

**Phase A (wire the Settings UI)** is the highest-leverage next step for revenue/distribution — the backend work for OAuth + encrypted storage is done; right now it's invisible to salon owners. That's ~2 hours to make real integrations actually usable from the dashboard, which directly supports the "Square App Marketplace listing" distribution goal in mind for LolaDesk.

**Phase F (auth gating) should happen before any real marketing push, marketplace listing, or onboarding salons beyond friends-and-family testing.** It's a genuine security gap, not a nice-to-have — see the phase above for specifics.
