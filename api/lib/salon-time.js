/**
 * api/lib/salon-time.js — times in texts and on calls, in the SALON's timezone.
 * Vercel runs in UTC, so a bare toLocaleString() turned a 2 PM Miami booking
 * into "6:00 PM" in every confirmation, reminder and deposit text.
 */
import { db } from './db.js';

const cache = new Map(); // tenantId -> { tz, at }
export async function salonTz(tenantId) {
  if (!tenantId) return 'America/New_York';
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.tz;
  let tz = 'America/New_York';
  try {
    const { data } = await db().from('booking_settings').select('timezone').eq('tenant_id', tenantId).maybeSingle();
    if (data?.timezone) { new Intl.DateTimeFormat('en-US', { timeZone: data.timezone }); tz = data.timezone; }
  } catch (_) {}
  cache.set(tenantId, { tz, at: Date.now() });
  return tz;
}
/** "Tue, Sep 29, 2:00 PM" (style 'short') or "Tuesday, September 29 at 2:00 PM" ('long'). */
export function fmtSalon(iso, tz, style = 'short') {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const zone = tz || 'America/New_York';
  try {
    return style === 'long'
      ? d.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zone })
      : style === 'time'
        ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone })
        : d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zone });
  } catch (_) { return d.toISOString(); }
}
export async function whenForTenant(tenantId, iso, style = 'short') { return fmtSalon(iso, await salonTz(tenantId), style); }
