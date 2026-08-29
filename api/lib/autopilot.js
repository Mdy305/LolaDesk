/**
 * api/lib/autopilot.js — Lola Autopilot: the agentic operations OS
 * ════════════════════════════════════════════════════════════════════
 * Four autonomous agents that operate LolaDesk itself, so the platform runs
 * itself while the operator sleeps. Each agent runs on a schedule (see
 * api/cron/autopilot.js) and/or on demand from the Command screen
 * (api/admin/autopilot.js), and every run is recorded in the agent_runs
 * ledger (migrations/20260822_lola_autopilot.sql) so actions are auditable.
 *
 *   AGENTS
 *   ──────
 *   1. routing-heal          (platform-wide) — reconcile tenant_numbers with
 *        Telnyx truth, and flag numbers that are unattached or stuck on the
 *        rejected legacy connection. Same shared core as the daily cron.
 *   2. missed-call-recovery  (per tenant)    — a caller rang and nobody
 *        booked; Lola texts them within 24h and offers to book. Cooldown via
 *        tenants.recovery_sms_sent_at so a salon's callers never get spammed.
 *   3. rebooking             (per tenant)    — an appointment was cancelled
 *        or no-showed; Lola texts the client and offers the next opening,
 *        unless they already rebooked. Dedup via client memory.
 *   4. sync-self-heal        (per tenant)    — a tenant's booking sync is
 *        erroring or stale for > 1h; Lola re-runs the sync and records the
 *        outcome, healing what sync-alerts only reports.
 *   5. review-request         (per tenant)    — a client's appointment just
 *        ended; Lola texts them the salon's Yelp/Google review link so real
 *        customers drive the reputation. Dedup via client memory.
 *   6. callback-recovery      (per tenant)    — a caller rang and wasn't
 *        served; Lola ORIGINATES a call back from the salon's line within the
 *        window so nobody waits on Lola's voicemail. Cooldown via
 *        tenants.callback_sent_at; reuses the shared originate core.
 *
 * Per-tenant agents respect tenants.autopilot_enabled (owners can pause
 * autonomy from Settings). Every SMS respects the client's 10DLC opt-out.
 */

import { db, e164, isOptedOut, getClientMemory, setClientMemory, listTenantNumberRoutes, logUsage } from './db.js';
import { syncTenantConnections } from './connection-sync.js';
import { syncTenantAvailability } from './booking-sync.js';
import { originateCallback } from './call-callback.js';

// The dead 'upgrade' connection Telnyx rejects for origination. Kept in sync
// with admin/numbers.js (REJECTED_LEGACY_CONNECTION_ID).
export const REJECTED_LEGACY_CONNECTION_ID = '2991758319724529273';

export const AUTOPILOT_AGENTS = {
  'routing-heal': {
    label: 'Routing heal',
    scope: 'platform',
    description: 'Reconciles tenant_numbers against live Telnyx and flags unattached or rejected-legacy numbers.'
  },
  'missed-call-recovery': {
    label: 'Missed-call recovery',
    scope: 'tenant',
    description: 'Texts callers who rang in the last 24h without booking, offering to book them in.'
  },
  'rebooking': {
    label: 'Rebooking',
    scope: 'tenant',
    description: 'Texts clients whose appointment was cancelled or no-showed, offering the next opening.'
  },
  'sync-self-heal': {
    label: 'Sync self-heal',
    scope: 'tenant',
    description: 'Re-runs booking syncs that are erroring or stale for over an hour.'
  },
  'review-request': {
    label: 'Review request',
    scope: 'tenant',
    description: 'Texts clients a link to the salon\'s Yelp/Google review page after their appointment ends.'
  },
  'callback-recovery': {
    label: 'Missed-call callback',
    scope: 'tenant',
    description: 'Calls back callers who rang and weren\'t served, so nobody waits on Lola\'s voicemail.'
  }
};

export const AUTOPILOT_AGENT_ORDER = ['routing-heal', 'missed-call-recovery', 'rebooking', 'sync-self-heal', 'review-request', 'callback-recovery'];

