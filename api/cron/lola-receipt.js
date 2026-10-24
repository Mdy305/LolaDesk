/**
 * /api/cron/lola-receipt — Monday morning, Lola texts the owner her week.
 * ════════════════════════════════════════════════════════════════════
 *   "Lola's week at MMA Salon: I answered 41 calls and booked 12
 *    appointments worth $2,340. https://www.loladesk.com/dashboard"
 *
 * Runs every hour on Mondays (vercel.json). Each salon gets it once, at
 * 9am in its own time zone, covering the 7 days before. Nothing is sent
 * when nothing happened. Same owner phone, same off switch ("Lola, stop
 * alerts") and same salon line as /api/cron/owner-alerts.
 *
 * Replaces api/weekly-report.js, which only logged "Simulated email sent".
 * Requires CRON_SECRET (Vercel sends it as a Bearer token on cron runs).
 */
import { db, e164 } from '../lib/db.js';
import { cronAuthorized } from '../lib/cron-auth.js';
import { getBookingSettings } from '../lib/booking-repository.js';
import { sendSms } from '../lib/sms.js';
import { lolaReceipt, receiptText } from '../lib/lola-receipt.js';
import { localHour } from './owner-alerts.js';

const SEND_HOUR = 9;
const DAY = 864e5;

async function getMem(c, tid, key) {
  try {
    const { data } = await c.from('client_memories').select('value').eq('tenant_id', tid).eq('client_phone', 'owner_alerts').eq('key', key).maybeSingle();
    return data?.value ?? null;
  } catch { return null; }
}
async function setMem(c, tid, key, value) {
  try { await c.from('client_memories').upsert({ tenant_id: tid, client_phone: 'owner_alerts', key, value }, { onConflict: 'tenant_id,client_phone,key' }); } catch {}
}
function localDate(date, tz) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date); } catch { return date.toISOString().slice(0, 10); }
}
function localWeekday(date, tz) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(date); } catch { return ''; }
}
const appBase = () => String(process.env.APP_URL || 'https://www.loladesk.com').replace(/\/+$/, '');

export async function runLolaReceipts(c, { now = new Date() } = {}) {
  const out = [];
  let tenants = [];
  try { tenants = (await c.from('tenants').select('*').limit(5000)).data || []; } catch { return out; }
  for (const t of tenants) {
    try {
      const to = e164(t.operator_phone || t.owner_phone || '');
      if (!to || to === e164(t.phone_number || '')) { out.push({ tenant: t.id, skipped: 'no_owner_phone' }); continue; }
      if (!t.phone_number) { out.push({ tenant: t.id, skipped: 'no_lola_line' }); continue; }
      const enabled = await getMem(c, t.id, 'enabled');
      if (enabled && enabled.on === false) { out.push({ tenant: t.id, skipped: 'off' }); continue; }

      let tz = 'America/New_York';
      try { tz = (await getBookingSettings(t.id))?.timezone || tz; } catch {}
      if (localWeekday(now, tz) !== 'Mon' || localHour(now, tz) !== SEND_HOUR) { out.push({ tenant: t.id, skipped: 'not_monday_9am' }); continue; }

      const week = localDate(now, tz);
      const last = await getMem(c, t.id, 'receipt');
      if (last && last.week === week) { out.push({ tenant: t.id, skipped: 'sent' }); continue; }

      const r = await lolaReceipt(c, t.id, { since: new Date(now - 7 * DAY).toISOString(), until: now.toISOString() });
      const body = receiptText(r, { salon: t.name || '', link: `${appBase()}/dashboard` });
      if (!body) { await setMem(c, t.id, 'receipt', { week, sent: false }); out.push({ tenant: t.id, sent: false, reason: 'quiet_week' }); continue; }

      const s = await sendSms({ tenant: t, to, body });
      if (s && (s.skipped || s.error)) { out.push({ tenant: t.id, sent: false, reason: s.reason || String(s.error?.message || s.error) }); continue; }
      await setMem(c, t.id, 'receipt', { week, sent: true, ...r });
      out.push({ tenant: t.id, sent: true, ...r });
    } catch (e) {
      out.push({ tenant: t.id, error: String(e?.message || e) });
    }
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET/POST only' });
  if (!cronAuthorized(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const c = db();
  if (!c) return res.status(503).json({ ok: false, error: 'Database not configured' });
  const results = await runLolaReceipts(c);
  return res.status(200).json({ ok: true, sent: results.filter((r) => r.sent).length, results });
}
