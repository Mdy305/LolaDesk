/**
 * /api/cron/sync-alerts — booking-sync health alerting for the operator.
 * ════════════════════════════════════════════════════════════════════
 * Fired by Vercel Cron (see vercel.json `crons`). Requires CRON_SECRET.
 *
 * Watches every tenant's booking_sync_log and alerts the platform operator
 * (email and/or Slack) when a tenant's sync has been in an unhealthy state
 * for more than an hour:
 *   • error  — the latest run failed, and there has been no successful run
 *              within the last hour (i.e. it has been erroring > 1h).
 *   • stale  — the last sync is older than STALE_AFTER_MS (2h, so > 1h).
 *
 * DEDUP: sync_alert_log records the last-sent time per (tenant, type). A
 * tenant is only re-alerted after a cooldown (default 6h, configurable via
 * SYNC_ALERT_COOLDOWN_HOURS), so a broken sync doesn't page every tick.
 * When a tenant recovers, its alert rows are deleted so a future flip
 * alerts fresh.
 *
 * NOTIFICATION CHANNELS (either/both):
 *   • Email  — SendEmail() (SendGrid → SES → Mailgun). Recipient:
 *              ALERT_EMAIL, else the first ADMIN_EMAILS entry.
 *   • Slack  — SLACK_WEBHOOK_URL → POST { text }.
 */

import { db } from '../lib/db.js';
import { SendEmail } from '../lib/lola-integrations.js';

const RECENT_MS = 7 * 24 * 3600 * 1000;   // look back 7 days for the latest run
const STALE_AFTER_MS = 2 * 3600 * 1000;   // a tenant whose last sync is older than this is "stale"
const ERROR_PERSIST_MS = 3600 * 1000;     // must be erroring for > 1h before alerting

