/**
 * api/lib/tenant-wiring.js — every salon's Telnyx line, wired end to end.
 * ════════════════════════════════════════════════════════════════════
 * LolaDesk is multi-tenant on one Telnyx account: each salon owns its own
 * number(s) in tenant_numbers; calls and texts are routed to the right salon
 * by the number they arrive on. For that to work, every salon number must be
 *   · on the platform's messaging profile  → texts in and out
 *   · on Lola's voice connection           → calls answered by Lola
 * Numbers bought before an env var existed, ported numbers, or numbers
 * re-pointed in the portal drift. This checks each one against Telnyx's live
 * state and (heal:true) re-attaches what's missing. Nightly via
 * /api/cron/sync-connections; on demand for one salon via "Lola, run a check".
 */
import { liveTelnyxSnapshot } from './connection-sync.js';
import { linkMessagingProfile, linkVoiceConnection } from './telnyx-provision.js';
import { messagingProfileId } from './telnyx-account.js';


export async function wireTenantNumbers(client, { tenantId = null, heal = false, snapshot = null } = {}) {
  const mp = await messagingProfileId(client);
  const live = snapshot || await liveTelnyxSnapshot();
  if (live.error) return { ok: false, error: live.error, numbers: [] };
  let q = client.from('tenant_numbers').select('*');
  if (tenantId) q = q.eq('tenant_id', tenantId);
  const { data: rows } = await q.limit(1000);
  const list = (rows || []).filter(r => r && r.phone_number && r.status !== 'released');
  // A salon with a number only on its tenant row still counts.
  if (tenantId && !list.length) {
    const { data: t } = await client.from('tenants').select('id,phone_number').eq('id', tenantId).maybeSingle();
    if (t?.phone_number) list.push({ tenant_id: t.id, phone_number: t.phone_number });
  }
  const out = [];
  for (const r of list) {
    const n = live.byPhone.get(r.phone_number);
    const row = { tenant_id: r.tenant_id, phone_number: r.phone_number, on_telnyx: !!n, texts: !!n?.messaging_profile_id, calls: !!n?.connection_id, healed: [] };
    if (n && heal && n.id) {
      if (!row.texts && mp) { try { if (await linkMessagingProfile(n.id, mp)) { row.texts = true; row.healed.push('texts'); } } catch (_) {} }
      if (!row.calls) { try { if (await linkVoiceConnection(n.id)) { row.calls = true; row.healed.push('calls'); } } catch (_) {} }
    }
    out.push(row);
  }
  const broken = out.filter(x => !x.on_telnyx || !x.texts || !x.calls);
  return { ok: !broken.length, numbers: out, broken: broken.length, healed: out.filter(x => x.healed.length).length, messaging_profile: !!mp };
}
