/**
 * /api/marketing — Lola Marketing (owner-only, tenant-scoped)
 *   GET                         → { plan, audiences, campaigns, booking_link, sending_hours }
 *   POST { action:'draft', segment, days, goal }          → { message }   (Lola writes the text)
 *   POST { action:'launch', name, segment, days, message } → creates + starts, first batch now
 *   POST { action:'test', message }                        → texts the owner's phone
 *   POST { action:'pause'|'resume'|'cancel', id }
 *   30-day fill plan (Lola as Marketing VP):
 *   POST { action:'plan_build' }                       → rebuild with fresh numbers
 *   POST { action:'plan_approve'|'plan_pause', id }
 *   POST { action:'plan_autopilot', id, on }           → send without asking
 *   POST { action:'plan_skip', id, key } · { action:'plan_edit', id, key, message }
 */
import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db, e164 } from './lib/db.js';
import { chat } from './lib/llm.js';
import { sendSms } from './lib/sms.js';
import { parseKnowledge } from './lib/business-learn.js';
import { buildFillPlan, latestPlan, setPlanStatus, skipItem, editItem } from './lib/fill-plan.js';
import { clientHistory } from './lib/client-history.js';
import { bookingLinkFor } from './lib/booking-link.js';
import { SEGMENTS, audience, loadClients, recentlyTexted, createCampaign, startCampaign, setStatus, campaignsWithStats, personalize, tenantTz, inSendingHours } from './lib/marketing.js';

