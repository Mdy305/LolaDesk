/**
 * api/lib/square-care.js — every Square connection stays healthy and in sync, for every salon.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *   squareDaily(c)            → renew tokens (Square: every ≤7 days), check what each salon allowed,
 *                               re-match stylists/services, flag revoked connections. Runs in the
 *                               daily cron (api/cron/sync-connections.js).
 *   handleSquareEvent(c, ev)  → one Square webhook event (api/square-webhook.js):
 *                               booking.created/updated → that salon's Square calendar re-read now;
 *                               oauth.authorization.revoked → connection marked, owner told;
 *                               catalog / team changes → stylists + services re-matched.
 */
import { decrypt } from './crypto.js';

const sq = () => import('./connectors/square.js');
const open = (row) => ({ ...row, access_token: decrypt(row.access_token), refresh_token: decrypt(row.refresh_token) });

export async function squareRows(c, { merchantId = null, status = null } = {}) {
  if (!c) return [];
  let q = c.from('integrations').select('*').eq('provider', 'square');
  if (status) q = q.eq('status', status);
  const { data } = await q.then((x) => x, () => ({ data: [] }));
  return (data || []).filter((r) => !merchantId || r.metadata?.merchant_id === merchantId).map(open);
}

async function patchMeta(c, row, patch) {
  const metadata = { ...(row.metadata || {}), ...patch };
  await c.from('integrations').update({ metadata }).eq('id', row.id).then((x) => x, () => null);
  row.metadata = metadata;
}

/** The daily pass over every connected Square account. */
export async function squareDaily(c, { now = Date.now() } = {}) {
  const S = await sq();
  const out = { checked: 0, refreshed: 0, revoked: 0, needs_reconnect: 0, missing_scopes: 0, stale: [] };
  for (const row of await squareRows(c, { status: 'connected' })) {
    out.checked++;
    try {
      const f = await S.keepFresh(row, { now });
      if (f.refreshed) out.refreshed++;
      // Square: alert when a stored token is older than 8 days (30-day tokens → under 22 days left).
      const exp = Date.parse(row.expires_at || '') || 0;
      if (exp && exp - now < 22 * 864e5) out.stale.push(row.tenant_id);
      const st = await S.tokenStatus(row);
      if (!st.ok) {
        if (st.status === 401 || /ACCESS_TOKEN_(REVOKED|EXPIRED)/.test(String(st.code || ''))) {
          await S.authProblem(row, st.code || 'UNAUTHORIZED');
          if (st.code === 'ACCESS_TOKEN_REVOKED') out.revoked++; else out.needs_reconnect++;
        }
        continue;
      }
      const patch = { scopes: st.scopes, missing_scopes: st.missing, checked_at: new Date(now).toISOString() };
      if (st.merchant_id && !row.metadata?.merchant_id) patch.merchant_id = st.merchant_id;
      if (!row.metadata?.location_id || !row.metadata?.tz) { try { Object.assign(patch, Object.fromEntries(Object.entries(await S.describeAccount(row)).filter(([, v]) => v != null))); } catch (_) {} }
      await patchMeta(c, row, patch);
      if (st.missing.length) out.missing_scopes++;
      try { await S.autoMap(row); } catch (_) {}
    } catch (_) { /* one salon never stops the others */ }
  }
  if (out.stale.length) {
    try { const { alertAdmin } = await import('./billing-enforce.js'); await alertAdmin('Square tokens not renewed', `${out.stale.length} Square connection(s) have tokens older than 8 days — renewal is failing. Tenants: ${out.stale.slice(0, 10).join(', ')}`); } catch (_) {}
  }
  return out;
}

/** Re-read one salon's Square calendar right now (the calendar outbox job, made due and run). */
async function syncNow(c, row) {
  try {
    const { forgetNames } = await sq(); forgetNames(row);
    await c.from('calendar_sync_jobs').update({ next_run_at: new Date().toISOString() }).eq('integration_id', row.id).then((x) => x, () => null);
    const { runOutbox, ensureJobs } = await import('./calendar-outbox.js');
    await ensureJobs(c, row.tenant_id).catch(() => {});
    const r = await runOutbox({ client: c, tenantId: row.tenant_id, limit: 5, budgetMs: 20000 });
    if (r?.ok) return { ok: true, outbox: true };
  } catch (_) {}
  try { const { syncTenantAvailability } = await import('./booking-sync.js'); return await syncTenantAvailability(c, row.tenant_id, { provider: 'square', legacy: true }); } catch (e) { return { ok: false, error: String(e?.message || e) }; }
}

const seen = new Map();   // event_id → at (Square may deliver an event more than once)
export async function handleSquareEvent(c, ev = {}) {
  const id = String(ev.event_id || '');
  if (id) {
    for (const [k, at] of seen) if (Date.now() - at > 3600e3) seen.delete(k);
    if (seen.has(id)) return { ok: true, duplicate: true };
    seen.set(id, Date.now());
  }
  const type = String(ev.type || '');
  const merchantId = ev.merchant_id || ev.data?.object?.merchant_id || null;
  if (!merchantId) return { ok: true, ignored: 'no merchant' };
  const rows = await squareRows(c, { merchantId });
  if (!rows.length) return { ok: true, ignored: 'no salon for this Square account' };
  const S = await sq();
  if (type === 'oauth.authorization.revoked') {
    for (const r of rows) await S.authProblem(r, 'ACCESS_TOKEN_REVOKED');
    return { ok: true, revoked: rows.length };
  }
  const live = rows.filter((r) => r.status === 'connected');
  if (/^booking\./.test(type)) {
    const res = [];
    for (const r of live) res.push(await syncNow(c, r));
    return { ok: true, synced: res.length };
  }
  if (/^(catalog\.|team_member\.|booking_profile|location\.)/.test(type) || type === 'team_member.created') {
    for (const r of live) { try { S.forgetNames(r); await S.autoMap(r); } catch (_) {} }
    return { ok: true, remapped: live.length };
  }
  if (/^customer\./.test(type)) { for (const r of live) S.forgetNames(r); return { ok: true }; }
  return { ok: true, ignored: type };
}
