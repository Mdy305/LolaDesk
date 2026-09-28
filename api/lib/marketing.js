/**
 * api/lib/marketing.js — Lola Marketing: audiences, campaigns, sending, results.
 * ════════════════════════════════════════════════════════════════
 * One engine for every text campaign (the Marketing page, Lola's
 * "launch_campaign" tool, and the every-minute sender cron):
 *   · audiences   — lapsed / VIP / booked tomorrow / recent / everyone, always
 *                   excluding opted-out clients, clients with no phone, and
 *                   anyone a campaign texted in the last 7 days
 *   · campaigns   — recipients are snapshotted when a campaign is created, so a
 *                   run can pause/resume/continue and nobody is texted twice
 *   · sending     — small paced batches through the one SMS funnel, only between
 *                   9am and 8pm salon time, "Reply STOP to opt out" on every text
 *   · results     — bookings those clients made within 14 days of the text
 * Tables: lola_campaigns, lola_campaign_recipients (sql/lola-marketing.sql).
 */
import { e164 } from './db.js';
import { sendSms } from './sms.js';
import { getBookingSettings } from './booking-repository.js';
import { localDateKey, dayBoundsUtc } from './timezone.js';

export const SEGMENTS = {
  lapsed:   { label: "Haven't been in a while", about: 'Last visit more than {days} days ago', days: 60 },
  vip:      { label: 'VIP clients', about: 'Your best clients' },
  recent:   { label: 'Recent guests', about: 'Visited in the last 30 days — rebook them' },
  tomorrow: { label: 'Booked tomorrow', about: 'Reminders, add-ons, upgrades' },
  all:      { label: 'Everyone', about: 'Every client who can receive texts' },
};
const FREQ_CAP_DAYS = 7;
const ATTRIBUTION_DAYS = 14;
const PACE_MS = 300;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function rows(p) { try { const r = await p; return (r && !r.error && Array.isArray(r.data)) ? r.data : []; } catch { return []; } }
const firstOf = (cl) => String(cl?.first_name || String(cl?.name || '').split(' ')[0] || '').trim();
const optedOut = (cl) => cl.opted_out === true || String(cl.status || '').toLowerCase() === 'opted_out';

export async function tenantTz(tenantId) {
  try { return (await getBookingSettings(tenantId))?.timezone || 'America/New_York'; } catch { return 'America/New_York'; }
}
export function localHour(date, tz) {
  try { return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(date)) % 24; } catch { return date.getUTCHours(); }
}
export const inSendingHours = (date, tz) => { const h = localHour(date, tz); return h >= 9 && h < 20; };

/** Clients in an audience, ready to text (deduped by phone). */
export async function loadClients(c, tenantId) { return rows(c.from('clients').select('*').eq('tenant_id', tenantId).limit(5000)); }
export async function recentlyTexted(c, tenantId, now = new Date()) {
  const since = new Date(now.getTime() - FREQ_CAP_DAYS * 864e5).toISOString();
  const recent = await rows(c.from('lola_campaign_recipients').select('phone').eq('tenant_id', tenantId).eq('status', 'sent').gte('sent_at', since).limit(20000));
  return new Set(recent.map(r => r.phone));
}

export async function audience(c, tenantId, segment, { days, now = new Date(), tz, clients, capped: cappedSet } = {}) {
  const seg = SEGMENTS[segment] ? segment : 'lapsed';
  const all = clients || await loadClients(c, tenantId);
  let pool = all.filter(cl => cl && e164(cl.phone) && !optedOut(cl));
  const d = Math.max(7, Math.min(730, Number(days) || SEGMENTS.lapsed.days));
  if (seg === 'lapsed') { const cut = now.getTime() - d * 864e5; pool = pool.filter(cl => cl.last_visit && Date.parse(cl.last_visit) < cut); }
  if (seg === 'recent') { const cut = now.getTime() - 30 * 864e5; pool = pool.filter(cl => cl.last_visit && Date.parse(cl.last_visit) >= cut); }
  if (seg === 'vip') pool = pool.filter(cl => cl.is_vip === true || String(cl.status || '').toLowerCase() === 'vip');
  if (seg === 'tomorrow') {
    const zone = tz || await tenantTz(tenantId);
    const [y, m, dd] = localDateKey(now, zone).split('-').map(Number);
    const key = new Date(Date.UTC(y, m - 1, dd + 1)).toISOString().slice(0, 10);
    const b = dayBoundsUtc(key, zone);
    const bk = await rows(c.from('bookings').select('client_id,status').eq('tenant_id', tenantId).gte('start_time', b.start).lt('start_time', b.end));
    const ids = new Set(bk.filter(x => !/^cancel/i.test(x.status || '')).map(x => x.client_id).filter(Boolean));
    pool = pool.filter(cl => ids.has(cl.id));
  }
  // Frequency cap: nobody gets a campaign text twice in a week.
  const capped = cappedSet || await recentlyTexted(c, tenantId, now);
  const seen = new Set(); const out = [];
  let cappedCount = 0;
  for (const cl of pool) {
    const ph = e164(cl.phone);
    if (seen.has(ph)) continue; seen.add(ph);
    if (capped.has(ph)) { cappedCount++; continue; }
    out.push({ client_id: cl.id, phone: ph, first_name: firstOf(cl), name: cl.name || [cl.first_name, cl.last_name].filter(Boolean).join(' ') });
  }
  return { segment: seg, days: seg === 'lapsed' ? d : null, recipients: out, capped: cappedCount };
}

