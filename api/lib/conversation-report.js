/**
 * api/lib/conversation-report.js — every conversation Lola has (a phone call, the salon's website)
 * lands on the salon's Calls screen with its transcript and a short summary, and the salon gets it
 * by email.
 *
 *   saveConversation(c, {...})   write (or complete) the calls row — transcript as "Caller:/Lola:" text
 *                                (what the Calls screen reads) plus the structured copy when the column
 *                                accepts it; never fails on a schema difference.
 *   emailConversation(c, tenant, call)  the transcript email to the salon (owner email + any extra
 *                                address in Settings, knowledge.transcript_email).
 *   collectTelnyxConversations({...})  the Telnyx assistant's finished conversations (website widget and
 *                                assistant phone calls) → saved + emailed, each exactly once.
 */
import { db, e164 } from './db.js';

const TELNYX = 'https://api.telnyx.com/v2';
const APP = () => String(process.env.APP_URL || 'https://www.loladesk.com').replace(/\/+$/, '');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

/** [{role, content}] → "Caller: …\nLola: …" (the Calls screen's format). */
export function transcriptLines(turns) {
  return (turns || []).filter((t) => t && String(t.content || t.text || '').trim() && (t.role === 'user' || t.role === 'assistant'))
    .map((t) => `${t.role === 'assistant' ? 'Lola' : 'Caller'}: ${String(t.content || t.text).replace(/\s+/g, ' ').trim()}`).join('\n');
}
/** "Caller: …\nLola: …" → [{role, content}] */
export function parseLines(text) {
  const out = [];
  for (const line of String(text || '').split(/\n+/).map((l) => l.trim()).filter(Boolean)) {
    const m = /^(caller|client|user|lola|assistant)\s*:\s*(.*)$/i.exec(line);
    if (m) out.push({ role: /^(lola|assistant)$/i.test(m[1]) ? 'assistant' : 'user', content: m[2] });
    else if (out.length) out[out.length - 1].content += ' ' + line;
  }
  return out;
}

/** A two-sentence summary by Telnyx AI (never blocks: falls back to the first thing the caller said). */
export async function summarize(turns, { salon = '', booked = false, deadlineMs = 8000 } = {}) {
  const firstAsk = (turns.find((t) => t.role === 'user') || {}).content || '';
  const fallback = booked ? `Booked by Lola. ${firstAsk}`.trim() : (firstAsk ? `Asked: ${firstAsk}` : 'Short conversation with Lola.');
  if (!process.env.TELNYX_API_KEY || turns.length < 2) return fallback.slice(0, 300);
  try {
    const { chat } = await import('./llm.js');
    const r = await chat({ system: `Summarize this ${salon ? salon + ' ' : ''}front-desk conversation for the salon owner in at most 2 short sentences: who it was (name if given), what they wanted, and the outcome (booked — service, day, time — or what is still needed). Plain text.`,
      messages: [{ role: 'user', content: transcriptLines(turns).slice(0, 6000) }], maxTokens: 160, temperature: 0.2, fast: true, deadlineMs });
    const t = String(r?.text || '').trim();
    return (r?.ok && t ? t : fallback).slice(0, 400);
  } catch (_) { return fallback.slice(0, 300); }
}

/** Write the call row; retries without columns a deployment can't take (generated/missing). */
async function writeCall(c, id, row) {
  const attempt = async (r) => id
    ? c.from('calls').update(r).eq('id', id).select().maybeSingle()
    : c.from('calls').insert(r).select().maybeSingle();
  let { data, error } = await attempt(row);
  if (error) {
    const lean = { ...row }; delete lean.transcript; delete lean.outcome; delete lean.channel; delete lean.insight_id; delete lean.insight_at;
    ({ data, error } = await attempt(lean));
  }
  return { data: data || (id ? { id } : null), error };
}

/**
 * Save one conversation on the salon's Calls screen.
 * { tenantId, turns:[{role,content}], summary, booked, callControlId, fromNumber, toNumber, channel, key, clientId }
 * Returns { callId, created } — or { skipped:'duplicate' } when `key` was already saved.
 */
