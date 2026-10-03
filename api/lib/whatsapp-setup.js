/**
 * api/lib/whatsapp-setup.js — WhatsApp for each salon, on LolaDesk's Telnyx account.
 * ════════════════════════════════════════════════════════════════════
 * Putting a number on WhatsApp is a Meta "embedded signup" done in the Telnyx
 * portal (there is no API for it). Everything after that is automatic here,
 * using only documented Telnyx WhatsApp endpoints:
 *   (a) GET /v2/whatsapp/business_accounts + GET /v2/whatsapp/phone_numbers?waba_id=
 *       → every number that is on a WhatsApp Business Account (WABA)
 *   (b) match each number to exactly ONE salon (tenant_numbers / tenants.phone_number)
 *       → tenant_channels (channel 'whatsapp', account_id = the number) + tenants.whatsapp_enabled
 *   (c) the number is on LolaDesk's messaging profile (verify_ownership → /phone_numbers/{id}/messaging)
 *   (d) the salon's utility templates exist on its WABA (POST /v2/whatsapp/message_templates),
 *       tracked in whatsapp_templates and re-synced nightly (GET /v2/whatsapp/message_templates)
 *   (e) status in plain words for the salon/Lola; the exact portal step for the admin.
 * Sending: inside 24h of the client's last WhatsApp message → free text; outside it →
 * an APPROVED template only (planWhatsApp); no approved template → the text goes by SMS.
 */
import { telnyxRequest, telnyxData, normalizeE164 } from './telnyx-client.js';
import { logUsage } from './db.js';
import { saveChannelRow } from './channel-store.js';

const WINDOW_MS = 24 * 3600e3;
export const LANGUAGE = 'en_US';

/** The salon's utility templates: {{1}}… parameters, realistic samples for Meta's reviewers. */
export const TEMPLATES = [
  {
    name: 'booking_confirmation', category: 'UTILITY', language: LANGUAGE,
    text: 'Hi {{1}}, your {{2}} appointment at {{3}} is confirmed for {{4}}. Reply to this message if you need to change anything.',
    sample: ['Sarah', 'Balayage', 'MMA Salon', 'Saturday, October 11 at 2:00 PM']
  },
  {
    name: 'appointment_reminder', category: 'UTILITY', language: LANGUAGE,
    text: 'Hi {{1}}, this is a reminder of your {{2}} appointment at {{3}} on {{4}}. Reply to this message if you need to reschedule.',
    sample: ['Sarah', 'Blowout', 'MMA Salon', 'Tuesday, October 14 at 11:00 AM']
  },
  {
    name: 'missed_call_followup', category: 'UTILITY', language: LANGUAGE,
    text: 'Hi, this is {{1}}. Sorry we missed your call! Reply to this message and we will help you book or answer any questions.',
    sample: ['MMA Salon']
  }
];
export const templateBody = (t) => ({ waba_id: null, name: t.name, category: t.category, language: t.language, components: [{ type: 'BODY', text: t.text, example: { body_text: [t.sample] } }] });

const list = (p) => { const d = telnyxData(p); return Array.isArray(d) ? d : []; };
const pretty = (e) => { const d = String(e || '').replace(/\D/g, ''); return d.length === 11 && d[0] === '1' ? `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}` : String(e || ''); };

// ── (a) Numbers on WhatsApp Business Accounts ───────────────────
export async function wabaNumbers() {
  const wabas = list(await telnyxRequest('/whatsapp/business_accounts', { query: { 'page[size]': 50 }, timeoutMs: 10000 }));
  const out = [];
  for (const w of wabas) {
    let nums = [];
    try { nums = list(await telnyxRequest('/whatsapp/phone_numbers', { query: { waba_id: w.id }, timeoutMs: 10000 })); } catch (_) { nums = []; }
    for (const n of nums) {
      const phone = normalizeE164(n.phone_number); if (!phone) continue;
      out.push({ phone_number: phone, waba_id: w.id, meta_waba_id: w.waba_id || null, waba_name: w.name || null, waba_status: w.status || null, number_id: n.number_id || null, quality_rating: n.quality_rating || null, messaging_limit_tier: n.messaging_limit_tier || null });
    }
  }
  return { wabas: wabas.map((w) => ({ id: w.id, waba_id: w.waba_id || null, name: w.name || null, status: w.status || null })), numbers: out };
}

