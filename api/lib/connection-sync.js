/**
 * api/lib/connection-sync.js — reconcile tenant_numbers against LIVE Telnyx
 * ════════════════════════════════════════════════════════════════════════
 * ONE implementation, two transports (the codebase's "one skill layer,
 * many surfaces" convention):
 *
 *   • /api/admin/numbers  → operator clicks "Sync from Telnyx"
 *   • /api/cron/sync-connections → Vercel Cron runs it daily so the routing
 *                                   table never drifts from Telnyx truth
 *
 * `syncTenantConnections` writes Telnyx's REAL per-number attachment id back
 * into tenant_numbers.connection_id (and clears stale ids Telnyx no longer
 * reports). Read-only against Telnyx; only tenant_numbers rows are mutated.
 * Routing itself keys off tenant_id + status, so this never affects whether
 * a call answers — it keeps the health record honest.
 */

import { listTenantNumberRoutes } from './db.js';
import { telnyxData, telnyxRequest } from './telnyx-client.js';

// Known-good connections: the working voice app + the LolaBrain assistant.
// Any connection Telnyx reports as attached to an account number is added at
// compare time by the live snapshot, because a number on an AI-assistant
// connection is on the native LolaBrain path, not drift.
export function knownGoodConnectionIds() {
  const ids = new Set();
  if (process.env.TELNYX_VOICE_APP_ID) ids.add(process.env.TELNYX_VOICE_APP_ID);
  if (process.env.TELNYX_LOLA_BRAIN_ID) ids.add(process.env.TELNYX_LOLA_BRAIN_ID);
  return ids;
}

// One live Telnyx snapshot: numbers with their REAL connection id, plus the
// connection/assistant id → name map so callers can say "LolaBrain" /
// "LolaDesk" instead of raw ids. Fails soft with a single `error` string.
export async function liveTelnyxSnapshot() {
  try {
    const [numbersList, connsList, asstsList] = await Promise.all([
      telnyxRequest('/phone_numbers', { query: { 'page[size]': 100 }, timeoutMs: 8000 }),
      telnyxRequest('/connections', { query: { 'page[size]': 100 }, timeoutMs: 8000 }).catch(() => ({ data: [] })),
      telnyxRequest('/ai/assistants', { query: { 'page[size]': 50 }, timeoutMs: 8000 }).catch(() => ({ data: [] }))
    ]);
    const numbers = (Array.isArray(telnyxData(numbersList)) ? telnyxData(numbersList) : []);
    const nameById = new Map();
    for (const c of (Array.isArray(telnyxData(connsList)) ? telnyxData(connsList) : [])) {
      nameById.set(c.id, c.connection_name || c.friendly_name || c.name || null);
    }
    for (const a of (Array.isArray(telnyxData(asstsList)) ? telnyxData(asstsList) : [])) {
      nameById.set(a.id, a.name || null);
    }
    const byPhone = new Map();
    for (const n of numbers) {
      byPhone.set(n.phone_number, {
        connection_id: n.connection_id || null,
        connection_name: nameById.get(n.connection_id) || null,
        status: n.status || null
      });
    }
    return { numbers, byPhone, nameById, error: null };
  } catch (e) {
    return { numbers: [], byPhone: new Map(), nameById: new Map(), error: String(e?.message || e) };
  }
}

/**
 * Write Telnyx's LIVE attachment back into the routing table.
 * @param {object} client — Supabase client (db())
 * @param {{ snapshot?: object }} opts — inject a snapshot for tests
 * @returns {{ ok: boolean, error?: string, updated: Array, unchanged: Array,
 *             not_found_on_telnyx: Array, connection_names: object }}
 */
export async function syncTenantConnections(client, opts = {}) {
  const live = opts.snapshot || await liveTelnyxSnapshot();
  if (live.error) return { ok: false, error: live.error, updated: [], unchanged: [], not_found_on_telnyx: [], connection_names: {} };

  const routes = await listTenantNumberRoutes(500);
  const updated = [];
  const unchanged = [];
  const notFound = [];
  for (const r of (routes || [])) {
    const liveRow = live.byPhone.get(r.phone_number);
    if (!liveRow) {
      notFound.push(r.phone_number);
      continue;
    }
    const liveId = liveRow.connection_id || null;
    if (liveId && liveId !== r.connection_id) {
      const { error } = await client.from('tenant_numbers')
        .update({ connection_id: liveId, updated_at: new Date().toISOString() })
        .eq('phone_number', r.phone_number);
      if (!error) {
        updated.push({
          phone_number: r.phone_number,
          from: r.connection_id || null,
          to: liveId,
          connection_name: liveRow.connection_name
        });
      }
    } else if (!liveId && r.connection_id) {
      // Telnyx says unattached but the table records one — clear the stale id
      // so the panel stops claiming a connection that isn't there.
      const { error } = await client.from('tenant_numbers')
        .update({ connection_id: null, updated_at: new Date().toISOString() })
        .eq('phone_number', r.phone_number);
      if (!error) updated.push({ phone_number: r.phone_number, from: r.connection_id, to: null, connection_name: null });
    } else {
      unchanged.push(r.phone_number);
    }
  }
  const nameMap = {};
  for (const [id, name] of live.nameById) nameMap[id] = name;
  return {
    ok: true,
    updated,
    unchanged,
    not_found_on_telnyx: notFound,
    connection_names: nameMap
  };
}