const RECOVERY_COOLDOWN_MS = 6 * 3600 * 1000;   // one recovery burst per tenant per 6h
const RECENT_WINDOW_MS = 24 * 3600 * 1000;      // look back 24h for missed calls
const REBOOK_WINDOW_MS = 7 * 24 * 3600 * 1000;  // look back 7d for cancellations
const STALE_AFTER_MS = 2 * 3600 * 1000;         // sync older than 2h is stale
const RECENT_SYNC_MS = 7 * 24 * 3600 * 1000;    // sync log lookback
const REVIEW_WINDOW_MS = 6 * 3600 * 1000;       // appointments that ended in the last 6h

// ── shared helpers ────────────────────────────────────────────────────────

async function enabledTenants(client, select = 'id,slug,name,phone_number,autopilot_enabled,recovery_sms_sent_at'){
  const { data } = await client.from('tenants')
    .select(select)
    .order('created_at', { ascending: false })
    .limit(500)
    .then(r => r).catch(() => ({ data: [] }));
  return (data || []).filter(t => t.autopilot_enabled !== false);
}

async function primaryNumber(client, tenant){
  if (tenant.phone_number) return tenant.phone_number;
  const { data } = await client.from('tenant_numbers')
    .select('phone_number').eq('tenant_id', tenant.id).eq('kind', 'primary').eq('status', 'active')
    .limit(1).then(r => r).catch(() => ({ data: [] }));
  return data?.[0]?.phone_number || null;
}

/**
 * Send one recovery/rebooking SMS. Lightweight, self-contained (no heavy
 * telnyx-sms.js deps) and opt-out aware. Injectable via global fetch for
 * tests, exactly like the other Telnyx libs.
 */
export async function sendAutopilotSms({ from, to, text, tenantId }){
  if (!process.env.TELNYX_API_KEY) return { skipped: true, reason: 'TELNYX_API_KEY not set' };
  if (!from || !to) return { skipped: true, reason: 'missing from/to' };
  if (tenantId){
    try{ if (await isOptedOut(tenantId, to)) return { skipped: true, reason: 'opted_out' }; }catch{}
  }
  const r = await fetch('https://api.telnyx.com/v2/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.TELNYX_API_KEY}` },
    body: JSON.stringify({ from: e164(from), to: e164(to), text })
  });
  if (!r.ok) return { skipped: true, reason: `telnyx ${r.status}` };
  return { sent: true };
}

// ── AGENT 1 · routing-heal (platform-wide) ────────────────────────────────
async function routingHeal({ client }){
  // Same shared core as the daily sync-connections cron — one implementation.
  const sync = await syncTenantConnections(client);
  const routes = await listTenantNumberRoutes(500);
  const flagged = (routes || []).filter(r => !r.connection_id || r.connection_id === REJECTED_LEGACY_CONNECTION_ID)
    .map(r => ({ phone_number: r.phone_number, tenant_id: r.tenant_id, state: !r.connection_id ? 'missing' : 'rejected_legacy' }));
  const status = sync.ok
    ? (sync.updated.length || flagged.length ? 'success' : 'skipped')
    : 'failed';
  return {
    status,
    summary: sync.ok
      ? `Reconciled ${sync.updated.length} routing row(s) with Telnyx; ${flagged.length} still need operator attention`
      : `Telnyx unreachable: ${sync.error}`,
    details: {
      updated: sync.updated,
      flagged,
      not_found_on_telnyx: sync.not_found_on_telnyx || [],
      error: sync.error || null
    },
    actions: sync.updated
  };
}