// ── (b) Which salon owns each number (strict: one owner, never a guess) ──
export async function salonNumberMap(c, tenantId = null) {
  const map = new Map();
  const add = (phone, tid) => { const p = normalizeE164(phone); if (!p || !tid) return; if (!map.has(p)) map.set(p, new Set()); map.get(p).add(String(tid)); };
  try { const { data } = await c.from('tenant_numbers').select('tenant_id,phone_number,status').limit(5000); for (const r of data || []) if (r.status !== 'released') add(r.phone_number, r.tenant_id); } catch (_) {}
  try { const { data } = await c.from('tenants').select('id,phone_number').limit(5000); for (const t of data || []) add(t.phone_number, t.id); } catch (_) {}
  if (tenantId) for (const [k, v] of map) if (!v.has(String(tenantId))) map.delete(k);
  return map;
}
export function matchNumbers(numbers, map) {
  return numbers.map((n) => {
    const owners = [...(map.get(n.phone_number) || [])];
    return { ...n, tenant_id: owners.length === 1 ? owners[0] : null, conflict: owners.length > 1 ? owners : null };
  });
}

// ── (c) The number is on LolaDesk's messaging profile ─────────────
export async function ensureOnMessagingProfile(c, phone) {
  try {
    const { messagingProfileId } = await import('./telnyx-account.js');
    const mp = await messagingProfileId(c);
    if (!mp) return { ok: false, reason: 'no_messaging_profile' };
    const v = telnyxData(await telnyxRequest('/phone_numbers/actions/verify_ownership', { method: 'POST', body: { phone_numbers: [phone] }, timeoutMs: 8000 }));
    const found = (v && Array.isArray(v.found) ? v.found : []).find((f) => normalizeE164(f.phone_number) === phone) || (v && v.found && v.found[0]);
    if (!found || !found.id) return { ok: false, reason: 'not_on_account' };
    const m = telnyxData(await telnyxRequest('/phone_numbers/' + encodeURIComponent(found.id) + '/messaging', { timeoutMs: 8000 }));
    if (m && m.messaging_profile_id === mp) return { ok: true, healed: false };
    await telnyxRequest('/phone_numbers/' + encodeURIComponent(found.id) + '/messaging', { method: 'PATCH', body: { messaging_profile_id: mp }, timeoutMs: 8000 });
    return { ok: true, healed: true };
  } catch (e) { return { ok: false, reason: String(e?.message || e).slice(0, 160) }; }
}

// ── (d) Templates on the salon's WABA ───────────────────────────
async function upsertTemplateRow(c, row) {
  const r = { ...row, updated_at: new Date().toISOString() };
  let { error } = await c.from('whatsapp_templates').upsert(r, { onConflict: 'waba_id,name,language' });
  if (error) { try { const { ensureMigrations, resetMigrations } = await import('./migrate.js'); resetMigrations(); await ensureMigrations(); } catch (_) {} ({ error } = await c.from('whatsapp_templates').upsert(r, { onConflict: 'waba_id,name,language' })); }
  return !error;
}
export async function ensureTemplates(c, { wabaId, tenantId = null }) {
  const out = { created: [], existing: [], failed: [] };
  if (!wabaId) return out;
  let have = [];
  try { have = list(await telnyxRequest('/whatsapp/message_templates', { query: { waba_id: wabaId, 'page[size]': 250 }, timeoutMs: 10000 })); } catch (_) { have = []; }
  for (const t of TEMPLATES) {
    const live = have.find((h) => h.name === t.name && (h.language || LANGUAGE) === t.language);
    if (live) {
      out.existing.push(t.name);
      await upsertTemplateRow(c, { waba_id: wabaId, name: t.name, language: t.language, category: live.category || t.category, telnyx_template_id: live.id || null, status: String(live.status || 'PENDING').toUpperCase(), reason: null, tenant_id: tenantId });
      continue;
    }
    try {
      const body = { ...templateBody(t), waba_id: wabaId };
      const d = telnyxData(await telnyxRequest('/whatsapp/message_templates', { method: 'POST', body, timeoutMs: 15000 }));
      out.created.push(t.name);
      await upsertTemplateRow(c, { waba_id: wabaId, name: t.name, language: t.language, category: t.category, telnyx_template_id: d?.id || null, status: String(d?.status || 'PENDING').toUpperCase(), reason: null, tenant_id: tenantId });
      if (tenantId) { try { await logUsage(tenantId, 'cost_whatsapp_template', 1, { template: t.name }); } catch (_) {} }
    } catch (e) {
      out.failed.push({ name: t.name, error: String(e?.message || e).slice(0, 200) });
      await upsertTemplateRow(c, { waba_id: wabaId, name: t.name, language: t.language, category: t.category, telnyx_template_id: null, status: 'NOT_SUBMITTED', reason: String(e?.message || e).slice(0, 200), tenant_id: tenantId });
    }
  }
  return out;
}