export async function saveConversation(c, { tenantId, turns = [], summary = '', booked = false, callControlId = null, fromNumber = null, toNumber = null, channel = 'phone', key = null, clientId = null, durationSeconds = null }) {
  if (!c || !tenantId) return { error: 'no tenant' };
  if (key) {
    const { data: dup } = await c.from('calls').select('id').eq('insight_id', key).maybeSingle().then((x) => x, () => ({ data: null }));
    if (dup?.id) return { skipped: 'duplicate', callId: dup.id };
  }
  let existing = null;
  if (callControlId) {
    const { data } = await c.from('calls').select('id,status').eq('tenant_id', tenantId).eq('telnyx_call_control_id', callControlId).maybeSingle().then((x) => x, () => ({ data: null }));
    existing = data || null;
  }
  const text = transcriptLines(turns);
  const row = {
    recording_url: text || null, transcript: turns.length ? turns : null, summary: summary || null,
    status: booked ? 'booked' : 'completed', ...(booked ? { outcome: 'booked' } : {}),
    ...(key ? { insight_id: key, insight_at: new Date().toISOString() } : {}),
    ...(durationSeconds ? { duration_seconds: durationSeconds } : {}),
  };
  if (!existing) Object.assign(row, { tenant_id: tenantId, direction: 'inbound', from_number: fromNumber ? (e164(fromNumber) || fromNumber) : (channel === 'web' ? 'Website visitor' : null), to_number: toNumber ? (e164(toNumber) || toNumber) : null, telnyx_call_control_id: callControlId || null, ...(clientId ? { client_id: clientId } : {}) });
  const { data, error } = await writeCall(c, existing?.id || null, row);
  if (error) return { error: String(error.message || error) };
  return { callId: data?.id || existing?.id || null, created: !existing };
}

/** Where a salon's transcripts go: the owner's email, plus an optional extra address from Settings. */
export function transcriptRecipients(tenant) {
  const k = (tenant?.knowledge && typeof tenant.knowledge === 'object') ? tenant.knowledge : {};
  const list = [tenant?.owner_email, k.transcript_email, tenant?.email].map((x) => String(x || '').trim().toLowerCase()).filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(x));
  if (k.transcript_emails === false) return [];
  return [...new Set(list)].slice(0, 3);
}

export function renderTranscriptEmail(tenant, { channel = 'phone', who = '', summary = '', booked = false, turns = [], callId = null }) {
  const where = channel === 'web' ? 'website chat' : 'phone call';
  const subject = `Lola · ${booked ? 'New booking' : 'New ' + where}${who ? ' — ' + who : ''}`;
  const rows = turns.map((t) => `<tr><td style="padding:6px 10px;vertical-align:top;font-weight:600;color:${t.role === 'assistant' ? '#111' : '#555'};white-space:nowrap">${t.role === 'assistant' ? 'Lola' : 'Client'}</td><td style="padding:6px 10px">${esc(t.content)}</td></tr>`).join('');
  const link = `${APP()}/calls${callId ? '?id=' + encodeURIComponent(callId) : ''}`;
  const html = `<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:620px">
<p style="margin:0 0 4px;font-size:13px;color:#666">${esc(tenant?.name || 'Your salon')} · ${esc(where)}</p>
<h2 style="margin:0 0 12px;font-size:20px">${booked ? 'Lola booked an appointment' : 'Lola had a conversation'}${who ? ' with ' + esc(who) : ''}</h2>
${summary ? `<p style="margin:0 0 16px;padding:12px 14px;background:#f5f5f2;border-radius:10px">${esc(summary)}</p>` : ''}
<table style="border-collapse:collapse;width:100%;font-size:14px">${rows || '<tr><td>No words were exchanged.</td></tr>'}</table>
<p style="margin:18px 0 0"><a href="${esc(link)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:999px">Open in LolaDesk</a></p>
<p style="margin:14px 0 0;font-size:12px;color:#888">Turn these emails off or add another address in LolaDesk → Settings.</p></div>`;
  const text = `${subject}\n\n${summary ? summary + '\n\n' : ''}${transcriptLines(turns)}\n\nOpen in LolaDesk: ${link}`;
  return { subject, html, text };
}

