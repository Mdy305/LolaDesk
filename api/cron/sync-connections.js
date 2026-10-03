/**
 * /api/cron/sync-connections — daily reconciliation of tenant_numbers vs Telnyx
 * ════════════════════════════════════════════════════════════════════════
 * Fired by Vercel Cron (see vercel.json `crons`). Requires CRON_SECRET:
 * Vercel sends `Authorization: Bearer <CRON_SECRET>` on cron GETs; we also
 * accept POST with the same header for manual runs.
 *
 * Every run fetches Telnyx's LIVE per-number attachments and writes them
 * back into tenant_numbers.connection_id, so the routing table never drifts
 * from what Telnyx actually reports — the operator panel stops showing
 * stale 'mismatch' rows even if nobody clicks "Sync from Telnyx".
 *
 * This is the same logic as the admin panel's sync action (shared
 * lib/connection-sync.js) — one implementation, two transports.
 */

import { db } from '../lib/db.js';
import { syncTenantConnections, liveTelnyxSnapshot } from '../lib/connection-sync.js';
import { wireTenantNumbers } from '../lib/tenant-wiring.js';
import { wireAccount } from '../lib/telnyx-account.js';

function authorized(req) {
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${process.env.CRON_SECRET}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET/POST only' });

  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ ok: false, error: 'CRON_SECRET is not set — sync-connections cron is disabled' });
  }
  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const client = db();
  if (!client) return res.status(503).json({ ok: false, error: 'Database not configured' });

  const started = Date.now();
  // Heal first (every salon's number on the messaging profile + Lola's voice line), then record truth.
  try { await wireAccount(client, { heal: true }); } catch (_) { /* the account check never blocks the salon sweep */ }
  // One voice everywhere: any assistant that drifted to another voice goes back to Lola's own.
  try { const { unifyAssistantVoices } = await import('../lib/one-voice.js'); await unifyAssistantVoices({ heal: true }); } catch (_) {}
  let instagram = null;
  try { const { refreshInstagramTokens } = await import('../lib/instagram-dm.js'); instagram = await refreshInstagramTokens(client); } catch (_) {}
  // Facebook Messenger: Page tokens still work and Pages are still subscribed (re-subscribe when not).
  let messenger = null;
  try { const { checkMessengerPages } = await import('../lib/messenger-dm.js'); messenger = await checkMessengerPages(client); } catch (_) {}
  // WhatsApp: numbers newly on a WhatsApp Business Account → their salon; Meta's template verdicts.
  let whatsapp = null;
  try {
    const wa = await import('../lib/whatsapp-setup.js');
    const s = await wa.syncWhatsApp(client);
    const t = await wa.syncTemplateStatuses(client);
    whatsapp = { ok: s.ok, matched: (s.matched || []).length, unmatched: (s.unmatched || []).length, conflicts: (s.conflicts || []).length, templates_updated: t.updated };
  } catch (_) {}
  const snapshot = await liveTelnyxSnapshot();
  let wiring = null;
  try { wiring = snapshot.error ? null : await wireTenantNumbers(client, { heal: true, snapshot }); } catch (e) { wiring = { ok: false, error: String(e?.message || e) }; }
  const result = await syncTenantConnections(client, snapshot.error ? {} : { snapshot: await liveTelnyxSnapshot() });
  return res.status(result.ok ? 200 : 502).json({
    ok: result.ok,
    error: result.ok ? null : result.error,
    updated: result.updated,
    unchanged_count: (result.unchanged || []).length,
    not_found_on_telnyx: result.not_found_on_telnyx || [],
    connection_names: result.connection_names || {},
    wiring: wiring ? { ok: wiring.ok, broken: wiring.broken, healed: wiring.healed, messaging_profile: wiring.messaging_profile } : null,
    instagram,
    messenger,
    whatsapp,
    duration_ms: Date.now() - started,
    generated_at: new Date().toISOString()
  });
}
