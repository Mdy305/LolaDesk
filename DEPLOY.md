# Deploy LolaDesk — Git + Vercel

LolaDesk is already live at loladesk.com on Vercel. This is the reference for redeploying, adding env vars, or setting this up fresh in a new Vercel project.

## ⚠️ Key hygiene

Never put a real API key in code, in this repo, or in a chat/doc. Keys go in Vercel env vars only. If any key has ever been pasted somewhere outside Vercel's env var UI, rotate it:
- Anthropic: console.anthropic.com → Settings → API Keys → revoke + create new
- Telnyx: portal → Auth → API Keys → regenerate
- Stripe: dashboard → Developers → API keys → roll key
- ElevenLabs: profile → API Keys → regenerate
- Supabase service role key: Project Settings → API → reset

---

## First-time setup (new Vercel project)

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "LolaDesk"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/loladesk.git
git push -u origin main
```

### 2. Deploy to Vercel
1. vercel.com → **Add New → Project** → **Import** your repo
2. Framework preset: **Other** (static HTML + serverless functions in `api/`, no build step)
3. Click **Deploy**

Or from the terminal: `npx vercel --prod`

### 3. Set environment variables
In Vercel → your project → **Settings → Environment Variables**, add every variable listed in `.env.example` — that file is the single source of truth for what this codebase actually reads from `process.env`. At minimum, for the app to do anything real beyond static pages: `ANTHROPIC_API_KEY` (or `LLM_PROVIDER=telnyx` + `TELNYX_API_KEY`), `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.

For Lola to sound like Lola on calls (not a generic fallback voice): `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID`.

For any booking-platform OAuth (Square, Boulevard, Shopify, Google Calendar): `INTEGRATION_ENCRYPTION_KEY` **must** be set before the first connection, or tokens have nowhere safe to be written.

Set each variable for Production, Preview, and Development, then **redeploy** (Deployments → ⋯ → Redeploy) so functions pick up new values — Vercel does not hot-reload env vars into already-running functions.

### 4. Point your domain
Vercel → **Settings → Domains** → add `loladesk.com` → paste the DNS records it gives you into your registrar. SSL is automatic.

---

## What's live after deploy

| URL | Page |
|-----|------|
| `loladesk.com/` | Marketing homepage (`index.html`) |
| `loladesk.com/start` | Onboarding wizard (rewrites to `onboarding.html` — see `vercel.json`) |
| `loladesk.com/dashboard` | The dashboard (rewrites to `dashboard.html`) |
| `loladesk.com/api/lola` | Dashboard chat → LLM proxy |
| `loladesk.com/api/telnyx-voice` | Real phone calls land here (set as your Telnyx TeXML app's Voice URL) |
| `loladesk.com/api/telnyx-sms` | Real texts land here (set as your messaging profile's inbound webhook) |
| `loladesk.com/api/billing/webhook` | Stripe events land here (set as your Stripe webhook endpoint) |
| `loladesk.com/api/oauth/callback` | Booking-platform OAuth redirects land here |

`vercel.json` pins `maxDuration: 10` for all functions — safe on Vercel's Hobby plan. **If you're on a paid plan and see phone-call timeouts** (ElevenLabs synthesis + an LLM call can occasionally run long), raise this to 30–60 in `vercel.json`; that's a one-line change, just don't set it above what your current plan tier allows or the deploy will fail outright (this is exactly what happened once before — see git history).

---

## Routine after first setup

```bash
git add .
git commit -m "what changed"
git push
```
Vercel auto-deploys within seconds. Pull requests get their own preview URLs — useful for testing schema or pricing changes before they hit real salons.