/** Nightly: Meta's verdict on every template LolaDesk tracks. */
export async function syncTemplateStatuses(c) {
  const out = { wabas: 0, updated: 0 };
  let rows = [];
  try { const { data } = await c.from('whatsapp_templates').select('*').limit(5000); rows = data || []; } catch (_) { return out; }
  const wabas = [...new Set(rows.map((r) => r.waba_id).filter(Boolean))];
  for (const w of wabas) {
    out.wabas++;
    let have = [];
    try { have = list(await telnyxRequest('/whatsapp/message_templates', { query: { waba_id: w, 'page[size]': 250 }, timeoutMs: 10000 })); } catch (_) { continue; }
    for (const r of rows.filter((x) => x.waba_id === w)) {
      const live = have.find((h) => (r.telnyx_template_id && h.id === r.telnyx_template_id) || (h.name === r.name && (h.language || LANGUAGE) === r.language));
      if (!live) continue;
      const status = String(live.status || r.status).toUpperCase();
      if (status !== r.status || (live.id && live.id !== r.telnyx_template_id)) {
        try { await c.from('whatsapp_templates').update({ status, telnyx_template_id: live.id || r.telnyx_template_id, reason: status === 'APPROVED' ? null : r.reason || null, updated_at: new Date().toISOString() }).eq('waba_id', w).eq('name', r.name).eq('language', r.language); out.updated++; } catch (_) {}
      }
    }
  }
  return out;
}

// ── The whole sweep ────────────────────────────────────────────
async function markRequestDone(c, tenantId) {
  try { await c.from('tenant_channels').update({ status: 'done', updated_at: new Date().toISOString() }).eq('channel', 'whatsapp_request').eq('account_id', String(tenantId)); } catch (_) {}
}
/** (a)+(b)+(c)+(d): every WABA number → its one salon. tenantId limits it to one salon. */
export async function syncWhatsApp(c, { tenantId = null, createTemplates = true, force = false } = {}) {
  const res = { ok: true, matched: [], unmatched: [], conflicts: [], errors: [] };
  let found;
  try { found = await wabaNumbers(); } catch (e) { return { ...res, ok: false, error: String(e?.message || e).slice(0, 200) }; }
  const map = await salonNumberMap(c, tenantId);
  const rows = matchNumbers(found.numbers, map);
  for (const n of rows) {
    if (n.conflict) { res.conflicts.push({ phone_number: n.phone_number, tenants: n.conflict }); continue; }
    if (!n.tenant_id) { if (!tenantId) res.unmatched.push({ phone_number: n.phone_number, waba_id: n.waba_id }); continue; }
    const now = new Date().toISOString();
    let prev = null;
    try { const { data } = await c.from('tenant_channels').select('tenant_id,status,meta').eq('channel', 'whatsapp').eq('account_id', n.phone_number).maybeSingle(); prev = data || null; } catch (_) {}
    // Already set up for this salon on this WABA → just refresh the details (keeps the nightly sweep fast).
    const settled = !force && prev && String(prev.tenant_id) === String(n.tenant_id) && prev.status === 'active' && prev.meta && prev.meta.waba_id === n.waba_id && prev.meta.templates_ensured;
    let saved;
    try {
      saved = await saveChannelRow(c, {
        tenant_id: n.tenant_id, channel: 'whatsapp', account_id: n.phone_number, username: n.waba_name || null, access_token: null, expires_at: null,
        status: 'active', updated_at: now, last_error: null,
        meta: { waba_id: n.waba_id, meta_waba_id: n.meta_waba_id, waba_name: n.waba_name, number_id: n.number_id, quality_rating: n.quality_rating, messaging_limit_tier: n.messaging_limit_tier, synced_at: now, templates_ensured: !!settled }
      });
    } catch (e) { res.errors.push({ phone_number: n.phone_number, error: String(e?.message || e).slice(0, 160) }); continue; }
    if (!saved.ok) { res.conflicts.push({ phone_number: n.phone_number, tenants: [n.tenant_id], reason: 'held_by_another_salon' }); continue; }
    try { await c.from('tenants').update({ whatsapp_enabled: true }).eq('id', n.tenant_id); } catch (_) {}
    await markRequestDone(c, n.tenant_id);
    if (settled) { res.matched.push({ tenant_id: n.tenant_id, phone_number: n.phone_number, waba_id: n.waba_id, settled: true }); continue; }
    const profile = await ensureOnMessagingProfile(c, n.phone_number);
    const templates = createTemplates ? await ensureTemplates(c, { wabaId: n.waba_id, tenantId: n.tenant_id }) : null;
    if (templates && !templates.failed.length && profile.ok) {
      try { await c.from('tenant_channels').update({ meta: { waba_id: n.waba_id, meta_waba_id: n.meta_waba_id, waba_name: n.waba_name, number_id: n.number_id, quality_rating: n.quality_rating, messaging_limit_tier: n.messaging_limit_tier, synced_at: now, templates_ensured: true } }).eq('channel', 'whatsapp').eq('account_id', n.phone_number); } catch (_) {}
    }
    res.matched.push({ tenant_id: n.tenant_id, phone_number: n.phone_number, waba_id: n.waba_id, messaging_profile: profile, templates });
  }
  return res;
}

