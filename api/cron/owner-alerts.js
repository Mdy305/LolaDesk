/**
 * /api/cron/owner-alerts — Lola texts the owner when something needs them.
 * ════════════════════════════════════════════════════════════════════
 * Every 15 minutes (vercel.json crons). For each salon with an operator
 * phone (Settings → Call handling, or tell Lola "alert me at …"):
 *   · callers who asked for the owner, sounded unhappy, or were missed
 *   · cancellations for the next 48 hours
 * One short text, only when there is something. Never between 9pm and 8am
 * salon time (the night's items arrive at 8am), at most one text per 30 min,
 * and never when the owner turned alerts off ("Lola, stop alerts").
 * Requires CRON_SECRET (Vercel sends it as a Bearer token on cron runs).
 */
import { db, e164 } from '../lib/db.js';
import { getBookingSettings } from '../lib/booking-repository.js';
import { sendSms } from '../lib/sms.js';
import { awayBrief, alertText } from '../lib/owner-brief.js';

const MIN_GAP = 30 * 60e3;
const FIRST_LOOKBACK = 20 * 60e3;
const MAX_LOOKBACK = 14 * 3600e3;

async function getMem(c, tid, key) {
  try {
    const { data } = await c.from('client_memories').select('value').eq('tenant_id', tid).eq('client_phone', 'owner_alerts').eq('key', key).maybeSingle();
    return data?.value ?? null;
  } catch { return null; }
}
async function setMem(c, tid, key, value) {
  try { await c.from('client_memories').upsert({ tenant_id: tid, client_phone: 'owner_alerts', key, value }, { onConflict: 'tenant_id,client_phone,key' }); } catch {}
}
export function localHour(date, tz) {
  try { return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(date)) % 24; } catch { return date.getUTCHours(); }
}

export async function runOwnerAlerts(c, { now = new Date() } = {}) {
  const out = [];
  let tenants = [];
  try { const r = await c.from('tenants').select('*').limit(2000); tenants = r?.data || []; } catch { tenants = []; }
  for (const t of tenants) {
    const to = e164(t.operator_phone || t.owner_phone || '');
    if (!to || to === e164(t.phone_number || '')) continue;
    try {
      const enabled = await getMem(c, t.id, 'enabled');
      if (enabled && enabled.on === false) { out.push({ tenant: t.id, skipped: 'off' }); continue; }
      let tz = 'America/New_York';
      try { tz = (await getBookingSettings(t.id))?.timezone || tz; } catch {}
      const h = localHour(now, tz);
      if (h < 8 || h >= 21) { out.push({ tenant: t.id, skipped: 'quiet_hours' }); continue; }

      const cur = (await getMem(c, t.id, 'cursor')) || {};
      const lastSent = Date.parse(cur.sent_at || '') || 0;
      if (now - lastSent < MIN_GAP) { out.push({ tenant: t.id, skipped: 'recently_sent' }); continue; }
      let since = Date.parse(cur.at || '') || (now - FIRST_LOOKBACK);
      since = Math.max(since, now - MAX_LOOKBACK);

      const brief = await awayBrief(c, t, new Date(since).toISOString(), { now });
      const text = alertText(brief, t.name);
      if (!text) { await setMem(c, t.id, 'cursor', { ...cur, at: now.toISOString() }); out.push({ tenant: t.id, sent: false }); continue; }

      const r = await sendSms({ tenant: t, to, body: text });
      if (r && (r.skipped || r.error)) { out.push({ tenant: t.id, sent: false, reason: r.reason || String(r.error?.message || r.error) }); continue; }
      await setMem(c, t.id, 'cursor', { at: now.toISOString(), sent_at: now.toISOString() });
      out.push({ tenant: t.id, sent: true, items: brief.needs.length });
    } catch (e) {
      out.push({ tenant: t.id, error: String(e?.message || e) });
    }
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET/POST only' });
  if (!process.env.CRON_SECRET) return res.status(503).json({ ok: false, error: 'CRON_SECRET is not set' });
  if ((req.headers.authorization || '') !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const c = db();
  if (!c) return res.status(503).json({ ok: false, error: 'Database not configured' });
  const results = await runOwnerAlerts(c);
  return res.status(200).json({ ok: true, sent: results.filter(r => r.sent).length, results });
}
