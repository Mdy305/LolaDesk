/**
 * api/lib/release-numbers.js — Lola lines of salons that left go back to the pool.
 * ════════════════════════════════════════════════════════════════════
 * A salon whose service has been OFF (lib/service-gate.js: canceled, unpaid,
 * trial expired, suspended) for more than RELEASE_AFTER_DAYS (default 30):
 *   • every LolaDesk-owned line is detached: tenant_numbers.status = 'released'
 *     (the row stays — history), tenants.phone_number cleared, routing cache
 *     invalidated. The number stays on the Telnyx account with its connection,
 *     and freePlatformNumbers() (telnyx-provision.js) offers it to the next salon.
 *   • a number the salon PORTED IN is theirs: it is 'parked' (detached but never
 *     offered to another salon) so the owner can port it out or come back.
 *   • RELEASE_NOTICE_DAYS (default 7) before, the owner gets one heads-up text + email.
 * Never touches salons whose service is on. Never throws per salon.
 */
import { serviceStatus } from './service-gate.js';

const DAY = 864e5;
const digits = (v) => String(v || '').replace(/\D/g, '');

async function rows(q) { try { const r = await q; return r?.data || []; } catch { return []; } }

async function mem(c, tid, key) {
  try { const { data } = await c.from('client_memories').select('value').eq('tenant_id', tid).eq('client_phone', 'owner_alerts').eq('key', key).maybeSingle(); return data?.value ?? null; } catch { return null; }
}
async function setMem(c, tid, key, value) {
  try { await c.from('client_memories').upsert({ tenant_id: tid, client_phone: 'owner_alerts', key, value }, { onConflict: 'tenant_id,client_phone,key' }); } catch {}
}

/** When did this salon's service go off? (ISO / ms) — null when on or unknown. */
export function offSince(t, now = Date.now()) {
  const s = serviceStatus(t, now);
  if (s.ok) return null;
  const at = Date.parse(s.since || '');
  return Number.isFinite(at) ? at : null;
}

export async function runReleaseNumbers(c, { now = new Date(), env = process.env, notify = null, invalidate = null } = {}) {
  const afterDays = Math.max(1, Number(env.RELEASE_AFTER_DAYS) || 30);
  const noticeDays = Math.max(0, Number(env.RELEASE_NOTICE_DAYS ?? 7));
  // Releasing a salon's line is hard to undo: it only happens with RELEASE_NUMBERS_LIVE=1
  // (and BILLING_ENFORCE=1, see service-gate). Otherwise every run is a report.
  const dry = /^(1|true|yes)$/i.test(String(env.RELEASE_NUMBERS_DRY_RUN || '')) || String(env.RELEASE_NUMBERS_LIVE || '') !== '1';
  const out = { checked: 0, noticed: 0, released: 0, parked: 0, tenants: [], dry_run: dry, errors: [] };
  if (!c) return out;
  const nowMs = now.getTime();
  const tenants = await rows(c.from('tenants').select('*').limit(10000));
  const ports = await rows(c.from('tenant_number_ports').select('tenant_id,requested_phone_number,status').limit(10000));
  const ported = new Set(ports.filter((p) => String(p.status || '') === 'ported' || p.status === 'completed').map((p) => `${p.tenant_id}|${digits(p.requested_phone_number)}`));

  if (!notify) notify = async (t, text) => { const m = await import('./billing-enforce.js'); return m.notifyOwner(t, text, { subject: 'Your LolaDesk number will be released' }); };
  if (!invalidate) invalidate = async (n) => { try { const m = await import('./tenant-resolver.js'); m.invalidateRouting(n); } catch (_) {} };

  for (const t of tenants) {
    if (!t?.id) continue;
    const since = offSince(t, nowMs);
    if (since == null) continue;
    out.checked++;
    const offDays = (nowMs - since) / DAY;
    try {
      const lines = (await rows(c.from('tenant_numbers').select('*').eq('tenant_id', t.id).limit(50)))
        .filter((r) => r.phone_number && !['released', 'parked'].includes(String(r.status || '')));
      const all = [...lines.map((r) => r.phone_number)];
      if (t.phone_number && !all.includes(t.phone_number)) all.push(t.phone_number);
      if (!all.length) continue;

      // Heads-up, once, at least RELEASE_NOTICE_DAYS before — never a release without it.
      if (offDays < afterDays - noticeDays) continue;
      const key = 'number_release_notice';
      const notice = await mem(c, t.id, key);
      const noticedAt = Date.parse(notice?.at || '');
      if (!Number.isFinite(noticedAt)) {
        const releaseOn = Math.max(since + afterDays * DAY, nowMs + noticeDays * DAY);
        const when = new Date(releaseOn).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
        const app = String(env.APP_URL || 'https://www.loladesk.com').replace(/\/+$/, '');
        if (!dry) {
          await notify(t, `LolaDesk: Lola's line for ${t.name || 'your salon'} is paused, and on ${when} the number will be released. Pick a plan before then to keep it: ${app}/subscription`);
          await setMem(c, t.id, key, { at: now.toISOString(), release_on: new Date(releaseOn).toISOString() });
        }
        out.noticed++;
        continue;
      }
      if (offDays < afterDays || nowMs - noticedAt < noticeDays * DAY) continue;

      const done = [];
      for (const num of all) {
        const isPorted = ported.has(`${t.id}|${digits(num)}`) || lines.some((r) => r.phone_number === num && /ported/i.test(String(r.notes || '')));
        const status = isPorted ? 'parked' : 'released';
        if (dry) { done.push({ phone_number: num, status }); continue; }
        const row = lines.find((r) => r.phone_number === num);
        if (row) await c.from('tenant_numbers').update({ status, notes: `${status} ${now.toISOString().slice(0, 10)} — service off since ${new Date(since).toISOString().slice(0, 10)}` }).eq('tenant_id', t.id).eq('phone_number', num);
        else await c.from('tenant_numbers').insert({ tenant_id: t.id, phone_number: num, kind: 'primary', status, notes: `${status} ${now.toISOString().slice(0, 10)}` });
        try { await c.from('usage_events').insert({ tenant_id: t.id, kind: 'number_released', units: 1, metadata: { phone_number: num, status, off_since: new Date(since).toISOString() } }); } catch (_) {}
        await invalidate(num);
        done.push({ phone_number: num, status });
        if (isPorted) out.parked++; else out.released++;
      }
      if (!dry) {
        let r = await c.from('tenants').update({ phone_number: null, telnyx_phone_id: null, provisioning_status: 'released' }).eq('id', t.id);
        if (r?.error) await c.from('tenants').update({ phone_number: null }).eq('id', t.id);
      }
      out.tenants.push({ tenant: t.id, numbers: done });
    } catch (e) { out.errors.push({ tenant: t.id, error: String(e?.message || e).slice(0, 200) }); }
  }
  return out;
}

export default { runReleaseNumbers, offSince };