// ── AGENT 2 · missed-call-recovery (per tenant) ───────────────────────────
async function missedCallRecovery({ client, now }){
  const tenants = await enabledTenants(client);
  const since = new Date(now - RECENT_WINDOW_MS).toISOString();
  const actions = [];
  for (const t of tenants){
    // Cooldown: only one recovery burst per tenant per 6h.
    if (t.recovery_sms_sent_at && (now - new Date(t.recovery_sms_sent_at).getTime()) < RECOVERY_COOLDOWN_MS) continue;

    const { data: calls } = await client.from('calls')
      .select('id,client_id,from_number,status,duration_seconds,created_at')
      .eq('tenant_id', t.id).eq('direction', 'inbound')
      .gte('created_at', since)
      .order('created_at', { ascending: false }).limit(200)
      .then(r => r).catch(() => ({ data: [] }));

    const missed = (calls || []).map(c => ({ ...c, outcome: c.status || null, duration_sec: c.duration_seconds || null })).filter(c => {
      if (c.duration_sec && c.duration_sec > 0) return false;
      const o = String(c.outcome || '').toLowerCase();
      return !o || ['missed', 'no_answer', 'failed', 'cancelled', 'busy'].includes(o);
    });
    if (!missed.length) continue;

    const clientIds = [...new Set(missed.map(c => c.client_id).filter(Boolean))];
    let clients = [];
    if (clientIds.length){
      const { data } = await client.from('clients').select('id,first_name,last_name,phone').in('id', clientIds)
        .then(r => r).catch(() => ({ data: [] }));
      clients = data || [];
    }

    const fromNumber = await primaryNumber(client, t);
    if (!fromNumber){
      actions.push({ tenant_id: t.id, status: 'skipped', reason: 'no primary number' });
      continue;
    }

    let sent = 0;
    for (const call of missed){
      const cl = call.client_id ? clients.find(c => c.id === call.client_id) : null;
      const to = cl?.phone || call.from_number;
      if (!to){
        actions.push({ tenant_id: t.id, call_id: call.id, status: 'skipped', reason: 'no caller identity' });
        continue;
      }
      // If they already booked after the call, nothing to recover.
      if (call.client_id){
        const { data: recent } = await client.from('bookings').select('id')
          .eq('tenant_id', t.id).eq('client_id', call.client_id)
          .gte('created_at', call.created_at).limit(1)
          .then(r => r).catch(() => ({ data: [] }));
        if (recent?.length){
          actions.push({ tenant_id: t.id, call_id: call.id, status: 'skipped', reason: 'already booked' });
          continue;
        }
      }
      const name = cl?.first_name ? String(cl.first_name).split(' ')[0] : 'there';
      const text = `Hi ${name}, this is Lola at ${t.name}. I missed your call and didn't want you waiting — want me to book you in? Reply with a day and time that works, or call us back and I'll pick up.`;
      const r = await sendAutopilotSms({ from: fromNumber, to, text, tenantId: t.id });
      if (r.sent){
        sent++;
        actions.push({ tenant_id: t.id, call_id: call.id, to, status: 'sent' });
      } else {
        actions.push({ tenant_id: t.id, call_id: call.id, status: 'skipped', reason: r.reason });
      }
    }
    if (sent){
      await client.from('tenants').update({ recovery_sms_sent_at: new Date(now).toISOString() }).eq('id', t.id);
    }
  }
  const sentCount = actions.filter(a => a.status === 'sent').length;
  return {
    status: sentCount ? 'success' : (actions.length ? 'partial' : 'skipped'),
    summary: sentCount
      ? `Recovered ${sentCount} missed call(s) with a follow-up text across ${actions.filter(a => a.status === 'sent').length} tenant(s)`
      : (actions.length ? 'No recovery texts sent (all skipped)' : 'No missed calls in the window'),
    details: { actions: actions.slice(0, 50) },
    actions
  };
}

