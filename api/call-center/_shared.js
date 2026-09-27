// Shared helpers for the Call Center endpoints (not a route: Vercel ignores
// files starting with "_" in /api).
import { bearer, getUserFromToken } from '../lib/auth.js';
import { resolveTenantForUser } from '../lib/tenant-access.js';
import { db } from '../lib/db.js';

export async function ownerTenant(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return null; }
  const user = await getUserFromToken(bearer(req));
  if (!user) { res.status(401).json({ ok: false, error: 'not_authenticated' }); return null; }
  const tenant = await resolveTenantForUser(user);
  if (!tenant?.id) { res.status(404).json({ ok: false, error: 'no_tenant' }); return null; }
  const c = db();
  if (!c) { res.status(503).json({ ok: false, error: 'database_not_configured' }); return null; }
  return { user, tenant, c };
}

export function body(req) {
  if (typeof req.body === 'string') { try { return JSON.parse(req.body || '{}'); } catch { return {}; } }
  return req.body || {};
}

const isUrl = (v) => typeof v === 'string' && /^https?:\/\//i.test(v.trim());
const digits = (p) => { let d = String(p || '').replace(/\D/g, ''); if (d.length === 11 && d[0] === '1') d = d.slice(1); return d; };

// The voice pipeline's canonical contract keeps the rolling conversation
// ("Caller: … / Lola: …") in calls.recording_url, with `transcript` as a
// generated alias. A real audio link, when recording is enabled, lands in
// calls.recording_audio_url (see sql/call-center.sql).
export function transcriptText(row) {
  const cands = [row.transcript, row.recording_url, row.notes];
  for (const v of cands) {
    if (v == null) continue;
    if (Array.isArray(v)) return v.map(t => `${t.role === 'assistant' || t.speaker === 'lola' ? 'Lola' : 'Caller'}: ${t.text || t.content || ''}`).join('\n');
    if (typeof v === 'object') continue;
    if (typeof v === 'string' && v.trim() && !isUrl(v)) return v;
  }
  return '';
}
export function audioUrl(row) {
  if (isUrl(row.recording_audio_url)) return row.recording_audio_url;
  if (isUrl(row.recording_url)) return row.recording_url;
  return null;
}

export function normalizeCall(row, clientsById = {}, clientsByPhone = {}) {
  const from = row.from_number || row.from || row.caller_phone || '';
  const to = row.to_number || row.to || '';
  const direction = String(row.direction || 'inbound').toLowerCase();
  const other = direction === 'outbound' ? to : from;
  const cl = (row.client_id && clientsById[row.client_id]) || clientsByPhone[digits(other)] || null;
  const dur = parseInt(row.duration_seconds ?? row.duration_sec ?? 0, 10) || 0;
  const status = String(row.status || row.outcome || '').toLowerCase();
  const text = transcriptText(row);
  return {
    id: row.id,
    telnyx_call_id: row.telnyx_call_control_id || row.telnyx_call_id || row.call_control_id || null,
    direction,
    from, to,
    phone: other,
    client_id: cl?.id || row.client_id || null,
    client_name: cl ? (cl.name || [cl.first_name, cl.last_name].filter(Boolean).join(' ')) : '',
    status,
    outcome: row.outcome || row.status || '',
    duration_sec: dur,
    started_at: row.started_at || row.created_at || null,
    ended_at: row.ended_at || null,
    summary: typeof row.summary === 'string' ? row.summary : '',
    transcript: text,
    recording_url: audioUrl(row),
    is_voicemail: status === 'voicemail' || /voicemail/i.test(String(row.summary || '')),
    handled: !!row.handled_at || !!row.handled,
  };
}

export async function clientIndex(c, tenantId, rows) {
  const ids = [...new Set(rows.map(r => r.client_id).filter(Boolean))];
  const byId = {}, byPhone = {};
  if (ids.length) {
    const { data } = await c.from('clients').select('id, name, first_name, last_name, phone').eq('tenant_id', tenantId).in('id', ids);
    for (const cl of data || []) { byId[cl.id] = cl; byPhone[digits(cl.phone)] = cl; }
  }
  const phones = [...new Set(rows.flatMap(r => [r.from_number || r.from, r.to_number || r.to]).filter(Boolean))];
  if (phones.length) {
    const { data } = await c.from('clients').select('id, name, first_name, last_name, phone').eq('tenant_id', tenantId).in('phone', phones);
    for (const cl of data || []) byPhone[digits(cl.phone)] = cl;
  }
  return { byId, byPhone };
}
