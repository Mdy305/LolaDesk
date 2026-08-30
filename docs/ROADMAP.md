# LolaDesk — Infrastructure Roadmap

Honest plan for LolaDesk's remaining infrastructure — built properly, with real env vars and real dependencies. This file tracks what's done and what's next so nobody re-builds something that already exists.

---

## Where we are today

**Real and working:**
- Cinematic landing, onboarding wizard, dashboard, 9 interior pages, Agents page (7 specialists), live at loladesk.com
- Telnyx voice + SMS + numbers (3 API handlers), with persistent multi-tenant memory in Supabase
- Lola speaks in her real, consistent ElevenLabs voice on phone calls AND in the dashboard — same voice everywhere
- Dashboard: ambient, always-on wake-word listening ("Lola, ...") in addition to tap-to-talk, with a visible mute/disable control and a one-time privacy disclosure
- SMS 10DLC compliance: STOP/HELP/START handled before any AI involvement, opt-out persisted and checked on every outbound send
- OAuth tokens encrypted at rest (AES-256-GCM)
- Anthropic Claude (or Telnyx Inference) as Lola's brain
- Stripe billing: Checkout, customer portal, signature-verified webhook, metered text-usage flush
- Vercel hosting, GitHub repo, `vercel.json` with safe function limits + security headers
- Real email/password auth (Supabase Auth)

**✅ Phase F — auth gating everywhere (DONE):**
- `auth-guard.js` exists and is included on **every** interior page (`dashboard`, `bookings`, `numbers`, `settings`, `calls`, `clients`, `inbox`, `revenue`, `team`, `marketing`, `marketer`, `subscription`, `lola-live`, `lola-atom`) — validates the token server-side via `/api/auth/session`, redirects to login otherwise
- `/api/data`'s tenant resolution is strictly server-side from the authenticated user — no `?tenant=` override, no fallback to a real salon. Unauthenticated → 401; authenticated-but-unmapped → 403. The old "anyone with the URL sees MMΛ Salon" leak is closed.
- `login.html`'s voice sign-in no longer bypasses anything — it tells the user voice sign-in is coming soon and requires email/password. Never re-add a demo token there.

**✅ Phase A — Settings → Integrations UI (DONE):**
- `settings.html` renders live provider status from `/api/data?resource=integrations` (which reads `listProviders()` + `getTenantIntegrations()`), with per-provider Connect/Disconnect wired to `/api/oauth/connect` and `/api/oauth/disconnect`, plus success/error toasts on the OAuth return redirect.

**✅ Phase B — Usage-based billing (DONE):**
- `api/lib/usage.js` sums the month's `usage_events` per tenant against plan quotas (`lib/plans.js`); `/api/data?resource=overview` includes it; the dashboard shows the near-limit (≥80%) / over-limit banner with an upgrade CTA into Stripe Checkout. `flushMeteredTextUsageToStripe` in `lib/stripe.js` handles metered overage.
- Deliberately informational, not enforcement: going over quota never blocks Lola from answering — a missed call is exactly what this product exists to prevent.

**✅ Phase C — WhatsApp (DONE, Telnyx path):**
- The real pipeline lives in `api/telnyx-sms.js`: it detects Telnyx's `type: WHATSAPP` payloads and runs the identical flow — tenant-by-called-number, STOP/HELP/START compliance, opt-out check, client memory, Lola's real brain, conversation persistence, `whatsapp_received`/`whatsapp_sent` usage events, WhatsApp-shaped outbound reply.
- `api/webhooks/whatsapp.js` is now a thin alias that re-exports that handler (it previously returned a hardcoded mock reply — that mock is gone). Point a Telnyx messaging profile's WhatsApp webhook at either URL; behavior is identical. One pipeline, never two implementations.

**✅ Phase D — More booking platforms (SHIPPED, gated on partner credentials):**
- `api/lib/connectors/vagaro.js`, `mindbody.js`, `fresha.js` now exist alongside Square/Boulevard/Shopify/Google Calendar — same `getAuthUrl / exchangeCode / refreshToken / listAppointments / createAppointment / listClients` shape, registered in `aggregator.js`, styled in Settings, env vars in `.env.example`. `oauth/connect.js` + `callback.js` needed zero provider-specific changes (except threading Mindbody's per-studio `SiteId` into integration metadata via `?siteId=` at connect time).
- Each reports `beta` ("Coming soon" in Settings) until its partner credentials are set — **the remaining work is business, not code**:
  1. **Vagaro** — apply at developer.vagaro.com → set `VAGARO_CLIENT_ID/SECRET`
  2. **Mindbody** — developers.mindbodyonline.com → set `MINDBODY_API_KEY` + `MINDBODY_CLIENT_ID/SECRET` (sandbox SiteId `-99` works for testing)
  3. **Fresha** — email partners@fresha.com (invite-only API) → set `FRESHA_CLIENT_ID/SECRET`
- Once credentials land, verify each: owner clicks Connect in Settings → consent screen → returns Connected → Bookings shows real appointments → `book_appointment` in `lola-tools.js` writes back. Endpoint field-mapping in each connector's `normalize()` may need a small touch-up against the vendor's live sandbox — that's expected and isolated to one file per provider.

---

## What's next

### Phase E — Real-time barge-in on phone calls · the last big one
**Why this is its own phase, not a quick toggle:** Telnyx's TeXML `<Gather>` has no barge-in attribute — it only listens after nested `<Play>`/`<Say>` finishes. True barge-in (caller talks over Lola, she stops and listens immediately) requires moving to Telnyx's **Call Control API with bidirectional media streaming**.

**What it takes:**
- Rebuild `telnyx-voice.js` around Call Control + Media Streaming (`/v2/calls` + WebSocket) — a different request/response shape entirely (`api/voice-stream.js` and `api/lib/telnyx-rtp-streaming.js` are the starting scaffolding)
- Real-time VAD on inbound audio to detect "caller started talking" within ~100–200ms
- A cancellable playback pipeline (kill in-flight ElevenLabs audio the instant speech is detected)
- Streaming ElevenLabs synthesis sentence-by-sentence, so less audio is already committed when interrupted
- Testing against false-positive barge-in from salon background noise (dryers, music)

**Why it's worth it:** this is the single biggest remaining gap between "feels like a good IVR" and "feels like an actual human receptionist." Everything else about the call experience already works.

**Revisit once there's real call volume to justify the rebuild.**

### Go-to-market checklist (now unblocked)
With F done, the security blocker on real marketing is cleared. In order of leverage:
1. **Square App Marketplace listing** — the Square connector is live-ready; the listing drives distribution to the largest installed base in the target market
2. **Vagaro/Mindbody/Fresha partner applications** — submit all three in parallel; code is already waiting on the credentials
3. **Voice sign-in** — either build real voice biometrics (enrollment + verification model) or keep the "coming soon" copy; never ship speech-detection-as-auth

---

## What we're explicitly NOT building (yet)

- **Redis distributed sessions** — Supabase row reads are fast enough until 50+ concurrent calls
- **Private APN cellular network for terminals** — PoS hardware territory
- **Extra webhook HMAC beyond vendor specs** — Stripe + Telnyx signature checks are implemented properly already
- **"Aura" visualizer state machine** — the orb already breathes
- **Cross-instance audio cache (Supabase Storage for `/api/voice-audio`)** — in-memory is fine at current volume; upgrade path documented in `api/lib/tts-cache.js`

When/if any of these become real bottlenecks, add them. Not before.
