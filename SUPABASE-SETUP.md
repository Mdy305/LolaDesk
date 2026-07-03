# Supabase Multi-Tenant Setup

LolaDesk is now multi-tenant. Each salon is a row in `tenants`, identified by the phone number they own. When a call or text comes in, we look up the tenant by the called number, load their context, and Lola handles the conversation with persistent memory.

## What changed
- **New file:** `schema.sql` — the database schema (tenants, clients, conversations, messages, calls, bookings, integrations, usage_events) including `opted_out`/`opted_out_at` on `clients` for SMS compliance
- **New file:** `api/lib/db.js` — shared Supabase client + tenant resolution helpers, encrypted integration read/write, opt-out helpers
- **New file:** `api/lib/crypto.js` — AES-256-GCM encryption for OAuth tokens at rest (requires `INTEGRATION_ENCRYPTION_KEY` — see `.env.example`)
- **Updated:** `api/telnyx-voice.js` — resolves tenant by called number, loads/saves conversation memory, speaks replies in Lola's real ElevenLabs voice
- **Updated:** `api/telnyx-sms.js` — same multi-tenant flow for SMS, plus STOP/HELP/START compliance handling
- **Updated:** `package.json` — adds `@supabase/supabase-js` dependency, pins Node engine

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

After this works, see `ROADMAP.md` for what's left — Stripe billing, OAuth token encryption, and SMS compliance are now done; what remains is wiring the Settings UI to the already-built integrations, usage-based billing enforcement, and WhatsApp.

## If you connect any booking platform (Square, Boulevard, Shopify, Google Calendar)

Their OAuth tokens are encrypted before they ever reach this database — set `INTEGRATION_ENCRYPTION_KEY` in Vercel (see `.env.example` for how to generate one) before connecting your first integration. Without it, OAuth connections will fail loudly rather than silently storing plaintext tokens.

---

## Complete run order (verified against Postgres 16)

The whole stack below was executed top-to-bottom on a clean PostgreSQL 16
instance — twice, to prove idempotency — with **zero errors**, and every
write pattern the code performs (signup's tenant insert, Settings'
`knowledge` update, both `client_memories` upsert conflict targets, and
every new table's insert shape) was executed verbatim and passed.

Run these in the Supabase SQL Editor, in this order (each is safe to re-run):

1. `schema.sql`
2. `billing-migration.sql`
3. `migrations/20260623_orchestrator_audit.sql`
4. `migrations/20260623_tenant_users.sql`
5. `migrations/20260624_lola_photo_campaigns_schema.sql`
6. `migrations/20260624_tenant_number_ports.sql`
7. `migrations/20260626_operator.sql`
8. `migrations/20260701_complete_supabase_wiring.sql`  ← **the completion migration**

If your Supabase project already ran 1–7, just run **8** — it closes every
gap: the tenant columns signup/Settings write (`website_url`,
`business_mode`, `knowledge`, `billing_status`, plus Lola's optional salon
config columns), the six tables live code uses that were never defined
(`client_memories`, `demo_requests`, `deposits`, `waitlist_entries`,
`satisfaction_surveys`, `callback_requests`), RLS on all of them (plus
`jobs`/`orchestrator_audit`, which were created without it), and the
`voice-audio` Storage bucket with public read.

**Why `client_memories` matters most:** every SMS and voice interaction
calls `setClientMemory(...)` — before migration 8, those writes failed
silently and Lola forgot every caller. After it, memory persists per
client per tenant, and the dashboard shares the same substrate (owner
memory under the `'owner'` key + dashboard conversations in the same
`conversations`/`messages` tables as calls and texts).

Note: migration 5 previously contained three bugs — `CREATE POLICY IF NOT
EXISTS` (syntax Postgres doesn't support, so the file died partway on
every run), non-idempotent `CREATE INDEX`/`CREATE TRIGGER` statements, and
RLS policies comparing `tenant_id` to the string literal
`'tenant_id'::UUID` (an operator-precedence bug that would error at query
time). All three are fixed in the file itself.
