# LolaDesk — Open Source

LolaDesk is the AI front desk for salons, med-spas and clinics — a phone
answering, booking, SMS and growth OS built on Telnyx, ElevenLabs and
Supabase, with Lola as the single canonical voice and brain that runs every
salon on the platform (one Lola, like Siri — never per-tenant clones).

This repository is the open-source core of the platform, licensed under the
**GNU Affero General Public License v3.0** (see [LICENSE](./LICENSE)).

## What's in this repo

- **The voice brain** — Lola's system prompt, tool definitions, agent
  orchestration (`api/lib/agent-orchestra.js`, `lola-resonance.js`), and the
  ElevenLabs/Telnyx voice runtime.
- **The booking engine** — multi-tenant availability, holds, booking, cancel,
  reschedule, confirmation codes, and a connector contract for Square, Vagaro,
  Booksy, Boulevard, Mindbody, Fresha and Google Calendar
  (`api/lib/booking-brain*.js`, `api/lib/booking-sync.js`,
  `api/lib/aggregator.js`).
- **The autonomous operations OS** — the Lola Autopilot
  (`api/lib/autopilot.js`): routing-heal, missed-call-recovery, rebooking and
  sync-self-heal agents that run the platform itself, every action recorded
  in the `agent_runs` ledger.
- **The open booking widget** — `booking-widget.js`: embed a salon's calendar
  on any website with a one-line snippet, with self-service booking and
  self-cancel by confirmation code.
- **The tenant web app** — dashboard, calls, inbox, clients, calendar,
  reviews, settings, and the operator Command screen (`admin.html`).
- **The schema** — every table, RLS policy and migration in
  `migrations/` (see `migrations/ALL_MIGRATIONS.sql` for the ordered,
  idempotent full script).

## Running it yourself

The static pages are plain HTML + vanilla JS served by any static host
(Vercel in production). The `api/` functions are Node ESM serverless
functions. The database is Supabase (Postgres + PostgREST + Auth).

1. Create a Supabase project and run `migrations/ALL_MIGRATIONS.sql` in the
   SQL editor.
2. Create a Telnyx account, buy/port numbers, build the LolaBrain AI
   assistant and wire the tools (see `TELNYX-SETUP.md`).
3. Set the environment variables (Supabase URL + service key, Telnyx API
   key, ElevenLabs key + the canonical Lola voice id, admin emails).
4. Deploy the repo root as a static site with the `api/` functions.

```
vercel deploy --prod
```

## The connector contract

Any booking provider can be added by implementing the connector interface in
`api/lib/aggregator.js` — `listAppointments(integration, { from, to })` —
normalizing appointments into the shared shape the sync engine writes to
`cached_availability`. That single contract is what makes a salon's real
calendar (Square, Booksy, Vagaro…) appear instantly in Lola's voice and the
widget.

## License

**AGPL-3.0** — you may run, modify and redistribute this software, and
self-host LolaDesk for your own business or your clients. If you offer it as
a network service to others, the AGPL requires that you share your modified
source with those users (the same rule LolaDesk itself follows). The Lola
voice and LolaBrain agent are the canonical platform identity — the open
source grants you the right to run them, not to resell a competing branded
Lola as your own product.

```
Copyright © 2026 LolaDesk
SPDX-License-Identifier: AGPL-3.0
```
