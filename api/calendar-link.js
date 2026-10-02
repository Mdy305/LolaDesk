/**
 * /api/calendar-link — connect any booking system by its calendar (.ics) link.
 *   GET                         → { ok, feeds:[{ label, staff_id, host }] }   (never the secret URL)
 *   POST { url, label?, staff_id? } → checks the link, saves it encrypted, syncs now → { ok, events }
 *   DELETE { index }            → removes one link
 * Owner-authenticated; every row is fenced to the owner's own salon.
 */
import { getUserFromToken, bearer } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db, upsertIntegration, getTenantIntegrations } from './lib/db.js';
import { normalizeUrl, fetchIcs, parseIcs, feedsOf, clearIcsCache } from './lib/connectors/ical.js';
import { syncTenantAvailability } from './lib/booking-sync.js';

const body = (req) => { const b = req.body; if (typeof b === 'string') { try { return JSON.parse(b || '{}'); } catch (_) { return {}; } } return b || {}; };
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return ''; } };
const guess = (u) => { const h = host(u); return /vagaro/.test(h) ? 'Vagaro' : /boulevard|blvd/.test(h) ? 'Boulevard' : /fresha/.test(h) ? 'Fresha' : /mindbody|mindbodyonline/.test(h) ? 'Mindbody' : /squareup|square/.test(h) ? 'Square' : /google/.test(h) ? 'Google Calendar' : /icloud|apple/.test(h) ? 'Apple Calendar' : /glossgenius/.test(h) ? 'GlossGenius' : /booksy/.test(h) ? 'Booksy' : 'Calendar'; };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const user = await getUserFromToken(bearer(req)).catch(() => null);
  if (!user) return res.status(401).json({ ok: false, error: 'not signed in' });
  const tenant = await resolveTenantForUser(user).catch(() => null);
  const c = db();
  if (!tenant?.id || !c) return res.status(404).json({ ok: false, error: 'no salon for this account' });
  const current = (await getTenantIntegrations(tenant.id).catch(() => [])).find((i) => i.provider === 'ical');
  const feeds = current ? feedsOf(current) : [];
  const tz = await c.from('booking_settings').select('timezone').eq('tenant_id', tenant.id).maybeSingle().then((r) => r.data?.timezone).catch(() => null) || 'America/New_York';
  const save = (list) => upsertIntegration(tenant.id, { provider: 'ical', accessToken: JSON.stringify(list), metadata: { timezone: tz, count: list.length, labels: list.map((f) => f.label) } });

  if (req.method === 'GET') {
    let staff = [];
    try { const { data } = await c.from('staff').select('id,name,is_active').eq('tenant_id', tenant.id); staff = (data || []).filter((x) => x.is_active !== false).map((x) => ({ id: x.id, name: x.name })); } catch (_) {}
    return res.json({ ok: true, feeds: feeds.map((f) => ({ label: f.label, staff_id: f.staff_id || null, host: host(f.url) })), staff });
  }

  if (req.method === 'POST') {
    const b = body(req);
    const url = normalizeUrl(b.url);
    if (!url) return res.status(400).json({ ok: false, error: 'Paste the calendar link that starts with https:// or webcal://' });
    let events = 0;
    try { const text = await fetchIcs(url); events = parseIcs(text, { defaultTz: tz }).length; }
    catch (e) { return res.status(400).json({ ok: false, error: `That link didn’t open as a calendar (${String(e?.message || e).slice(0, 80)}). Copy the “subscribe” / iCal link from your booking system.` }); }
    const label = String(b.label || guess(url)).slice(0, 40);
    const staff_id = b.staff_id ? String(b.staff_id).slice(0, 64) : null;
    const next = [...feeds.filter((f) => normalizeUrl(f.url) !== url), { url, label, staff_id }].slice(-20);
    await save(next);
    clearIcsCache();
    let synced = null;
    try { synced = await syncTenantAvailability(c, tenant.id, { provider: 'ical' }); } catch (_) {}
    return res.json({ ok: true, label, events, synced: synced?.upserted ?? null, say: `Connected ${label}. ${events} upcoming appointment${events === 1 ? '' : 's'} found — Lola won’t book over them.` });
  }

  if (req.method === 'DELETE') {
    const i = Number(body(req).index);
    if (!Number.isInteger(i) || i < 0 || i >= feeds.length) return res.status(400).json({ ok: false, error: 'unknown link' });
    const next = feeds.filter((_, k) => k !== i);
    if (next.length) await save(next);
    else { try { await c.from('integrations').update({ status: 'disconnected' }).eq('tenant_id', tenant.id).eq('provider', 'ical'); await c.from('cached_availability').delete().eq('tenant_id', tenant.id).eq('provider', 'ical'); } catch (_) {} }
    try { await syncTenantAvailability(c, tenant.id, { provider: 'ical' }); } catch (_) {}
    return res.json({ ok: true });
  }
  return res.status(405).json({ ok: false });
}
