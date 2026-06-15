# Supabase Multi-Tenant Setup

LolaDesk is now multi-tenant. Each salon is a row in `tenants`, identified by the phone number they own. When a call or text comes in, we look up the tenant by the called number, load their context, and Lola handles the conversation with persistent memory.

## What changed
- **New file:** `schema.sql` — the database schema (tenants, clients, conversations, messages, calls, bookings, usage)
- **New file:** `api/lib/db.js` — shared Supabase client + tenant resolution helpers
- **Updated:** `api/telnyx-voice.js` — resolves tenant by called number, loads/saves conversation memory
- **Updated:** `api/telnyx-sms.js` — same multi-tenant flow for SMS
- **Updated:** `package.json` — adds `@supabase/supabase-js` dependency

## One-time setup (10 minutes)

### 1. Create the Supabase project
You said you already have `https://cfowesxlebbtyioplijt.supabase.co`. Open it.

### 2. Run the schema
- Supabase Dashboard → **SQL Editor** → **New query**
- Open `schema.sql` from this repo, paste the whole thing in
- Click **Run**
- You'll see all 7 tables created plus the seed row for MMΛ Salon

### 3. Get your service key (the sensitive one)
- Supabase Dashboard → **Project Settings** → **API**
- Find **service_role secret** (NOT the publishable key)
- Click reveal, copy the value (starts with `eyJ...`)
- **DO NOT paste it in chat, in code, or anywhere else** — only Vercel env vars

### 4. Add the two env vars to Vercel
- Vercel → your lola-desk project → **Settings** → **Environment Variables**
- Add `SUPABASE_URL` = `https://cfowesxlebbtyioplijt.supabase.co` (Sensitive: optional, this URL is safe to share)
- Add `SUPABASE_SERVICE_KEY` = your service_role key (Sensitive: YES)
- Both should apply to Production AND Preview
- **Redeploy** so the functions pick them up

## Verify it works

After redeploy:
- Call `+1-929-456-8227`
- Hang up after a few sentences
- Call again
- Lola should greet you with **"Welcome back!"** instead of "Hi, thanks for calling MMΛ Salon"

That's the magic moment. She remembers you because the conversation is now stored in `messages` and `conversations` tables.

You can verify in the Supabase dashboard:
- Table Editor → `tenants` → see MMΛ Salon row
- Table Editor → `clients` → see your phone number listed
- Table Editor → `conversations` → see your calls
- Table Editor → `messages` → see every turn

## How multi-tenant works now

Every API handler now does this on every request:
```js
const tenant = await getTenantByPhone(toNumber);
// tenant is the salon that owns the number that was called/texted
```

To add a second salon:
1. Insert a new row in `tenants` with their phone number (E.164)
2. They buy that number via `/numbers` page (Telnyx auto-attaches the voice app and messaging profile)
3. Done — calls to that number route to their Lola, with their services, their team, their persona

## Graceful fallback

If `SUPABASE_URL` or `SUPABASE_SERVICE_KEY` aren't set, `db()` returns `null` and the handlers fall back to a demo tenant. **Nothing crashes**, but multi-tenant is off. So you can deploy this code BEFORE setting env vars and the app keeps working; multi-tenant turns on the moment Vercel sees the env vars.

## What's next

After this works:
- **Phase 2 of ROADMAP.md** — Stripe billing (5 plan tiers, usage metering against `usage_events`)
- **Phase 3** — WhatsApp (already laid out)
- **Phase 4** — OAuth to Square / Vagaro / Boulevard (writes to `integrations` table)
