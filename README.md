# LolaDesk — AI Front Desk for Salons & Spas

The complete, working dashboard product. This is what each salon logs into.

## What this is

A multi-tenant SaaS dashboard where a salon owner runs their entire front desk through Lola — an AI that answers calls, books appointments, replies across every channel, and surfaces revenue opportunities. Built to be sold on Square, Mindbody, Vagaro, Fresha, and direct.

## Files

| File | Purpose |
|------|---------|
| `landing.html` | **Marketing site** — the front door for loladesk.com. Hero, features, pricing, comparison. Drives signups. |
| `onboarding.html` | **Setup wizard** — 5-step flow: salon details → connect platform → services → Lola's personality → plan + go live. Hands config to the dashboard. |
| `index.html` | **The dashboard** — what each salon logs into daily. Lola orb, schedule, insights, live call, inbox, revenue, team, command bar, mobile nav, chat overlay |
| `app.js` | The engine — orb animation, voice in/out, charts, Lola AI brain, multi-tenant config resolver |
| `lola-proxy-worker.js` | Cloudflare Worker that hides your API key and meters usage for billing |

## The full flow

```
landing.html  →  onboarding.html  →  index.html
(stranger)       (signs up,           (their live
                  configures Lola)      dashboard)
```

A visitor lands on `landing.html`, clicks "Start free trial", walks through `onboarding.html` (which collects their salon name, services, persona, and plan), and lands in `index.html` with their own Lola fully configured. The onboarding wizard saves the tenant config to `sessionStorage` and the dashboard reads it on load — so the same code becomes any salon's product.



## Run it locally

```bash
cd loladesk-app
python3 -m http.server 8080
# open http://localhost:8080/landing.html  → walk the full flow
# or http://localhost:8080/index.html       → jump straight to the dashboard
```

Everything works immediately except live AI responses, which need an API key (see below).

## Make Lola's brain live

**Never put the API key in the browser.** Deploy the proxy:

```bash
npm install -g wrangler
wrangler login
wrangler secret put ANTHROPIC_API_KEY    # paste your key
wrangler deploy
```

Then before `app.js` loads, set the endpoint:

```html
<script>
  window.__LOLADESK_API__ = 'https://your-worker.workers.dev';
</script>
<script src="app.js"></script>
```

That's it — Lola is now live, secure, and billable.

## Multi-tenant: one codebase, every salon

Each salon is just a config object. Before `app.js` loads, inject their tenant:

```html
<script>
window.__LOLADESK_TENANT__ = {
  id: 'glow-medspa',
  name: 'Glow Med Spa',
  owner: 'Dr. Chen',
  location: '450 Park Ave, New York',
  phone: '+12125550100',
  bookingUrl: 'https://glowmedspa.com/book',
  whatsapp: 'https://wa.me/12125550100',
  persona: { name: 'Lola', energy: 'calm, clinical, reassuring luxury', voice: 'Karen' },
  services: [
    { name: 'Botox', price: 450, duration: '45m' },
    { name: 'Dermal Filler', price: 750, duration: '1h' },
    { name: 'Laser Resurfacing', price: 1200, duration: '1h 30m' }
  ],
  team: [
    { name: 'Dr. Chen', role: 'Medical Director', revenue: 48000, change: 22 }
  ]
};
</script>
```

The entire product — Lola's knowledge, the services menu, the team panel, the booking links, even her personality and voice — reconfigures from this one object. A med spa, a barbershop, and a luxury hair salon all run the same code with different configs.

## How each salon connects their booking system

`app.js` is written so the data arrays (`DATA.schedule`, `DATA.inbox`, etc.) get populated from the salon's existing platform:

- **Square** → `bookingsApi.listBookings()` fills the schedule
- **Mindbody** → `GET /appointment/appointments` fills the schedule
- **Vagaro / Fresha** → their REST endpoints map the same way

The webhook handler from your existing `lola-brain.js` already receives booking events — wire those to update `DATA` and re-render.

## How you make money

The proxy worker meters every Lola interaction per tenant. That's your billing hook:

- **Solo** $99/mo — chat + SMS, 1 platform
- **Starter** $199/mo — + unlimited SMS
- **Pro** $399/mo — + Telnyx voice + ElevenLabs + photo AI
- **Med Spa** $599/mo — + HIPAA-aware consultation flow
- **Enterprise** $999+/mo — + white-label + API + multi-location

Uncomment the KV metering lines in `lola-proxy-worker.js` to track usage and enforce plan limits.

## What's real vs. what's wired for demo

**Real and working now:** the entire UI, the orb animation, voice input (Web Speech), voice output (Speech Synthesis), all charts, the chat overlay, the command bar, mobile layout, keyboard shortcuts, the multi-tenant config system, and Lola's full AI brain (once the key is set).

**Wired for demo, connect to go live:** the schedule / inbox / team data is sample data in `DATA`. Point these at the salon's Square/Mindbody/Vagaro API and the dashboard becomes their real operational cockpit.

## Brand

- Fonts: Inter + Cormorant Garamond (Google Fonts, free)
- Icons: inline SVG (no dependency)
- No templates, no UI kit, no licences — 100% original code
