/**
 * /api/admin/telecom — the technical telecom registry of EVERY salon (platform admins only).
 *   GET  → { ok, tenants: [{ tenant, numbers (+ Telnyx drift), forwarding, ports, texting, costs }], totals }
 *          numbers: tenant_numbers rows vs Telnyx live (on account, connection, messaging profile)
 *          ports:   Telnyx order ids / status / FOC / exceptions / last_error (never PINs/account numbers)
 *          texting: 10DLC brand / campaign / assignment status + last_error (never the EIN)
 *          costs:   this month's cost_* usage_events per kind — event COUNT (what LolaDesk paid for)
 *          cost_cents / cost_dollars: the same in money (lib/costs.js: cents; legacy count rows priced at defaults)
 *          revenue: { mrr_cents, fees_cents } and margin_cents = MRR + fees − costs, per salon and in totals
 *   POST { action, tenant_id, port_id? }
 *          resync         — sync the salon's open ports + 10DLC from Telnyx
 *          retry_port     — resend the salon's port (PATCH details/documents, confirm)
 *          retry_campaign — resubmit a rejected 10DLC campaign
 *          reassign       — (re)assign the salon's numbers to its approved campaign
 * Gate: ADMIN_EMAILS (lib/auth.js isAdminEmail), same as the other /api/admin endpoints.
 */
import { bearer, getUserFromToken, isAdminEmail } from '../lib/auth.js';
import { db } from '../lib/db.js';
import { ensureTelecomSchema } from '../lib/migrate.js';
import { liveTelnyxSnapshot } from '../lib/connection-sync.js';
import { getCanonicalVoiceConnectionId } from '../lib/telnyx-provision.js';
import { messagingProfileId } from '../lib/telnyx-account.js';
import { portSync, portRetry, textingSync, retryCampaign, assignNumbersIfApproved, _internals } from '../lib/setup/telecom.js';
import { costCents, dollars } from '../lib/costs.js';
import { mrrCents, normalizePlan } from '../lib/plans.js';

const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(); };
const PORT_PUBLIC = ['id', 'requested_phone_number', 'status', 'telnyx_status', 'telnyx_order_id', 'telnyx_order_ids', 'foc_date', 'requirements_met', 'exceptions', 'last_error', 'temporary_phone_number', 'current_carrier', 'entity_name', 'authorized_contact_name', 'billing_city', 'billing_state', 'billing_zip', 'loa_document_id', 'invoice_document_id', 'submitted_at', 'completed_at', 'synced_at', 'created_at', 'updated_at'];
const COMP_PUBLIC = ['stage', 'entity_type', 'legal_name', 'brand_id', 'brand_status', 'brand_identity_status', 'otp_reference', 'campaign_id', 'campaign_status', 'usecase', 'numbers', 'last_error', 'synced_at', 'created_at', 'updated_at'];
const only = (row, keys) => row ? Object.fromEntries(keys.filter((k) => row[k] !== undefined).map((k) => [k, row[k]])) : null;

function body(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body || '{}'); } catch { return {}; } }
  return req.body;
}