export async function emailConversation(tenant, details, { timeoutMs = 6000 } = {}) {
  const to = transcriptRecipients(tenant);
  if (!to.length) return { sent: 0, reason: 'no_recipient' };
  const { subject, html, text } = renderTranscriptEmail(tenant, details);
  const { SendEmail } = await import('./lola-integrations.js');
  let sent = 0, reason = null;
  for (const addr of to) {
    try {
      const r = await Promise.race([
        SendEmail({ to: addr, subject, html, textContent: text, from: process.env.EMAIL_FROM || process.env.SENDGRID_FROM || 'lola@loladesk.com' }),
        new Promise((resolve) => setTimeout(() => resolve({ success: false, reason: 'timeout' }), timeoutMs)),
      ]);
      if (r && (r.success === true || r.sent === true)) sent++; else reason = r?.reason || 'not_sent';
    } catch (e) { reason = String(e?.message || e).slice(0, 120); }
  }
  return { sent, reason };
}

/** One finished conversation, end to end: save on the screen, then email the salon (once). */
export async function reportConversation(c, tenant, details) {
  const saved = await saveConversation(c, { tenantId: tenant.id, ...details });
  if (saved.skipped || saved.error) return { ...saved, emailed: 0 };
  const who = details.who || (details.fromNumber && details.channel !== 'web' ? details.fromNumber : '');
  const mail = await emailConversation(tenant, { ...details, who, callId: saved.callId });
  return { ...saved, emailed: mail.sent, email_reason: mail.reason };
}