// ── AGENT 3 · rebooking (per tenant) ──────────────────────────────────────
async function rebooking({ client, now }){
  const tenants = await enabledTenants(client);
  const since = new Date(now - REBOOK_WINDOW_MS).toISOString();
  const actions = [];
  for (const t of tenants){
    const { data: bookings } = await client.from('bookings')
      .select('id,client_id,service:services(name),starts_at:start_time,status,created_at')
      .eq('tenant_id', t.id)
      .in('status', ['cancelled', 'no-show'])
      .gte('created_at', since)
      .order('created_at', { ascending: false }).limit(200)
      .then(r => r).catch(() => ({ data: [] }));
    const cands = (bookings || []).map(b => ({ ...b, service: b.service?.name || b.service || null })).filter(b => b.client_id);
    if (!cands.length) continue;

    const clientIds = [...new Set(cands.map(b => b.client_id))];
    let clients = [];
    if (clientIds.length){
      const { data } = await client.from('clients').select('id,first_name,last_name,phone').in('id', clientIds)
        .then(r => r).catch(() => ({ data: [] }));
      clients = data || [];
    }

    const fromNumber = await primaryNumber(client, t);
    if (!fromNumber){
      actions.push({ tenant_id: t.id, status: 'skipped', reason: 'no primary number' });
      continue;
    }

    let sent = 0;
    for (const b of cands){
      const cl = clients.find(c => c.id === b.client_id);
      if (!cl?.phone){
        actions.push({ tenant_id: t.id, booking_id: b.id, status: 'skipped', reason: 'no client phone' });
        continue;
      }
      // Dedup: don't text the same cancellation twice.
      const mem = await getClientMemory(t.id, 'autopilot:').catch(() => []);
      const doneKey = `rebooked:${b.id}`;
      if (mem.some(m => m.key === doneKey)){
        actions.push({ tenant_id: t.id, booking_id: b.id, status: 'skipped', reason: 'already contacted' });
        continue;
      }
      // If they already rebooked into the future, skip.
      const { data: future } = await client.from('bookings').select('id')
        .eq('tenant_id', t.id).eq('client_id', b.client_id).eq('status', 'confirmed')
        .gt('start_time', new Date(now).toISOString()).limit(1)
        .then(r => r).catch(() => ({ data: [] }));
      if (future?.length){
        actions.push({ tenant_id: t.id, booking_id: b.id, status: 'skipped', reason: 'already rebooked' });
        continue;
      }
      const name = String(cl.first_name || 'there').split(' ')[0];
      const text = `Hi ${name}, Lola here from ${t.name}. Your ${b.service || 'appointment'} didn't go through — want me to find you the next opening? Reply with a day and time and I'll take care of it.`;
      const r = await sendAutopilotSms({ from: fromNumber, to: cl.phone, text, tenantId: t.id });
      if (r.sent){
        sent++;
        try{ await setClientMemory(t.id, 'autopilot:', doneKey, new Date(now).toISOString()); }catch{}
        actions.push({ tenant_id: t.id, booking_id: b.id, to: cl.phone, status: 'sent' });
      } else {
        actions.push({ tenant_id: t.id, booking_id: b.id, status: 'skipped', reason: r.reason });
      }
    }
  }
  const sentCount = actions.filter(a => a.status === 'sent').length;
  return {
    status: sentCount ? 'success' : (actions.length ? 'partial' : 'skipped'),
    summary: sentCount
      ? `Invited ${sentCount} client(s) to rebook after a cancellation or no-show`
      : (actions.length ? 'No rebooking texts sent (all skipped)' : 'No cancellations/no-shows in the window'),
    details: { actions: actions.slice(0, 50) },
    actions
  };
}

