# LolaDesk — Vercel Deployment Fix

Your app was deployed but the build failed due to output directory configuration. Follow these steps to fix it:

## ✅ Quick Fix (Web Dashboard)

1. Go to: https://vercel.com/peskoi/loladesk/settings
2. Navigate to: **Settings → General → Output Directory**
3. Set to: `.` (dot/root)
4. Click **Save**
5. Go to **Deployments** → click the latest (with the red X)
6. Click **"Redeploy"** button in the top right

## Or: Via CLI

```bash
npx vercel project settings outputDirectory . --yes
npx vercel --prod --yes
```

## What's Happening

LolaDesk is a static HTML + serverless functions app (no build step). The issue is that Vercel expects files in an output directory (usually `public/` or `dist/`), but all your files are in the root.

Solution: Tell Vercel the output directory IS the root (`.`)

---

## After Deployment

Once the build succeeds (green checkmark), you'll see:

```
✅ Production: https://loladesk-*.vercel.app
```

Then add your environment variables:

1. Go to: https://vercel.com/peskoi/loladesk/settings/environment-variables
2. Add each variable from your `.env.local`:
   - `TELNYX_API_KEY`
   - `ELEVENLABS_API_KEY`
   - `ELEVENLABS_VOICE_ID`
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - etc.
3. Set scope to: **Production, Preview, Development**
4. Click **Save**
5. Go to **Deployments** → **Redeploy** (to pick up env vars)

---

## Webhook Configuration (Telnyx)

Once deployed, update your Telnyx webhooks:

1. **Voice Calls**:
   - Telnyx Console → Programmable Voice → Applications
   - Voice URL: `https://loladesk-*.vercel.app/api/telnyx-voice`

2. **SMS / WhatsApp**:
   - Telnyx Console → Messaging → Messaging Profiles
   - Inbound URL: `https://loladesk-*.vercel.app/api/telnyx-sms`

---

## Test Live

```bash
# Call your Telnyx number
# Or text it: "Book me a balayage tomorrow at 2pm"

# Expected: Lola responds in real time on production
```

---

## Current Status

✅ Code pushed to GitHub  
✅ Build triggered on Vercel  
⏳ **Awaiting: Output directory fix**  
⏳ **Awaiting: Environment variables**  
⏳ **Awaiting: Telnyx webhook configuration**
