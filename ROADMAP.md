# LolaDesk — Infrastructure Roadmap

Honest plan for adding Stripe billing, WhatsApp, and platform OAuth (Square, Vagaro, Boulevard, Mindbody, Shopify) — built properly, with real env vars and real dependencies. **None of this exists yet.** This is what we'll build, in order, so each step works before the next starts.

---

## Where we are today

**Real and working:**
- Cinematic landing, voice login, onboarding wizard, dashboard, 9 interior pages, Agents page (7 specialists), live at loladesk.com
- Telnyx voice + SMS + numbers + agents (4 API handlers)
- Anthropic Claude as Lola's brain
- Vercel hosting, GitHub repo
- 4 env vars set: ANTHROPIC_API_KEY, TELNYX_API_KEY, TELNYX_VOICE_APP_ID, TELNYX_MESSAGING_PROFILE

**Not yet built (the additions):**
- Database (persistent memory across calls/texts/sessions)
- Stripe billing (so trials end, plans charge, usage meters)
- WhatsApp messaging (Meta Cloud API or Telnyx WhatsApp)
- OAuth to Square, Vagaro, Boulevard, Mindbody, Shopify

---

## The order that actually makes sense

Each step requires the one before it. Doing them in the wrong order means rebuilding.

### Phase 1 — Database (Supabase) · ~2 hours
**Why first:** every other addition writes/reads data. Without storage, Stripe customer IDs vanish, WhatsApp threads can't be looked up, OAuth tokens have nowhere to live.

**What to build:**
- Supabase project (free tier is fine to start)
- Schema: `tenants`, `users`, `clients`, `conversations`, `messages`, `calls`, `bookings`, `integrations`, `usage_events`
- `/api/lib/db.js` — a tiny Supabase client wrapper
- Refactor the in-memory `memory.set()` in `telnyx-sms.js` and the demo `resolveTenant()` in voice/sms/numbers to read from Supabase by called number

**Env vars added:**
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY` (server-side only)

**Verification:** call your Lola number, hang up, call again — Lola remembers the previous conversation. Today she forgets on cold start.

---

### Phase 2 — Stripe billing · ~3 hours
**Why second:** turns "free trial" into "real revenue." Needed before you onboard another salon.

**What to build:**
- Stripe products: Solo $99, Starter $199, Pro $399, Med Spa $599, Enterprise $999
- Stripe Checkout session at end of onboarding wizard
- `/api/stripe-webhook.js` — handles `checkout.session.completed`, `customer.subscription.updated`, `invoice.payment_failed`
- Update tenant row in Supabase with `stripe_customer_id`, `subscription_status`, `plan`, `trial_ends_at`
- Settings → Billing page reads from Supabase + Stripe Customer Portal link
- **Usage-based billing for numbers** ($5/month each) and **overage** (calls/SMS beyond plan) via Stripe metered subscriptions

**Env vars added:**
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_SOLO` / `STRIPE_PRICE_STARTER` / `STRIPE_PRICE_PRO` / `STRIPE_PRICE_MEDSPA` / `STRIPE_PRICE_ENTERPRISE`

**Verification:** complete onboarding → land on Stripe Checkout → enter test card 4242 4242 4242 4242 → land back on dashboard with active subscription showing in Settings.

---

### Phase 3 — WhatsApp · ~2 hours
**Why third:** salons (and especially med spas) ask for it constantly. After Phase 1+2 you have storage for threads and billing for usage.

**Two real paths — pick one:**

**Option A: Telnyx WhatsApp** (cleanest fit since you already use Telnyx)
- Telnyx Portal → Messaging → WhatsApp → onboard your Meta Business account
- Reuse the existing `/api/telnyx-sms.js` shape — Telnyx routes WhatsApp inbound to a webhook too
- Add `/api/telnyx-whatsapp.js` mirroring the SMS handler

**Option B: Meta WhatsApp Cloud API direct**
- Meta Business → WhatsApp Business → get a phone number ID + access token
- Build `/api/whatsapp-meta.js` with their webhook signature verification
- More work but no Telnyx markup on WhatsApp

**Recommendation:** Option A. Same vendor relationship, faster ship, similar margins. Switch to B later if WhatsApp volume justifies it.

**Env vars added (Option A):**
- `TELNYX_WHATSAPP_PROFILE_ID`

**Verification:** WhatsApp Lola's number → she replies in WhatsApp → Inbox page shows the thread with a WhatsApp pill.

---

### Phase 4 — OAuth to booking platforms · ~4 hours each platform
**Why last:** real data needs real persistence (Phase 1) and the customer needs to be on a paid plan (Phase 2) before they hand over their Square account.

**Platforms in priority order:**
1. **Square** — biggest US salon footprint, free OAuth, well-documented. Highest priority. **Approval to publish in Square App Marketplace is the #1 distribution move for LolaDesk.**
2. **Vagaro** — second-biggest in our target market
3. **Boulevard** — luxury salons specifically, high LTV
4. **Mindbody** — bigger footprint but legacy API, slower to ship
5. **Shopify** — only if salons sell products (revenue extension, not core)

**What each integration includes:**
- OAuth flow: `/api/oauth/<platform>/authorize` → consent → `/api/oauth/<platform>/callback` → store tokens in Supabase `integrations` table (encrypted)
- Sync workers: pull appointments, clients, services on initial connect, then incremental updates via their webhooks
- Booker agent gets a real calendar tool — `getAvailability()`, `createBooking()`, etc.
- Settings → Integrations page shows real connection status from Supabase, not the mock today

**Env vars added per platform:**
- `SQUARE_APP_ID` + `SQUARE_APP_SECRET`
- `VAGARO_CLIENT_ID` + `VAGARO_CLIENT_SECRET`
- etc.

**Verification:** owner clicks "Connect Square" in Settings → Square consent screen → returns → Bookings page shows their real Square appointments.

---

## What we're explicitly NOT building (yet)

These came up in your paste but they're not the right call right now. Listing them so we both know they're parked, not forgotten:

- **Redis distributed sessions** — Vercel cold starts are real but Supabase row reads are fast enough until you have 50+ concurrent calls
- **Private APN cellular network for terminals** — that's PoS hardware territory, not relevant until LolaDesk sells physical devices
- **6-table pgcrypto SQL schema with HMAC-verified webhooks** — Supabase row-level security handles this without us hand-rolling crypto
- **"Aura" visualizer state machine** — the orb already breathes; over-engineering its state machine is a distraction

When/if any of these become real bottlenecks, we add them. Not before.

---

## Recommended next step

**Don't do all 4 phases at once.** Pick the one that unblocks revenue fastest.

For LolaDesk's stage right now: **Phase 1 (Supabase) + Phase 2 (Stripe) together** = real recurring revenue from any salon that signs up. Phase 3 and 4 follow once you have paying customers asking for them.

Phase 1 + 2 together: ~5 hours of build. Realistic to ship this week.
