# Operator "Jarvis" — setup & deploy

Owner-facing voice control for LolaDesk. The owner talks to Lola to run the
salon: read the day, find revenue, flag rebookings, move/cancel appointments,
and text clients — all gated behind a shared secret + a spoken PIN.

It reuses your existing stack: **Telnyx** hosts the voice loop, **Vercel**
serves the tool webhooks, **Supabase** holds the data and the owner gate.

## Files in this feature

| File | Purpose |
|------|---------|
| `migrations/20260626_operator.sql` | Adds `operator_phone` + `operator_pin_hash` to `tenants`. |
| `api/lib/operator-db.js` | Privileged queries, owner gate, HMAC confirm tokens. |
| `api/operator-tools.js` | The webhook the assistant calls (`{tool, ...args}`). |
| `api/operator-provision.js` | Creates/updates the Telnyx operator assistant + tools. |
| `api/operator-setup.js` | Owner sets their operator phone + PIN. |

## 1. Environment variables (Vercel → Settings → Environment Variables)

Already present: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `TELNYX_API_KEY`,
`TELNYX_VOICE_ID`, `APP_URL`.

Add one new secret — this is what stops the public from calling the privileged webhook:

```
OPENSSL_OUTPUT=$(openssl rand -hex 32)   # generate, then set:
OPERATOR_TOOLS_SECRET=<that value>
```

## 2. Run the migration

Supabase → SQL editor → paste `migrations/20260626_operator.sql` and run
(idempotent). Or:

```bash
psql "$DATABASE_URL" -f migrations/20260626_operator.sql
```

## 3. Deploy

These are standard Vercel serverless functions under `api/`, identical in shape
to `api/lola-tools.js`, so they deploy with no config changes:

```bash
git add -A && git commit -m "feat: owner-facing operator (Jarvis) voice control"
git push origin feat/operator-jarvis     # open a PR, or push to your deploy branch
```

## 4. Set the owner's PIN + phone

Signed in as the owner (Supabase Bearer token):

```bash
curl -X POST "$APP_URL/api/operator-setup" \
  -H "Authorization: Bearer <owner_access_token>" \
  -H "Content-Type: application/json" \
  -d '{ "operator_phone": "+13055551234", "pin": "4827" }'
```

No PIN set ⇒ destructive voice actions are refused by design.

## 5. Provision the operator assistant in Telnyx

```bash
curl -X POST "$APP_URL/api/operator-provision" \
  -H "Content-Type: application/json" \
  -d '{ "tenant": { "slug": "mma-salon", "name": "MMA Salon", "owner_name": "Meddy" } }'
```

This creates a second Telnyx AI Assistant ("Lola Ops — …") whose tools POST to
`/api/operator-tools` with the `x-lola-operator-secret` header. The `slug` is
embedded in every tool call so the webhook resolves the right salon.

> Telnyx's tool JSON schema changes over time. If the provision call rejects a
> tool field, add the tools by hand in the Telnyx portal pointing at
> `$APP_URL/api/operator-tools` — the webhook contract (`{ tool, ...args }` +
> secret header) is what's stable.

## 6. Give the owner a way to talk to it

- **Simplest:** assign a private Telnyx number to the assistant via a TeXML
  Voice App (the owner's "operator line"). Set that number as the owner's
  `operator_phone` in step 4.
- **Best audio:** use Telnyx's WebRTC / in-app media path for 16 kHz HD voice
  instead of the 8 kHz phone line — ideal for a push-to-talk button in the
  dashboard.

## How the confirmation flow works

Destructive tools (`move_appointment`, `cancel_appointment`, `broadcast_text`)
are two-phase:

1. The assistant calls the tool **without** `confirm`. The webhook resolves the
   exact action, returns a spoken summary and a signed `confirm_token`.
2. The assistant reads the summary back and asks for the **PIN** + "confirm".
3. The assistant calls the **same tool** with `confirm: true`, the
   `confirm_token`, and the spoken `pin`. The webhook verifies the token (HMAC,
   5-min expiry) and the PIN, then executes.

No pending-action state is stored server-side — the token is the source of truth.

## Quick local smoke test

```bash
# preview (no confirm) — should return needs_confirmation + a token
curl -s -X POST "$APP_URL/api/operator-tools" \
  -H "Content-Type: application/json" \
  -H "x-lola-operator-secret: $OPERATOR_TOOLS_SECRET" \
  -d '{ "tool": "whats_my_day", "tenant": "mma-salon", "date": "today" }'
```

## Notes / follow-ups

- `move`/`cancel` update the internal `bookings` row. If a booking also lives in
  an external system (`external_source`), the spoken reply flags it; wiring
  cancel/update through the connectors (`api/lib/connectors/*`) is a follow-up,
  as those currently expose list/create only.
- `broadcast_text` sends inline up to 200 recipients. For larger blasts, route
  through the existing `jobs/worker.js` queue instead of sending in-request.