function authorized(req){
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${process.env.CRON_SECRET}`;
}

function cooldownMs(){
  return Number(process.env.SYNC_ALERT_COOLDOWN_HOURS || 6) * 3600 * 1000;
}

/**
 * Pure detection: given a client + a clock, return the tenants that need an
 * alert right now (erroring or stale for > 1h) with their state + message.
 * Exported for tests; the handler also consults sync_alert_log for dedup.
 */
export async function detectSyncAlerts(client, { now = Date.now() } = {}){
  if(!client) return { ok:false, error:'db_not_configured', alerts:[] };

  const since = new Date(now - RECENT_MS).toISOString();
  const [tenants, logs] = await Promise.all([
    client.from('tenants').select('id,slug,name,owner_email')
      .order('created_at', { ascending:false }).limit(500)
      .then(r => r.data || []),
    client.from('booking_sync_log')
      .select('tenant_id,provider,error_message,created_at')
      .gte('created_at', since)
      .order('created_at', { ascending:false })
      .limit(5000)
      .then(r => r.data || [])
  ]);

  // Latest run per tenant, the most recent SUCCESSFUL run, and the OLDEST
  // error run. Logs are newest-first, so the oldest error is the last one we
  // see for a tenant that has any error rows.
  const latest = new Map();
  const lastGood = new Map();
  const oldestError = new Map();
  for(const log of logs){
    if(!latest.has(log.tenant_id)) latest.set(log.tenant_id, log);
    if(!log.error_message && !lastGood.has(log.tenant_id)) lastGood.set(log.tenant_id, log);
    if(log.error_message && !oldestError.has(log.tenant_id)) oldestError.set(log.tenant_id, log);
  }

  const alerts = [];
  for(const t of tenants){
    const run = latest.get(t.id);
    if(!run) continue;                       // never synced — not an alert
    const runAt = new Date(run.created_at).getTime();

    let type = null;
    let detail = null;
    if(run.error_message){
      // Erroring for > 1h: either the last SUCCESSFUL run is over an hour old,
      // or (no success ever in the window) the OLDEST error is over an hour old.
      const goodAt = lastGood.get(t.id) ? new Date(lastGood.get(t.id).created_at).getTime() : null;
      const errorStartAt = oldestError.get(t.id) ? new Date(oldestError.get(t.id).created_at).getTime() : runAt;
      const persistMs = goodAt ? (now - goodAt) : (now - errorStartAt);
      if(persistMs > ERROR_PERSIST_MS){
        type = 'error';
        detail = run.error_message;
      }
    } else if((now - runAt) > STALE_AFTER_MS){
      type = 'stale';
      detail = `No successful sync in ${Math.round((now - runAt) / 3600000)}h`;
    }
    if(!type) continue;

    const ageMin = Math.round((now - runAt) / 60000);
    alerts.push({
      tenant_id: t.id, slug: t.slug, name: t.name, owner_email: t.owner_email || null,
      type,
      provider: run.provider || null,
      detail,
      last_run_at: run.created_at,
      age_min: ageMin,
      message: `LolaDesk sync ${type} — ${t.name} (${t.slug}) · ${run.provider || 'n/a'} · ${detail} · last run ${ageMin}m ago`
    });
  }
  return { ok:true, alerts };
}

// Injectable senders for tests (see tests/sync-alerts.test.mjs). When set,
// the handler routes notifications through them instead of real email/Slack.
let _injectedSenders = null;
export function __setSenders(senders){
  _injectedSenders = senders || null;
}

/**
 * Send one notification to the operator. Returns { sent, channels, error }.
 * Injectable senders for tests; defaults to SendEmail + Slack webhook.
 */
export async function notifyOperator(message, { email, senders = {} } = {}){
  const channels = [];
  const errors = [];

  const sendEmail = senders.email || (async (to, subject, body) => {
    return SendEmail({ to, subject, html: body, textContent: body, from: process.env.ALERT_FROM || 'LolaDesk <alerts@loladesk.com>' });
  });
  const sendSlack = senders.slack || (async (text) => {
    const url = process.env.SLACK_WEBHOOK_URL;
    if(!url) return { skipped: true, reason: 'SLACK_WEBHOOK_URL not set' };
    const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text }) });
    if(!r.ok) throw new Error(`Slack ${r.status}`);
    return { ok:true };
  });

  // Email recipient: ALERT_EMAIL, else first ADMIN_EMAILS entry.
  const to = email || process.env.ALERT_EMAIL
    || (process.env.ADMIN_EMAILS || '').split(',')[0]?.trim() || null;
  if(to){
    try{
      const r = await sendEmail(to, 'LolaDesk sync alert', `<div style="font-family:sans-serif;padding:16px"><h2 style="color:#ccff00">Sync alert</h2><p style="font-size:15px">${message.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p></div>`);
      if(r?.skipped) errors.push(r.reason); else channels.push('email');
    }catch(e){ errors.push(`email: ${String(e?.message || e)}`); }
  }

  if(process.env.SLACK_WEBHOOK_URL){
    try{
      const r = await sendSlack(`⚠️ ${message}`);
      if(r?.skipped) errors.push(r.reason); else channels.push('slack');
    }catch(e){ errors.push(`slack: ${String(e?.message || e)}`); }
  }

  if(!to && !process.env.SLACK_WEBHOOK_URL){
    errors.push('no notification channel configured (set ALERT_EMAIL / ADMIN_EMAILS or SLACK_WEBHOOK_URL)');
  }

  return { sent: channels.length > 0, channels, errors };
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok:false, error:'GET/POST only' });

  if(!process.env.CRON_SECRET) return res.status(503).json({ ok:false, error:'CRON_SECRET is not set — sync alerts disabled' });
  if(!authorized(req)) return res.status(401).json({ ok:false, error:'Unauthorized' });

  const client = db();
  if(!client) return res.status(503).json({ ok:false, error:'Database not configured' });

  try{
    const { ok, alerts, error } = await detectSyncAlerts(client);
    if(!ok) return res.status(500).json({ ok:false, error });

    // Dedup against sync_alert_log: skip tenants alerted within the cooldown.
    const cooldown = cooldownMs();
    const cutoff = new Date(Date.now() - cooldown).toISOString();
    const { data: sentRows } = await client.from('sync_alert_log').select('tenant_id,alert_type,last_sent_at');
    const sentMap = new Map((sentRows || []).map(r => [`${r.tenant_id}:${r.alert_type}`, r.last_sent_at]));

    const toNotify = [];
    for(const a of alerts){
      const last = sentMap.get(`${a.tenant_id}:${a.type}`);
      if(!last || new Date(last).getTime() < new Date(cutoff).getTime()) toNotify.push(a);
    }

    let notified = 0, skipped = 0;
    const results = [];
    for(const a of toNotify){
      const n = await notifyOperator(a.message, { senders: _injectedSenders });
      if(n.sent){
        notified++;
        await client.from('sync_alert_log').upsert(
          { tenant_id: a.tenant_id, alert_type: a.type, last_sent_at: new Date().toISOString(), last_error: a.detail },
          { onConflict: 'tenant_id,alert_type' }
        );
      } else {
        skipped++;
      }
      results.push({ tenant_id: a.tenant_id, type: a.type, sent: n.sent, channels: n.channels, errors: n.errors });
    }

    // Recovery: tenants that are healthy now should have their alert rows
    // cleared so a future flip alerts fresh. Collect all alerted tenants and
    // delete rows for any that are no longer in the alert set.
    const healthyIds = new Set((alerts || []).map(a => a.tenant_id));
    const activeIds = new Set((await client.from('sync_alert_log').select('tenant_id').then(r => r.data || [])).map(r => r.tenant_id));
    for(const id of activeIds){
      if(!healthyIds.has(id)) await client.from('sync_alert_log').delete().eq('tenant_id', id);
    }

    return res.status(200).json({ ok:true, detected: alerts.length, notified, skipped, results: results.slice(0, 20) });
  }catch(e){
    console.error('[sync-alerts]', e?.message || e);
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
}