export function personalize(message, first) {
  let t = String(message || '').replace(/\{\s*first_name\s*\}|\{\s*name\s*\}/gi, first || 'there').trim();
  if (!/\bstop\b|opt.?out|unsubscribe/i.test(t)) t += '\nReply STOP to opt out.';
  return t;
}

export async function createCampaign(c, tenant, { name, segment, days, message, createdBy = 'owner' }) {
  const msg = String(message || '').trim();
  if (!msg) return { ok: false, error: 'A message is required.' };
  if (msg.length > 480) return { ok: false, error: 'Keep the message under 480 characters (3 texts).' };
  const aud = await audience(c, tenant.id, segment, { days });
  if (!aud.recipients.length) return { ok: false, error: 'Nobody in that audience can be texted right now.', capped: aud.capped };
  const seg = SEGMENTS[aud.segment];
  const ins = await c.from('lola_campaigns').insert({
    tenant_id: tenant.id, name: String(name || seg.label).slice(0, 80), segment: aud.segment, segment_days: aud.days,
    message: msg, status: 'draft', created_by: createdBy, total: aud.recipients.length,
  }).select().single();
  if (ins.error || !ins.data) return { ok: false, error: ins.error?.message?.includes('lola_campaigns') ? 'Run sql/lola-marketing.sql in Supabase first.' : (ins.error?.message || 'Could not create the campaign.') };
  const camp = ins.data;
  for (let i = 0; i < aud.recipients.length; i += 500) {
    const chunk = aud.recipients.slice(i, i + 500).map(r => ({ campaign_id: camp.id, tenant_id: tenant.id, client_id: r.client_id, phone: r.phone, first_name: r.first_name || null, status: 'pending' }));
    const r = await c.from('lola_campaign_recipients').insert(chunk);
    if (r.error) { await c.from('lola_campaigns').update({ status: 'cancelled' }).eq('id', camp.id); return { ok: false, error: r.error.message }; }
  }
  return { ok: true, campaign: camp, total: aud.recipients.length, capped: aud.capped };
}

/** Send the next batch of one campaign. Safe to call repeatedly (cron + page). */
export async function sendBatch(c, tenant, campaign, { max = 25, deadline = Date.now() + 20000, now = new Date(), tz } = {}) {
  if (campaign.status !== 'sending') return { sent: 0, reason: campaign.status };
  const zone = tz || await tenantTz(tenant.id);
  if (!inSendingHours(now, zone)) return { sent: 0, reason: 'quiet_hours' };
  const pending = await rows(c.from('lola_campaign_recipients').select('*').eq('campaign_id', campaign.id).eq('status', 'pending').limit(max));
  let sent = 0, failed = 0, skipped = 0;
  for (const r of pending) {
    if (Date.now() > deadline) break;
    // Claim the row first so two senders never text the same person.
    const claim = await c.from('lola_campaign_recipients').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', r.id).eq('status', 'pending').select('id');
    if (claim.error || !(claim.data || []).length) continue;
    let res;
    try { res = await sendSms({ tenant, to: r.phone, body: personalize(campaign.message, r.first_name) }); }
    catch (e) { res = { errors: [{ detail: String(e?.message || e) }] }; }
    if (res && res.skipped) { skipped++; await c.from('lola_campaign_recipients').update({ status: 'skipped', error: res.reason || 'skipped', sent_at: null }).eq('id', r.id); }
    else if (res && (res.errors?.length || res.error)) { failed++; await c.from('lola_campaign_recipients').update({ status: 'failed', error: String(res.errors?.[0]?.detail || res.error?.message || res.error).slice(0, 300) }).eq('id', r.id); }
    else sent++;
    await sleep(PACE_MS);
  }
  const left = await rows(c.from('lola_campaign_recipients').select('id').eq('campaign_id', campaign.id).eq('status', 'pending').limit(1));
  if (!left.length) await c.from('lola_campaigns').update({ status: 'sent', finished_at: new Date().toISOString() }).eq('id', campaign.id).eq('status', 'sending');
  return { sent, failed, skipped, done: !left.length };
}