function bookingLink(req, tenant) {
  return bookingLinkFor(tenant) || null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no salon for this account' });
    const c = db();
    if (!c) return res.status(503).json({ ok: false, error: 'database not configured' });
    const tz = await tenantTz(tenant.id);

    if (req.method === 'GET') {
      const k = parseKnowledge(tenant.knowledge);
      const [clients, capped] = await Promise.all([loadClients(c, tenant.id), recentlyTexted(c, tenant.id)]);
      const history = await clientHistory(c, tenant.id, { clients });
      const segs = await Promise.all(Object.keys(SEGMENTS).map(async (id) => {
        const a = await audience(c, tenant.id, id, { tz, clients, capped, history, days: id === 'lapsed' ? Number(req.query?.days) || undefined : undefined });
        return { id, label: SEGMENTS[id].label, about: SEGMENTS[id].about.replace('{days}', a.days || 60), days: a.days, count: a.recipients.length, capped: a.capped, sample: a.recipients.slice(0, 3).map(r => r.first_name).filter(Boolean) };
      }));
      const bk = await c.from('bookings').select('total_amount').eq('tenant_id', tenant.id).gte('created_at', new Date(Date.now() - 90 * 864e5).toISOString()).limit(2000);
      const vals = (bk.data || []).map(b => Number(b.total_amount) || 0).filter(v => v > 0);
      const avgTicket = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
      let campaigns = [], tablesReady = true;
      const probe = await c.from('lola_campaigns').select('id').limit(1);
      if (probe.error) tablesReady = false; else campaigns = await campaignsWithStats(c, tenant.id);
      let fillPlan = null, planReady = true;
      const pp = await c.from('lola_fill_plans').select('id').limit(1);
      if (pp.error) planReady = false; else fillPlan = await latestPlan(c, tenant.id);
      if (fillPlan) {
        const stats = new Map(campaigns.map(x => [x.id, x]));
        fillPlan = { ...fillPlan, items: (fillPlan.items || []).map(it => it.campaign_id && stats.get(it.campaign_id) ? { ...it, result: (({ sent, booked, revenue, status }) => ({ sent, booked, revenue, status }))(stats.get(it.campaign_id)) } : it) };
      }
      return res.json({
        ok: true, tables_ready: tablesReady, salon: tenant.name, avg_ticket: avgTicket, booking_link: bookingLink(req, tenant),
        sending_now: inSendingHours(new Date(), tz), timezone: tz,
        plan: { ideal_client: k.marketing?.ideal_client || k.audience || null, opportunities: k.marketing?.opportunities || [], first_campaign: k.marketing?.first_campaign || null, tone: k.tone || null },
        audiences: segs, campaigns, fill_plan: fillPlan, fill_plan_ready: planReady,
      });
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET/POST only' });
    let b = req.body || {}; if (typeof b === 'string') { try { b = JSON.parse(b || '{}'); } catch { b = {}; } }
    const action = String(b.action || '');

    if (action === 'draft') {
      const k = parseKnowledge(tenant.knowledge);
      const seg = SEGMENTS[b.segment] ? b.segment : 'lapsed';
      const link = b.include_link === false ? null : bookingLink(req, tenant);
      const system = [
        `You write SMS marketing for ${tenant.name || 'a salon'} as Lola, their front desk.`,
        k.tone ? `Brand voice: ${k.tone}.` : '', k.summary ? `About: ${k.summary}` : '', k.usp ? `Special: ${k.usp}` : '',
        `Audience: ${SEGMENTS[seg].label} (${SEGMENTS[seg].about.replace('{days}', b.days || 60)}).`,
        b.goal ? `Owner's goal: ${String(b.goal).slice(0, 300)}` : '',
        'Write ONE text message, max 230 characters, warm and personal, starting with "Hi {first_name}". One clear reason to book now. No hashtags, no emojis unless it fits the brand, never invent discounts the owner did not ask for.',
        link ? `End with: Book: ${link}` : 'Ask them to reply to book.',
        'Do not add an opt-out line (it is added automatically). Reply with the message text only.',
      ].filter(Boolean).join('\n');
      const r = await Promise.race([chat({ system, messages: [{ role: 'user', content: 'Write it.' }], maxTokens: 300, temperature: 0.7 }), new Promise(z => setTimeout(() => z({ ok: false }), 25000))]);
      let message = r?.ok ? String(r.text || '').trim().replace(/^["'“]|["'”]$/g, '') : '';
      if (!message) message = `Hi {first_name}! It's been a while and we miss you at ${tenant.name}. ${link ? `Book your next visit: ${link}` : 'Reply to book your next visit.'}`;
      return res.json({ ok: true, message: message.slice(0, 480) });
    }
    if (action === 'test') {
      const to = e164(tenant.operator_phone || tenant.owner_phone || '');
      if (!to) return res.status(400).json({ ok: false, error: 'Set your mobile in Settings (or tell Lola "alert me at …") to receive test texts.' });
      const out = await sendSms({ tenant, to, body: personalize(String(b.message || ''), (tenant.owner_name || 'there').split(' ')[0]) });
      if (out?.skipped || out?.errors?.length) return res.status(502).json({ ok: false, error: out.reason || out.errors?.[0]?.detail || 'Test text failed.' });
      return res.json({ ok: true, to });
    }
    if (action === 'launch') {
      const made = await createCampaign(c, tenant, { name: b.name, segment: b.segment, days: b.days, message: b.message, createdBy: 'owner' });
      if (!made.ok) return res.status(400).json(made);
      const started = await startCampaign(c, tenant, made.campaign.id, { max: 20, deadline: Date.now() + 15000, tz });
      return res.json({ ok: true, id: made.campaign.id, total: made.total, capped: made.capped, first_batch: started.batch, sending_now: inSendingHours(new Date(), tz) });
    }
    if (action === 'plan_build') {
      const r = await buildFillPlan(c, tenant, { reason: 'owner' });
      return res.status(r.ok ? 200 : 400).json(r);
    }
    if (action === 'plan_approve' || action === 'plan_pause') { const r = await setPlanStatus(c, tenant, b.id, action === 'plan_approve' ? 'approve' : 'pause'); return res.status(r.ok ? 200 : 400).json(r); }
    if (action === 'plan_autopilot') { const r = await setPlanStatus(c, tenant, b.id, b.on ? 'autopilot_on' : 'autopilot_off'); return res.status(r.ok ? 200 : 400).json(r); }
    if (action === 'plan_skip') { const r = await skipItem(c, tenant, b.id, b.key); return res.status(r.ok ? 200 : 400).json(r); }
    if (action === 'plan_edit') { const r = await editItem(c, tenant, b.id, b.key, b.message); return res.status(r.ok ? 200 : 400).json(r); }
    if (action === 'resume') { const r = await startCampaign(c, tenant, b.id, { max: 20, deadline: Date.now() + 15000, tz }); return res.status(r.ok ? 200 : 400).json(r); }
    if (action === 'pause' || action === 'cancel') { const r = await setStatus(c, tenant, b.id, action); return res.status(r.ok ? 200 : 400).json(r); }
    return res.status(400).json({ ok: false, error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
