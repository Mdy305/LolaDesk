# LolaDesk Telnyx Telecom Control Plane

This branch introduces one authenticated, tenant-aware API for managing LolaDesk communications infrastructure.

## Endpoints

All authenticated actions use `GET|POST /api/telecom?action=<action>` with a Supabase bearer token.

### Capability discovery

`GET /api/telecom?action=capabilities`

Probes the connected Telnyx account for number ordering, porting, SIM, mobile voice and AI Assistant access. The UI must hide or disable products the account cannot use.

### Number lifecycle

- `numbers.search` — search local/toll-free inventory by country, area code and features.
- `numbers.provision` — buy a number and attach default voice and messaging configuration.
- `numbers.list` — list account numbers.
- `routing.update` — attach a voice connection and/or messaging profile.

Provision request example:

```json
{
  "action": "numbers.provision",
  "phone_number": "+13055551234",
  "voice_connection_id": "optional-override",
  "messaging_profile_id": "optional-override"
}
```

### Porting lifecycle

1. Create draft: `ports.create`.
2. Collect and upload Telnyx-required documents and requirement values.
3. Poll `ports.list` and process `/api/telecom-webhook` events.
4. Confirm only after the order is complete: `ports.confirm`.
5. On completion, attach the ported number to Lola voice and messaging profiles.

The existing `/api/telnyx-porting` endpoint remains available during migration.

### SIM and mobile voice

- `sims.list` — list SIM inventory, including eSIMs when enabled for the account.
- `sims.activate` — asynchronously enable a SIM.
- `sims.enable_voice` — enable native voice and optionally associate a Mobile Voice Connection.
- `mobile_numbers.list` — list mobile phone numbers assigned to SIMs.

Never promise eSIM availability before the capability probe succeeds. Device, inventory, account and region restrictions apply.

### US messaging compliance

`compliance.assign_10dlc` assigns all numbers in a Messaging Profile to exactly one Telnyx or shared TCR campaign.

```json
{
  "action": "compliance.assign_10dlc",
  "messaging_profile_id": "uuid",
  "campaign_id": "uuid"
}
```

Use `tcr_campaign_id` instead of `campaign_id` for a shared external campaign; never send both.

## Required environment variables

- `TELNYX_API_KEY`
- `TELNYX_PUBLIC_KEY` — mandatory in production for webhook verification
- `TELNYX_VOICE_APP_ID`
- `TELNYX_MESSAGING_PROFILE`
- `APP_URL`
- Existing Supabase authentication variables used by `api/lib/auth.js`

## Security rules

- The Telnyx key never reaches the browser.
- Every control-plane action resolves the caller's tenant before execution.
- Webhooks verify the Telnyx Ed25519 signature and reject timestamps older than five minutes.
- Production must fail closed when `TELNYX_PUBLIC_KEY` is missing.
- Provisioning, port confirmation, SIM activation and campaigns should require explicit confirmation in the UI.
- Add durable event storage and idempotency before using webhook events for billing or irreversible state transitions.

## Product workflow

The Apple-level UI should expose a single Communications setup:

1. **Keep my number** or **Get a new number**.
2. Capability check runs invisibly.
3. New number: show three curated options, not raw inventory.
4. Port: scan bill, collect authorization, show a status timeline, and optionally activate a temporary number.
5. Staff line: offer physical SIM/eSIM only when supported.
6. Messaging: guide the business through 10DLC/toll-free verification before enabling campaigns.
7. Completion screen: test inbound call, outbound call, SMS and AI handoff.

## Remaining production work

- Add Telnyx document upload and porting requirement endpoints.
- Persist webhook events with unique `event_id` and retry-safe processing.
- Add spend limits, usage records, fraud thresholds and per-tenant metering.
- Add explicit tenant ownership records for every Telnyx resource.
- Add integration tests against a Telnyx test account and Vercel preview deployment.