export async function startCampaign(c, tenant, id, opts = {}) {
  const { data: camp } = await c.from('lola_campaigns').select('*').eq('id', id).eq('tenant_id', tenant.id).maybeSingle();
  if (!camp) return { ok: false, error: 'Campaign not found.' };
  if (!['draft', 'paused'].includes(camp.status)) return { ok: false, error: `This campaign is ${camp.status}.` };
  const upd = await c.from('lola_campaigns').update({ status: 'sending', started_at: camp.started_at || new Date().toISOString() }).eq('id', id).select().single();
  const running = upd.data || { ...camp, status: 'sending' };
  const batch = await sendBatch(c, tenant, running, opts);
  return { ok: true, campaign: running, batch };
}

export async function setStatus(c, tenant, id, status) {
  const allowed = { pause: ['sending'], cancel: ['draft', 'sending', 'paused'] };
  const next = status === 'pause' ? 'paused' : 'cancelled';
  const { data: camp } = await c.from('lola_campaigns').select('status').eq('id', id).eq('tenant_id', tenant.id).maybeSingle();
  if (!camp) return { ok: false, error: 'Campaign not found.' };
  if (!allowed[status].includes(camp.status)) return { ok: false, error: `This campaign is ${camp.status}.` };
  await c.from('lola_campaigns').update({ status: next, ...(next === 'cancelled' ? { finished_at: new Date().toISOString() } : {}) }).eq('id', id);
  return { ok: true, status: next };
}

/** Campaigns with delivery + results (bookings within 14 days of the text). */
export async function campaignsWithStats(c, tenantId, { limit = 20 } = {}) {
  const camps = await rows(c.from('lola_campaigns').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(limit));
  if (!camps.length) return [];
  const ids = camps.map(x => x.id);
  const recs = await rows(c.from('lola_campaign_recipients').select('campaign_id,client_id,status,sent_at').in('campaign_id', ids).limit(50000));
  const clientIds = [...new Set(recs.filter(r => r.status === 'sent' && r.client_id).map(r => r.client_id))];
  const oldest = camps.reduce((m, x) => Math.min(m, Date.parse(x.started_at || x.created_at) || Infinity), Infinity);
  const bks = clientIds.length && Number.isFinite(oldest)
    ? await rows(c.from('bookings').select('id,client_id,created_at,total_amount,status').eq('tenant_id', tenantId).gte('created_at', new Date(oldest).toISOString()).in('client_id', clientIds.slice(0, 1000)))
    : [];
  return camps.map(camp => {
    const mine = recs.filter(r => r.campaign_id === camp.id);
    const count = (s) => mine.filter(r => r.status === s).length;
    const sentTo = new Map(mine.filter(r => r.status === 'sent' && r.client_id).map(r => [r.client_id, Date.parse(r.sent_at || camp.started_at || camp.created_at)]));
    const won = bks.filter(b => !/^cancel/i.test(b.status || '') && sentTo.has(b.client_id) && Date.parse(b.created_at) >= sentTo.get(b.client_id) && Date.parse(b.created_at) <= sentTo.get(b.client_id) + ATTRIBUTION_DAYS * 864e5);
    const wonClients = new Set(won.map(b => b.client_id));
    return {
      id: camp.id, name: camp.name, segment: camp.segment, segment_days: camp.segment_days, message: camp.message, status: camp.status,
      created_at: camp.created_at, started_at: camp.started_at, finished_at: camp.finished_at,
      total: camp.total || mine.length, sent: count('sent'), failed: count('failed'), skipped: count('skipped'), pending: count('pending'),
      booked: wonClients.size, revenue: Math.round(won.reduce((s, b) => s + (Number(b.total_amount) || 0), 0)),
    };
  });
}

/** Every-minute sender: continue all campaigns that are sending. */
export async function runSender(c, { budgetMs = 45000, now = new Date() } = {}) {
  const deadline = Date.now() + budgetMs;
  const camps = await rows(c.from('lola_campaigns').select('*').eq('status', 'sending').order('started_at', { ascending: true }).limit(50));
  const out = [];
  const tenants = new Map();
  for (const camp of camps) {
    if (Date.now() > deadline - 3000) break;
    let t = tenants.get(camp.tenant_id);
    if (!t) { const r = await c.from('tenants').select('*').eq('id', camp.tenant_id).maybeSingle(); t = r.data; tenants.set(camp.tenant_id, t); }
    if (!t) continue;
    const res = await sendBatch(c, t, camp, { max: 30, deadline: Math.min(deadline, Date.now() + 15000), now });
    out.push({ campaign: camp.id, ...res });
  }
  return out;
}