export async function registry(c, { live = true } = {}) {
  const [tenants, numbers, channels, ports, comps, usage, fees] = await Promise.all([
    c.from('tenants').select('*').limit(5000),
    c.from('tenant_numbers').select('*').limit(5000),
    c.from('tenant_channels').select('tenant_id,channel,account_id,status,updated_at').eq('channel', 'forwarding').limit(5000),
    c.from('tenant_number_ports').select('*').order('created_at', { ascending: false }).limit(2000),
    c.from('tenant_compliance').select('*').limit(5000),
    c.from('usage_events').select('tenant_id,kind,units,metadata,created_at').gte('created_at', monthStart()).limit(50000),
    c.from('booking_fees').select('tenant_id,status,fee_cents').eq('period', monthStart().slice(0, 7)).limit(50000),
  ].map((q) => Promise.resolve(q).then((r) => r?.data || [], () => [])));
  const snap = live ? await liveTelnyxSnapshot().catch(() => null) : null;
  const expected = live ? await getCanonicalVoiceConnectionId().catch(() => null) : null;
  const mp = await messagingProfileId(c).catch(() => null);
  const paying = (t) => ['active', 'canceling', 'past_due'].includes(String(t.subscription_status || ''));
  const byT = new Map((tenants || []).map((t) => [t.id, { tenant: { id: t.id, name: t.name, slug: t.slug, owner_email: t.owner_email, phone_number: t.phone_number, subscription_status: t.subscription_status, plan: normalizePlan(t.plan) || t.plan || null },
    numbers: [], forwarding: [], ports: [], texting: null, costs: {}, cost_cents: {}, cost_cents_total: 0,
    revenue: { mrr_cents: paying(t) ? mrrCents(t.plan, t.billing_interval) : 0, fees_cents: 0 } }]));
  const slot = (id) => { if (!byT.has(id)) byT.set(id, { tenant: { id }, numbers: [], forwarding: [], ports: [], texting: null, costs: {}, cost_cents: {}, cost_cents_total: 0, revenue: { mrr_cents: 0, fees_cents: 0 } }); return byT.get(id); };
  for (const n of numbers) {
    const l = snap?.byPhone?.get(n.phone_number) || null;
    const drift = [];
    if (snap && !snap.error) {
      if (!l) drift.push('not_on_telnyx_account');
      else {
        if (!l.connection_id) drift.push('no_voice_connection');
        else if (expected && l.connection_id !== expected) drift.push('voice_connection_differs');
        if (!l.messaging_profile_id) drift.push('no_messaging_profile');
        else if (mp && l.messaging_profile_id !== mp) drift.push('messaging_profile_differs');
        if (n.connection_id && l.connection_id && n.connection_id !== l.connection_id) drift.push('routing_row_stale');
      }
    }
    slot(n.tenant_id).numbers.push({ phone_number: n.phone_number, kind: n.kind, status: n.status, connection_id: n.connection_id || null, notes: n.notes || null,
      telnyx: l ? { id: l.id, status: l.status, connection_id: l.connection_id, connection_name: l.connection_name, messaging_profile_id: l.messaging_profile_id } : null, drift });
  }
  for (const f of channels) slot(f.tenant_id).forwarding.push({ salon_number: f.account_id, status: f.status, updated_at: f.updated_at });
  for (const p of ports) slot(p.tenant_id).ports.push({ ...only(p, PORT_PUBLIC), comments: (p.metadata?.comments || []).slice(-3), missing: p.metadata?.missing || [], loa_source: p.metadata?.loa_source || null, has_pin: !!p.pin_enc, has_account_number: !!p.account_number_enc, secure_storage_missing: !!p.metadata?.secure_storage_missing });
  for (const r of comps) slot(r.tenant_id).texting = { ...only(r, COMP_PUBLIC), has_ein: !!r.ein_enc, ein_last4: r.details?.ein_last4 || null, sole_prop: !!r.details?.sole_prop };
  const totals = {}, totals_cents = {};
  for (const u of usage) {
    if (!/^cost_/.test(String(u.kind || ''))) continue;
    const s = slot(u.tenant_id);
    const cents = costCents(u);
    s.costs[u.kind] = (s.costs[u.kind] || 0) + 1;
    s.cost_cents[u.kind] = (s.cost_cents[u.kind] || 0) + cents;
    s.cost_cents_total += cents;
    totals[u.kind] = (totals[u.kind] || 0) + 1;
    totals_cents[u.kind] = (totals_cents[u.kind] || 0) + cents;
  }
  for (const f of fees) if (['pending', 'earned', 'billed'].includes(f.status)) slot(f.tenant_id).revenue.fees_cents += Number(f.fee_cents) || 0;
  let cost_total = 0, mrr_total = 0, fee_total = 0;
  for (const s of byT.values()) {
    s.cost_dollars = dollars(s.cost_cents_total);
    s.margin_cents = s.revenue.mrr_cents + s.revenue.fees_cents - s.cost_cents_total;
    s.margin_dollars = dollars(s.margin_cents);
    cost_total += s.cost_cents_total; mrr_total += s.revenue.mrr_cents; fee_total += s.revenue.fees_cents;
  }
  const money = { cost_cents: cost_total, cost_dollars: dollars(cost_total), mrr_cents: mrr_total, mrr_dollars: dollars(mrr_total), fees_cents: fee_total, margin_cents: mrr_total + fee_total - cost_total, margin_dollars: dollars(mrr_total + fee_total - cost_total), by_kind_cents: totals_cents };
  return { tenants: [...byT.values()], totals, totals_cents, money, month_start: monthStart(), telnyx: { live: !!snap && !snap.error, error: snap?.error || null, expected_connection_id: expected, messaging_profile_id: mp } };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET/POST only' });
  const user = await getUserFromToken(bearer(req)).catch(() => null);
  if (!user) return res.status(401).json({ ok: false, error: 'Not signed in' });
  if (!isAdminEmail(user.email)) return res.status(403).json({ ok: false, error: 'Not authorized' });
  const c = db();
  if (!c) return res.status(503).json({ ok: false, error: 'Database not configured' });
  await ensureTelecomSchema().catch(() => null);
  try {
    if (req.method === 'GET') {
      const live = String(req.query?.live ?? '1') !== '0';
      const { phoneMode } = await import('../lib/telnyx-provision.js');
      return res.status(200).json({ ok: true, ...(await registry(c, { live })), phone_mode: await phoneMode().catch(() => 'loladesk'), phone_mode_locked: !!String(process.env.LOLA_PHONE_MODE || '').trim() });
    }
    const b = body(req);
    const action = String(b.action || '');
    // Platform switch: which line answers every salon's calls (LolaDesk's own, or the Telnyx assistant).
    if (action === 'phone_mode') {
      const mode = String(b.mode || '').toLowerCase();
      if (!['loladesk', 'assistant'].includes(mode)) return res.status(400).json({ ok: false, error: 'mode must be loladesk or assistant' });
      const { error } = await c.from('platform_settings').upsert({ key: 'lola_phone_mode', value: { mode }, updated_at: new Date().toISOString() }, { onConflict: 'key' });
      if (error) return res.status(500).json({ ok: false, error: error.message });
      const pv = await import('../lib/telnyx-provision.js');
      pv._resetPhoneLineCache();
      // Move every salon number onto the chosen line now.
      const target = await pv.getCanonicalVoiceConnectionId().catch(() => null);
      let moved = 0, failed = 0;
      if (target) {
        const { data: rows } = await c.from('tenant_numbers').select('phone_number,status').limit(1000);
        const want = new Set((rows || []).filter((r) => r.phone_number && r.status !== 'released').map((r) => r.phone_number));
        const owned = await pv.listOwnedNumbers().catch(() => []);
        for (const n of owned.filter((x) => want.has(x.phone_number) && x.connection_id !== target)) {
          try { await pv.tFetch('/phone_numbers/' + n.id, { method: 'PATCH', body: JSON.stringify({ connection_id: target }) }); moved++; } catch (_) { failed++; }
        }
      }
      return res.status(200).json({ ok: true, action, phone_mode: mode, connection_id: target, moved, failed, locked_by_env: !!String(process.env.LOLA_PHONE_MODE || '').trim() });
    }
    const tenantId = String(b.tenant_id || '');
    if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });
    const { data: tenant } = await c.from('tenants').select('*').eq('id', tenantId).maybeSingle();
    if (!tenant) return res.status(404).json({ ok: false, error: 'tenant not found' });
    let result;
    if (action === 'resync') {
      const { data: ports } = await c.from('tenant_number_ports').select('*').eq('tenant_id', tenantId).limit(20);
      const pr = [];
      for (const p of (ports || []).filter((r) => _internals.orderIdsOf(r).length && !r.completed_at)) pr.push(await portSync(p, { tenant }));
      result = { ports: pr.map((r) => ({ ok: r.ok, completed: !!r.completed, state: r.port?.state || null, error: r.error || null })), texting: await textingSync(tenant).then((r) => ({ ok: r.ok, error: r.error || null })) };
    } else if (action === 'retry_port') result = await portRetry(tenant, {});
    else if (action === 'retry_campaign') result = await retryCampaign(tenant);
    else if (action === 'reassign') result = await assignNumbersIfApproved(c, tenant, { force: !!b.force });
    else return res.status(400).json({ ok: false, error: 'unknown action', supported: ['resync', 'retry_port', 'retry_campaign', 'reassign'] });
    const reg = await registry(c, { live: false });
    return res.status(200).json({ ok: true, action, result, tenant: reg.tenants.find((t) => t.tenant.id === tenantId) || null });
  } catch (e) {
    console.error('[admin/telecom]', e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
