# LolaDesk — AI Front Desk for Salons & Spas

A multi-tenant SaaS where a salon owner runs their entire front desk through Lola — an AI that answers calls (in her real, custom ElevenLabs voice), texts, books appointments, and surfaces revenue opportunities. Built to be sold direct and listed on Square, Mindbody, Vagaro, and Fresha.

## Architecture — what's actually real

This is **not** a static demo. Every salon is a row in Supabase, isolated by Row Level Security, with their own phone number, services, persona, integrations, and conversation history.

```
Browser (static HTML/CSS/JS, no build step)
   ↓
Vercel serverless functions (api/*.js)
   ↓
Supabase (Postgres + Auth)     Telnyx (voice + SMS + numbers)     ElevenLabs (Lola's voice)
   ↓                                ↓                                  ↓
tenants · clients · conversations   inbound calls/texts route to    every spoken word, on
· messages · calls · bookings ·     /api/telnyx-voice and           calls AND in the
usage_events · integrations         /api/telnyx-sms by called #     dashboard, same voice
```

## Pages

| File | Purpose |
|------|---------|
| `index.html` | **Marketing homepage** — what loladesk.com serves at `/`. |
| `onboarding.html` | **Setup wizard** — salon details → connect platform → services → Lola's personality → plan → live. Calls `/api/auth/signup` and `/api/onboard`. |
| `dashboard.html` | **The dashboard** — what each salon logs into daily. Reads real data via `/api/data`. |
| `clients.html`, `calls.html`, `inbox.html`, `bookings.html`, `revenue.html`, `team.html`, `numbers.html`, `marketing.html`, `settings.html`, `agents.html` | Interior dashboard pages, each tenant-scoped via `/api/data`. |
| `login.html` | Returning owner sign-in. |
| `landing.html` | Alternate marketing page (not currently linked from main nav). |

## The API layer (`api/`)

| Path | What it does |
|------|---------------|
| `auth/signup.js`, `auth/login.js`, `auth/session.js` | Supabase Auth — creates the owner's account + their tenant row + 14-day trial. |
| `onboard.js` | Saves tenant details; if a website URL is given, the Marketer agent analyzes it and pre-fills services/positioning. |
| `telnyx-voice.js` | **Real phone calls.** Telnyx hits this on every call. Resolves tenant by called number, asks Lola's brain, speaks the reply in her real ElevenLabs voice via `<Play>` (falls back to a generic `<Say>` only if ElevenLabs fails), persists the conversation. |
| `telnyx-sms.js` | **Real texts.** Same tenant resolution + memory, plus STOP/HELP/START keyword compliance (10DLC) handled before Lola's AI ever sees the message. |
| `telnyx-numbers.js` | Search & buy phone numbers; auto-attaches voice + SMS on purchase. This is a recurring revenue line (see TELNYX-SETUP.md). |
| `telnyx-agents.js` | **Experimental, not yet wired to live calls.** Provisions a 7-agent team (Lola + 6 specialists) directly inside Telnyx's own AI Assistant product, as an alternative architecture to the custom TeXML+Claude loop above. No phone number currently routes to it — `agents.html`'s "copy Telnyx config" button exports this for manual import if you want to experiment with it. |
| `lola-tools.js` | The skill layer (check availability, book, quote pricing, capture leads, escalate) — what Lola's brain calls into to actually do things. |
| `lola.js` | Proxy the dashboard's browser-side chat uses to talk to the LLM without exposing API keys. |
| `speak.js`, `lib/elevenlabs.js` | Lola's real voice — shared between the dashboard chat and phone calls so she sounds identical everywhere. |
| `voice-audio.js`, `lib/tts-cache.js` | Serves the synthesized ElevenLabs audio at a URL Telnyx's `<Play>` can fetch. |
| `data.js` | Unified read API every dashboard page calls — tenant-scoped, with a small demo dataset fallback so the UI is never blank during setup. |
| `billing/checkout.js`, `billing/portal.js`, `billing/webhook.js`, `lib/stripe.js` | Stripe subscriptions — Checkout, customer portal, and a signature-verified webhook that activates/suspends tenants. |
| `oauth/connect.js`, `oauth/callback.js`, `lib/connectors/*.js` | OAuth to Square, Boulevard, Shopify, Google Calendar. Tokens are **encrypted at rest** (`lib/crypto.js`) — never stored in plaintext. |
| `lib/db.js` | The shared Supabase client + every multi-tenant helper (tenant resolution, client/conversation/booking writes, usage logging, encrypted integration storage). Everything else imports from here. |
| `lib/llm.js` | Shared LLM client — Telnyx Inference (Kimi-K2.6) by default, or Anthropic Claude directly if `LLM_PROVIDER=anthropic`. Resilient retry on empty responses. |
| `lib/auth.js` | Supabase Auth helpers (create user, sign in, verify bearer tokens). |
| `marketer.js`, `agent-variables.js`, `notifications.js` | Supporting agents/utilities — site analysis, templated prompt variables, in-app notifications. |

## Run it locally

```bash
python3 -m http.server 8080
# open http://localhost:8080/index.html — the marketing site
# open http://localhost:8080/dashboard.html — straight to the dashboard (demo data without env vars)
```

The `api/*.js` files are Vercel serverless functions and won't run under the plain Python server — use `vercel dev` for those, or just deploy to a Vercel preview to test the full stack.

## Deploy

See `DEPLOY.md` for the Git → Vercel flow, `SUPABASE-SETUP.md` for the database, `TELNYX-SETUP.md` for voice/SMS, and `.env.example` for the full list of environment variables this code actually reads — keep that file in sync if you add a new `process.env.X` anywhere.

## Multi-tenant: one codebase, every salon

Each salon is a row in the `tenants` table (see `schema.sql`), identified by the phone number they're assigned. Every inbound call or text resolves its tenant by the **called number**, loads that salon's services/persona/hours/integrations, and Lola responds accordingly — fully isolated from every other salon via Postgres Row Level Security plus tenant-scoped queries in application code.

To onboard a new salon: they sign up (`onboarding.html` → `/api/auth/signup`), pick a number (`numbers.html` → `/api/telnyx-numbers`), and Lola is live on that number immediately — no code changes, no redeploys.

## Brand

- Fonts: Inter + Cormorant Garamond (Google Fonts, free)
- Icons: inline SVG (no dependency)
- Voice: one consistent ElevenLabs voice for Lola everywhere — dashboard chat and real phone calls alike (see `api/lib/elevenlabs.js`)
