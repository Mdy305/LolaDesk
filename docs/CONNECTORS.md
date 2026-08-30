# LolaDesk Booking Connectors — the open-source sync layer

LolaDesk synchronizes with **any booking system** — Square, Vagaro, Mindbody,
Boulevard, Fresha, Google Calendar, and whatever comes next. The whole promise
is one line: *a new booking system is a new file that conforms to a contract*.
This document is that contract.

The sync flow:

```
[Booking provider] ──listAppointments()──▶ [cached_availability] ◀──fast-read── [Lola voice / web]
        ▲                                          │
        └────────────createAppointment()───────────┘          (bookings commit upstream)
```

- The **cron** (`api/cron/sync-availability.js`) polls every connected provider
  once a minute and upserts normalized appointments into `cached_availability`.
- The **voice and web booking engines** fast-read that cache — no live provider
  round-trip on a call.
- A **book** in LolaDesk commits upstream via `createAppointment()`.

---

## The contract

Every connector in `api/lib/connectors/` must export exactly these 7 members.
A suite (`tests/connector-contract.test.mjs`) proves conformance automatically
the moment a new file lands — a connector that breaks the contract fails CI.

| Export | Signature | Purpose |
|---|---|---|
| `META` | `{ name, description, status, docs }` | Registry metadata. `status`: `available` or `pending_partner_approval` |
| `getAuthUrl` | `(state) → url \| throws` | OAuth start URL for the connect flow |
| `exchangeCode` | `(code) → Promise<{access_token, refresh_token, expires_at, raw}>` | Swap the OAuth code for tokens |
| `refreshToken` | `(refresh_token) → Promise<token response>` | Token refresh |
| `listAppointments` | `(integration, { from, to }) → Promise<Appointment[]>` | Pull the provider's calendar |
| `createAppointment` | `(integration, appointment) → Promise<Appointment>` | Commit a booking upstream |
| `listClients` | `(integration, { limit }) → Promise<Client[]>` | Pull clients for the CRM |

### The normalized `Appointment` shape

Every connector maps its provider's API to this exact shape — this is what
`cached_availability` and booking-brain consume:

```js
{
  id:           'provider-side id',          // String, required (unique per provider)
  starts_at:    '2026-09-01T10:00:00Z',      // ISO string, required
  ends_at:      '2026-09-01T10:45:00Z',      // ISO string (fallback: starts_at + duration_min)
  duration_min: 45,                          // Number
  client:       { name: 'Jane', phone: null, email: null },
  service:      'Haircut' | null,
  stylist:      'provider staff id/name' | null,
  status:       'booked' | 'cancelled' | 'completed',   // normalized lowercase
  raw:          {/* provider's original object */}
}
```

### Failure conventions

- **Hard failures** (network, auth, bad request) → `throw new Error('…')`.
  The sync engine records the message in `booking_sync_log.error_message`.
- **Graceful stub** → connectors whose provider requires partner approval
  (e.g. Boulevard) return `{ ok:false, error:'…', _stub:true }` when their
  credentials aren't configured, so the whole platform keeps working while
  the partner application is pending. `META.status` should read
  `pending_partner_approval` in that state.
- **Never resolve `undefined`.** A silent success hides a broken integration.

---

## Adding a new booking system in 3 steps

1. **Create `api/lib/connectors/your-provider.js`** implementing the 7 members
   above. Copy `square.js` as the skeleton — it's the reference implementation.

2. **Register it** in `api/lib/aggregator.js`:

   ```js
   import * as yours from './connectors/your-provider.js';
   const CONNECTORS = { …, yours: yours };
   ```

   Registration is all the wiring there is: the sync cron, the connect flow,
   and the booking write-back pick it up automatically.

3. **Run the contract test**:

   ```bash
   node tests/connector-contract.test.mjs
   ```

   Green means it conforms. Then pin your provider's normalized mapping with
   a mocked-fetch test in `tests/connector-contract.test.mjs` (Square and
   Vagaro are already pinned there — copy those tests).

### Connect flow (OAuth)

The platform's connect screen uses the same contract:

```
/api/oauth/start?provider=yours    → getAuthUrl(state)    → redirect to provider
/api/oauth/callback?provider=yours → exchangeCode(code)   → store tokens on integrations
```

---

## Current connectors

| Provider | Status | Notes |
|---|---|---|
| Square | available | Appointments + Customers + Items |
| Vagaro | available | |
| Mindbody | available | |
| Fresha | available | |
| Booksy | beta | Partner-gated — RSA JWT-assertion auth (no browser OAuth). Operator attaches a tenant's `business_id` via `POST /api/admin/booksy`; the sync cron then scopes `/business/<business_id>/appointment/` with a platform-minted token |
| Google Calendar | available | |
| Boulevard | pending_partner_approval | Requires partner approval before activation |
| Shopify | available | Retail-only — deliberately **not** polled by the sync cron (no appointments API) |

## Also in the repo

- `api/lib/booking-sync.js` — the ingestion engine: poll → normalize → upsert →
  prune → audit log. Exports `syncTenantAvailability()` and
  `checkProviderDrift()`.
- `api/lib/aggregator.js` — registry + `writeAppointment()` (write-back).
- `migrations/20260816_booking_sync.sql` — `cached_availability` +
  `booking_sync_log` (+ `external_appointments` view).