// ── Reads ──────────────────────────────────────────────────────
export async function whatsappRow(c, tenantId) {
  try { const { data } = await c.from('tenant_channels').select('*').eq('tenant_id', tenantId).eq('channel', 'whatsapp').eq('status', 'active').limit(1).maybeSingle(); return data || null; } catch (_) { return null; }
}
export async function requestRow(c, tenantId) {
  try { const { data } = await c.from('tenant_channels').select('*').eq('channel', 'whatsapp_request').eq('account_id', String(tenantId)).maybeSingle(); return data && String(data.tenant_id) === String(tenantId) ? data : null; } catch (_) { return null; }
}
export async function templatesFor(c, wabaId) {
  if (!wabaId) return [];
  try { const { data } = await c.from('whatsapp_templates').select('*').eq('waba_id', wabaId); return data || []; } catch (_) { return []; }
}
async function salonLine(c, tenant) {
  try {
    const { data } = await c.from('tenant_numbers').select('phone_number,kind,status').eq('tenant_id', tenant.id);
    const l = (data || []).filter((r) => r.phone_number && r.status !== 'released');
    const pick = l.find((r) => r.kind === 'primary') || l[0];
    if (pick) return normalizeE164(pick.phone_number);
  } catch (_) {}
  return normalizeE164(tenant.phone_number);
}

/** (e) Status in plain words. admin:true adds the exact Telnyx portal step and raw detail. */
export async function whatsappStatus(c, tenant, { admin = false } = {}) {
  const line = await salonLine(c, tenant);
  const row = await whatsappRow(c, tenant.id);
  if (row) {
    const tpl = await templatesFor(c, row.meta && row.meta.waba_id);
    const approved = tpl.filter((t) => t.status === 'APPROVED').map((t) => t.name);
    const ready = approved.includes('appointment_reminder');
    const say = `WhatsApp is on for ${pretty(row.account_id)}. Clients can message you there and Lola answers.` + (ready ? ' Reminders go out on WhatsApp to clients who use it.' : ' Meta is still approving your reminder messages — until then, reminders go by text.');
    const out = { ok: true, state: 'on', on: true, number: pretty(row.account_id), reminders_on_whatsapp: ready, say };
    if (admin) Object.assign(out, { phone_number: row.account_id, meta: row.meta || {}, templates: tpl.map((t) => ({ name: t.name, status: t.status, reason: t.reason || null, id: t.telnyx_template_id || null })), last_error: row.last_error || null });
    return out;
  }
  if (!line) return { ok: true, state: 'no_number', on: false, say: 'Get your Lola phone number first — then I can turn WhatsApp on for it.' };
  const req = await requestRow(c, tenant.id);
  if (req && req.status === 'pending') {
    const out = { ok: true, state: 'requested', on: false, number: pretty(line), say: `You asked to turn on WhatsApp for ${pretty(line)} — the LolaDesk team is finishing it with Meta. I’ll take it from there as soon as it’s ready.` };
    if (admin) out.admin_step = portalStep(line);
    return out;
  }
  const out = { ok: true, state: 'off', on: false, number: pretty(line), say: `WhatsApp is off. Ask LolaDesk to turn on WhatsApp for your number ${pretty(line)} — just say “turn on WhatsApp”.` };
  if (admin) out.admin_step = portalStep(line);
  return out;
}
export function portalStep(phone) {
  return `Telnyx portal → Messaging → WhatsApp: run Meta's embedded signup ("Connect with Facebook") for this salon's business, add and verify ${phone} on that WhatsApp Business Account, keep the number on the LolaDesk messaging profile, then press "Sync WhatsApp" in Admin → Channels (or wait for the nightly sync).`;
}