// ── The Telnyx assistant's conversations (website widget + assistant phone calls) ──
async function tget(path, timeoutMs = 9000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(TELNYX + path, { headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` }, signal: ac.signal });
    const j = await r.json().catch(() => ({}));
    return r.ok ? j : null;
  } catch (_) { return null; } finally { clearTimeout(t); }
}
const phoneOk = (v) => String(v || '').replace(/\D/g, '').length >= 8 && !/\{\{/.test(String(v));

/** Which salon a Telnyx conversation belongs to: the dialed number, the website widget's salon line, or the linked call. */
export async function tenantForConversation(c, meta = {}) {
  const { resolveInboundTenant } = await import('./tenant-resolver.js');
  const salonKey = Object.keys(meta).find((k) => /loladesk[-_]salon/i.test(k));
  const custom = meta.custom_headers && typeof meta.custom_headers === 'object' ? Object.entries(meta.custom_headers).find(([k]) => /loladesk[-_]salon/i.test(k))?.[1] : null;
  for (const line of [meta.telnyx_agent_target, salonKey ? meta[salonKey] : null, custom]) {
    if (!phoneOk(line)) continue;
    const r = await resolveInboundTenant({ to: line }).catch(() => null);
    if (r?.status === 'resolved' && r.tenant) return r.tenant;
  }
  if (meta.call_control_id) {
    const { data } = await c.from('call_sessions').select('tenant_id').eq('call_control_id', meta.call_control_id).maybeSingle().then((x) => x, () => ({ data: null }));
    if (data?.tenant_id) { const { data: t } = await c.from('tenants').select('*').eq('id', data.tenant_id).maybeSingle(); if (t) return t; }
  }
  return null;
}

/**
 * Every finished conversation of Lola's Telnyx assistant from the last few hours → the salon's Calls
 * screen + transcript email. Quiet for `quietMs` = finished. Each conversation exactly once.
 */
export async function collectTelnyxConversations({ c = db(), sinceMs = 6 * 3600e3, quietMs = 3 * 60e3, now = Date.now(), limit = 40, budgetMs = 45000 } = {}) {
  if (!c || !process.env.TELNYX_API_KEY) return { ok: false, error: 'not configured' };
  const started = Date.now();
  const { resolveAssistant } = await import('./assistant-wiring.js');
  const found = await resolveAssistant().catch(() => null);
  if (!found?.id) return { ok: false, error: 'no assistant' };
  const since = new Date(now - sinceMs).toISOString();
  const list = await tget(`/ai/conversations?metadata->assistant_id=eq.${encodeURIComponent(found.id)}&last_message_at=gte.${encodeURIComponent(since)}&order=last_message_at.desc&limit=${limit}`);
  const convs = Array.isArray(list?.data) ? list.data : [];
  const out = { ok: true, seen: convs.length, saved: 0, emailed: 0, skipped: 0, unknown_salon: 0 };
  for (const conv of convs) {
    if (Date.now() - started > budgetMs) break;
    const meta = conv.metadata && typeof conv.metadata === 'object' ? conv.metadata : {};
    const ch = String(meta.telnyx_conversation_channel || '').toLowerCase();
    if (/sms|message|whatsapp/.test(ch)) { out.skipped++; continue; }            // texts are already in the Inbox
    const last = Date.parse(conv.last_message_at || conv.created_at || 0) || 0;
    if (now - last < quietMs) { out.skipped++; continue; }                      // still talking
    const key = 'conv:' + conv.id;
    const { data: dup } = await c.from('calls').select('id').eq('insight_id', key).maybeSingle().then((x) => x, () => ({ data: null }));
    if (dup?.id) { out.skipped++; continue; }
    if (meta.call_control_id) {   // already delivered by Telnyx's insights webhook → don't report it twice
      const { data: had } = await c.from('calls').select('id,insight_id').eq('telnyx_call_control_id', meta.call_control_id).maybeSingle().then((x) => x, () => ({ data: null }));
      if (had?.insight_id) { out.skipped++; continue; }
    }
    const tenant = await tenantForConversation(c, meta);
    if (!tenant) { out.unknown_salon++; continue; }
    const msgs = [];
    for (let page = 1; page <= 3; page++) {
      const j = await tget(`/ai/conversations/${encodeURIComponent(conv.id)}/messages?page[size]=100&page[number]=${page}`);
      const rows = Array.isArray(j?.data) ? j.data : [];
      msgs.push(...rows);
      if (!j || page >= (Number(j?.meta?.total_pages) || 1)) break;
    }
    msgs.sort((a, b) => (Date.parse(a.created_at || a.sent_at || 0) || 0) - (Date.parse(b.created_at || b.sent_at || 0) || 0));
    const turns = msgs.filter((m) => (m.role === 'user' || m.role === 'assistant') && String(m.text || '').trim()).map((m) => ({ role: m.role, content: String(m.text).trim() }));
    if (!turns.length) { out.skipped++; continue; }
    const booked = msgs.some((m) => m.role === 'tool' && /"booked"\s*:\s*true/.test(String(m.text || '')));
    // Who it was: the caller's line, or what they gave the booking tool.
    let who = '', phone = phoneOk(meta.telnyx_end_user_target) ? meta.telnyx_end_user_target : null;
    for (const m of msgs) for (const tc of (m.tool_calls || [])) {
      try { const a = JSON.parse(tc?.function?.arguments || '{}'); if (a.client_name && !who) who = String(a.client_name); if (a.client_phone && !phone && phoneOk(a.client_phone)) phone = a.client_phone; } catch (_) {}
    }
    const web = /web/.test(ch) || (!phoneOk(meta.telnyx_end_user_target) && !phoneOk(meta.telnyx_agent_target));
    const summary = await summarize(turns, { salon: tenant.name, booked });
    const r = await reportConversation(c, tenant, {
      turns, summary, booked, key, channel: web ? 'web' : 'phone', who: who || (phone ? String(phone) : ''),
      callControlId: meta.call_control_id || null,
      fromNumber: phone, toNumber: phoneOk(meta.telnyx_agent_target) ? meta.telnyx_agent_target : tenant.phone_number || null,
    });
    if (r.callId && !r.skipped) out.saved++;
    out.emailed += r.emailed || 0;
  }
  return out;
}