// ── AGENT 4 · sync-self-heal (per tenant) ─────────────────────────────────
async function syncSelfHeal({ client, now }){
  const tenants = await enabledTenants(client, 'id,slug,name');
  const since = new Date(now - RECENT_SYNC_MS).toISOString();
  const { data: logs } = await client.from('booking_sync_log')
    .select('tenant_id,provider,error_message,created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false }).limit(5000)
    .then(r => r).catch(() => ({ data: [] }));
  const latest = new Map();
  for (const l of (logs || [])) if (!latest.has(l.tenant_id)) latest.set(l.tenant_id, l);

  const actions = [];
  let healed = 0;
  for (const t of tenants){
    const run = latest.get(t.id);
    if (!run) continue; // never synced — not a heal target
    const stale = (now - new Date(run.created_at).getTime()) > STALE_AFTER_MS;
    if (!run.error_message && !stale) continue;
    const res = await syncTenantAvailability(client, t.id).catch(e => ({ ok: false, error: String(e?.message || e) }));
    const ok = !!res.ok && !res.error;
    if (ok) healed++;
    actions.push({
      tenant_id: t.id,
      provider: run.provider || null,
      prior_error: run.error_message || null,
      healed: ok,
      result: { ok: res.ok, note: res.note || res.error || null }
    });
  }
  return {
    status: healed ? 'success' : (actions.length ? 'partial' : 'skipped'),
    summary: healed
      ? `Re-ran ${actions.length} unhealthy sync(s); ${healed} healed`
      : (actions.length ? 'Re-ran syncs but none fully healed' : 'No unhealthy syncs found'),
    details: { actions: actions.slice(0, 50) },
    actions
  };
}

// ── AGENT 5 · review-request (per tenant) ─────────────────────────────────
// A client's appointment just ended; text them a direct link to the salon's
// Yelp/Google review page so the reputation is driven by real customers.
// Yelp has no write API — the compliant play is sending real clients to the
// "Write a Review" page, exactly like Podium/Birdeye. Dedup via client memory
// (one campaign per booking) and the client's 10DLC opt-out.
async function reviewRequest({ client, now }){
  const tenants = await enabledTenants(client, 'id,slug,name,phone_number,autopilot_enabled,yelp_review_url,google_review_url');
  const windowStart = new Date(now - REVIEW_WINDOW_MS).toISOString();
  const actions = [];
  for (const t of tenants){
    const yelp = String(t.yelp_review_url || '').trim();
    const google = String(t.google_review_url || '').trim();
    if (!yelp && !google) continue; // nothing to send until the owner sets links

    const { data: bookings } = await client.from('bookings')
      .select('id,client_id,end_time,status,created_at')
      .eq('tenant_id', t.id).eq('status', 'confirmed')
      .lte('end_time', new Date(now).toISOString())
      .gte('end_time', windowStart)
      .order('end_time', { ascending: false }).limit(200)
      .then(r => r).catch(() => ({ data: [] }));
    const cands = (bookings || []).filter(b => b.client_id);
    if (!cands.length) continue;

    const clientIds = [...new Set(cands.map(b => b.client_id))];
    let clients = [];
    if (clientIds.length){
      const { data } = await client.from('clients').select('id,first_name,last_name,phone').in('id', clientIds)
        .then(r => r).catch(() => ({ data: [] }));
      clients = data || [];
    }

    const fromNumber = await primaryNumber(client, t);
    if (!fromNumber){
      actions.push({ tenant_id: t.id, status: 'skipped', reason: 'no primary number' });
      continue;
    }

    let sent = 0;
    for (const b of cands){
      const cl = clients.find(c => c.id === b.client_id);
      if (!cl?.phone){
        actions.push({ tenant_id: t.id, booking_id: b.id, status: 'skipped', reason: 'no client phone' });
        continue;
      }
      // Dedup: one campaign per booking.
      const mem = await getClientMemory(t.id, 'autopilot:').catch(() => []);
      const doneKey = `review-requested:${b.id}`;
      if (mem.some(m => m.key === doneKey)){
        actions.push({ tenant_id: t.id, booking_id: b.id, status: 'skipped', reason: 'already contacted' });
        continue;
      }
      const name = String(cl.first_name || 'there').split(' ')[0];
      const links = [];
      if (yelp) links.push(`Yelp: ${yelp}`);
      if (google) links.push(`Google: ${google}`);
      const text = `Hi ${name}, this is Lola at ${t.name}. Hope you loved your visit! If you have a moment, a review means the world to us — ${links.join(' · ')}. Thank you!`;
      const r = await sendAutopilotSms({ from: fromNumber, to: cl.phone, text, tenantId: t.id });
      if (r.sent){
        sent++;
        try{ await setClientMemory(t.id, 'autopilot:', doneKey, new Date(now).toISOString()); }catch{}
        actions.push({ tenant_id: t.id, booking_id: b.id, to: cl.phone, status: 'sent' });
      } else {
        actions.push({ tenant_id: t.id, booking_id: b.id, status: 'skipped', reason: r.reason });
      }
    }
  }
  const sentCount = actions.filter(a => a.status === 'sent').length;
  return {
    status: sentCount ? 'success' : (actions.length ? 'partial' : 'skipped'),
    summary: sentCount
      ? `Sent review requests to ${sentCount} client(s) whose appointment just ended`
      : (actions.length ? 'No review requests sent (all skipped)' : 'No completed appointments in the window'),
    details: { actions: actions.slice(0, 50) },
    actions
  };
}

// ── AGENT 6 · callback-recovery (per tenant) ──────────────────────────────
// A caller rang and wasn't served — Lola ORIGINATES a call back from the
// salon's own line (via the shared originate core) so nobody waits on the
// voicemail. This complements missed-call-recovery (which texts); the two
// can coexist because they use separate cooldown stamps. Dedup: one callback
// per call id, recorded in client memory. Always respects the client's
// 10DLC opt-out (call-backs are voice, but we honor a recorded opt-out).
async function callbackRecovery({ client, now }){
  const tenants = await enabledTenants(client, 'id,slug,name,phone_number,autopilot_enabled,callback_sent_at');
  const since = new Date(now - RECENT_WINDOW_MS).toISOString();
  const actions = [];
  for (const t of tenants){
    // Cooldown: only one callback burst per tenant per 6h.
    if (t.callback_sent_at && (now - new Date(t.callback_sent_at).getTime()) < RECOVERY_COOLDOWN_MS) continue;

    const { data: calls } = await client.from('calls')
      .select('id,client_id,from_number,status,duration_seconds,created_at')
      .eq('tenant_id', t.id).eq('direction', 'inbound')
      .gte('created_at', since)
      .order('created_at', { ascending: false }).limit(200)
      .then(r => r).catch(() => ({ data: [] }));

    const served = (calls || []).filter(c =>
      c.duration_seconds && c.duration_seconds > 0
      && String(c.status || '').toLowerCase() !== 'missed'
      && String(c.status || '').toLowerCase() !== 'no_answer');
    if (served.length && served.length === (calls || []).length) continue; // everyone served

    const unserved = (calls || []).filter(c => !served.includes(c));
    if (!unserved.length) continue;

    // Memory dedup: one callback per call id.
    const mem = await getClientMemory(t.id, 'autopilot:').catch(() => []);
    const already = new Set(mem.filter(m => String(m.key || '').startsWith('callback:')).map(m => String(m.key).slice('callback:'.length)));
    const targets = unserved.filter(c => !already.has(c.id));
    if (!targets.length) continue;

    let sent = 0;
    for (const call of targets){
      const to = call.from_number || null;
      if (!to){
        actions.push({ tenant_id: t.id, call_id: call.id, status: 'skipped', reason: 'no caller number' });
        continue;
      }
      try{
        if (await isOptedOut(t.id, to)){
          actions.push({ tenant_id: t.id, call_id: call.id, to, status: 'skipped', reason: 'opted_out' });
          continue;
        }
      }catch{}

      const r = await originateCallback(client, t, to);
      if (r.error === 'no Lola line'){
        actions.push({ tenant_id: t.id, status: 'skipped', reason: 'no primary number' });
        continue;
      }
      if (r.ok && r.call_control_id){
        sent++;
        try{ await setClientMemory(t.id, 'autopilot:', `callback:${call.id}`, new Date(now).toISOString()); }catch{}
        try{ await logUsage(t.id, 'callback_recovered', 1, { call_id: call.id, to, from: r.from, connection_id: r.connection_id, call_control_id: r.call_control_id }); }catch{}
        actions.push({ tenant_id: t.id, call_id: call.id, to, status: 'called_back' });
      } else {
        actions.push({ tenant_id: t.id, call_id: call.id, to, status: 'skipped', reason: r.error || 'originate failed' });
      }
    }
    if (sent){
      await client.from('tenants').update({ callback_sent_at: new Date(now).toISOString() }).eq('id', t.id).catch(() => {});
    }
  }
  const calledBack = actions.filter(a => a.status === 'called_back').length;
  return {
    status: calledBack ? 'success' : (actions.length ? 'partial' : 'skipped'),
    summary: calledBack
      ? `Called back ${calledBack} missed caller(s) from their salon line across ${actions.filter(a => a.status === 'called_back').length} tenant(s)`
      : (actions.length ? 'No callbacks placed (all skipped)' : 'No unserved calls in the window'),
    details: { actions: actions.slice(0, 50) },
    actions
  };
}

const RUNNERS = {
  'routing-heal': routingHeal,
  'missed-call-recovery': missedCallRecovery,
  'rebooking': rebooking,
  'sync-self-heal': syncSelfHeal,
  'review-request': reviewRequest,
  'callback-recovery': callbackRecovery
};

// ── ledger ────────────────────────────────────────────────────────────────
export async function logAgentRun(client, { agent, tenantId = null, status, summary, details = {}, durationMs }){
  if (!client) return null;
  try{
    const { data, error } = await client.from('agent_runs').insert({
      agent, tenant_id: tenantId, status, summary, details, duration_ms: durationMs ?? null
    }).select().maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }catch(e){
    // Non-fatal: the agent already finished its work; the ledger is audit-only.
    console.warn('[autopilot] ledger write failed:', String(e?.message || e).slice(0, 200));
    return null;
  }
}

/**
 * Run a set of autopilot agents and record each in the ledger.
 * @param {object} client — Supabase client
 * @param {{ agents?: string[], now?: number }} opts — agents to run (default:
 *   all four, in canonical order); now injectable for tests.
 */
export async function runAutopilot(client, opts = {}){
  if (!client) return { ok: false, error: 'db_not_configured', runs: [] };
  const wanted = opts.agents && opts.agents.length
    ? opts.agents : AUTOPILOT_AGENT_ORDER;
  const now = opts.now || Date.now();
  const runs = [];
  for (const id of AUTOPILOT_AGENT_ORDER){
    if (!wanted.includes(id) || !RUNNERS[id]) continue;
    const started = Date.now();
    try{
      const r = await RUNNERS[id]({ client, now });
      const status = r.status || 'success';
      await logAgentRun(client, { agent: id, status, summary: r.summary, details: r.details || {}, durationMs: Date.now() - started });
      runs.push({ agent: id, status, summary: r.summary, actions: (r.actions || []).length, duration_ms: Date.now() - started });
    }catch(e){
      await logAgentRun(client, { agent: id, status: 'failed', summary: String(e?.message || e).slice(0, 300), details: { error: String(e?.message || e) }, durationMs: Date.now() - started }).catch(() => {});
      runs.push({ agent: id, status: 'failed', summary: String(e?.message || e).slice(0, 200) });
    }
  }
  return { ok: true, runs };
}

/**
 * Operator status: the latest ledger run per agent + platform counts, so the
 * Command screen shows what Lola's agents did last without another full run.
 */
export async function autopilotStatus(client, { now = Date.now() } = {}){
  if (!client) return { ok: false, error: 'db_not_configured' };
  const { data: runs } = await client.from('agent_runs')
    .select('agent,status,summary,ran_at,duration_ms')
    .order('ran_at', { ascending: false }).limit(100)
    .then(r => r).catch(() => ({ data: [] }));
  const { data: tenants } = await client.from('tenants')
    .select('id,slug,name,autopilot_enabled')
    .order('created_at', { ascending: false }).limit(500)
    .then(r => r).catch(() => ({ data: [] }));
  const lastByAgent = new Map();
  for (const run of (runs || [])){
    if (!lastByAgent.has(run.agent)) lastByAgent.set(run.agent, run);
  }
  const paused = (tenants || []).filter(t => t.autopilot_enabled === false);
  return {
    ok: true,
    enabled: AUTOPILOT_AGENT_ORDER.every(id => lastByAgent.has(id)),
    last_runs: AUTOPILOT_AGENT_ORDER.map(id => {
      const r = lastByAgent.get(id) || null;
      return { agent: id, label: AUTOPILOT_AGENTS[id].label, ...(r || { status: 'never', summary: null, ran_at: null, duration_ms: null }) };
    }),
    tenant_count: (tenants || []).length,
    paused_tenants: paused.length,
    generated_at: new Date(now).toISOString()
  };
}

export default { AUTOPILOT_AGENTS, AUTOPILOT_AGENT_ORDER, runAutopilot, autopilotStatus, logAgentRun, sendAutopilotSms };