/** Lola's "turn on WhatsApp": finish now if the number is already on a WABA; otherwise record the request. */
export async function requestWhatsApp(c, tenant) {
  const line = await salonLine(c, tenant);
  if (!line) return { ok: false, state: 'no_number', say: 'Get your Lola phone number first — then I can turn WhatsApp on for it.' };
  if (await whatsappRow(c, tenant.id)) return { ok: true, state: 'on', say: (await whatsappStatus(c, tenant)).say };
  let sync = null;
  if (process.env.TELNYX_API_KEY) { try { sync = await syncWhatsApp(c, { tenantId: tenant.id }); } catch (_) { sync = null; } }
  if (sync && sync.matched.some((m) => String(m.tenant_id) === String(tenant.id))) {
    return { ok: true, state: 'on', say: `Done — WhatsApp is on for ${pretty(line)}. Clients can message you there and Lola answers. I’ve also sent your reminder messages to Meta for approval.` };
  }
  try { await ensureOnMessagingProfile(c, line); } catch (_) {}
  const now = new Date().toISOString();
  const prev = await requestRow(c, tenant.id);
  await saveChannelRow(c, { tenant_id: tenant.id, channel: 'whatsapp_request', account_id: String(tenant.id), username: tenant.name || null, access_token: null, expires_at: null, status: 'pending', updated_at: now, last_error: null, meta: { phone_number: line, requested_at: (prev && prev.status === 'pending' && prev.meta && prev.meta.requested_at) || now } });
  return { ok: true, state: 'requested', say: `I’ve asked the LolaDesk team to turn on WhatsApp for ${pretty(line)}. It needs a quick approval from Meta — I’ll switch it on the moment it’s ready.` };
}

export async function disconnectWhatsApp(c, tenantId) {
  try { await c.from('tenant_channels').update({ status: 'disconnected', updated_at: new Date().toISOString() }).eq('tenant_id', tenantId).eq('channel', 'whatsapp'); } catch (_) {}
  try { await c.from('tenants').update({ whatsapp_enabled: false }).eq('id', tenantId); } catch (_) {}
  return { ok: true };
}

// ── Sending rules ──────────────────────────────────────────────
/** Did this client message the salon on WhatsApp in the last 24 hours? */
export async function whatsappWindowOpen(c, tenantId, clientId, now = Date.now()) {
  if (!clientId) return false;
  try {
    const { data: convs } = await c.from('conversations').select('id').eq('tenant_id', tenantId).eq('client_id', clientId).eq('channel', 'whatsapp').limit(50);
    const ids = (convs || []).map((x) => x.id);
    if (!ids.length) return false;
    const since = new Date(now - WINDOW_MS).toISOString();
    const { data: msgs } = await c.from('messages').select('created_at').in('conversation_id', ids).eq('role', 'user').gte('created_at', since).limit(1);
    return !!(msgs && msgs.length);
  } catch (_) { return false; }
}
export async function approvedTemplate(c, tenantId, name) {
  const row = await whatsappRow(c, tenantId);
  const waba = row && row.meta && row.meta.waba_id;
  if (!waba) return null;
  const t = (await templatesFor(c, waba)).find((x) => x.name === name && x.status === 'APPROVED');
  return t ? { name: t.name, language: t.language || LANGUAGE, template_id: t.telnyx_template_id || null } : null;
}
export async function tenantWhatsAppReady(c, tenantId) { return !!(await whatsappRow(c, tenantId)); }

/**
 * How to reach a WhatsApp-opted-in client right now:
 *   inside the 24h window → { type:'WHATSAPP' } (free text)
 *   outside → { type:'WHATSAPP', template:{ name, language, template_id, params } } when approved
 *   otherwise null → send by SMS.
 */
export async function planWhatsApp(c, { tenantId, clientId, templateName, params = [], now = Date.now() }) {
  if (await whatsappWindowOpen(c, tenantId, clientId, now)) return { type: 'WHATSAPP' };
  const t = templateName ? await approvedTemplate(c, tenantId, templateName) : null;
  if (!t) return null;
  return { type: 'WHATSAPP', template: { ...t, params: params.map((p) => String(p == null ? '' : p).slice(0, 200) || '-') } };
}
