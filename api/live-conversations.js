/**
 * /api/live-conversations — the "Lola Live" plug-in for the operator
 * dashboard: live call state + live steering of an active Telnyx AI
 * Assistant conversation, without exposing the Telnyx key to the browser.
 * ═══════════════════════════════════════════════════════════════════
 * GET  /api/live-conversations
 *   → { ok, telnyx_ready, assistant_id, active_calls:[...],
 *       conversations:[{id,status,startedAt,lastMessageAt}],
 *       whisper_target: {conversationId} | null }
 *
 * POST /api/live-conversations   { conversation_id?, text }
 *   → injects a system message ("whisper") into the ACTIVE Telnyx AI
 *     Assistant conversation so the owner can steer Lola mid-call.
 *     409 no_active_conversation · 503 telnyx_not_configured
 *
 * Auth: same owner/team session as /api/data (Bearer token → tenant).
 * The Telnyx key and assistant id never leave the server. Every Telnyx
 * call degrades gracefully: if the key or assistant isn't configured we
 * still report the live call state from the DB with telnyx_ready:false.
 */
import { db, logMessage, e164 } from './lib/db.js';
import { getUserFromToken, bearer } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';

const TELNYX = 'https://api.telnyx.com/v2';
const ACTIVE_STATUS = ['ringing', 'in_progress', 'processing', 'dialing', 'connected'];
// A calls row can only stay live for so long. Past this, no webhook can have
// legitimately missed it twice — close it best-effort so the panel returns to
// Standing by instead of streaming a ghost call forever.
const LIVE_MAX_MS = 2 * 60 * 60 * 1000; // 2 hours

function telnyxKey() { return process.env.TELNYX_API_KEY || ''; }
function assistantId() { return process.env.TELNYX_ASSISTANT_ID || ''; }

function ended(conv) {
  const status = String(conv?.status || '');
  return conv?.is_ended === true || conv?.ended_at != null ||
    /end|closed|complete|done/i.test(status);
}

async function resolveTenant(req) {
  try {
    const u = await getUserFromToken(bearer(req));
    if (!u) return null;
    return (await resolveTenantForUser(u)) || null;
  } catch { return null; }
}

async function listConversations(assistant) {
  const key = telnyxKey();
  if (!key || !assistant) return { configured: false, conversations: [] };
  try {
    const r = await fetch(`${TELNYX}/ai/assistants/${encodeURIComponent(assistant)}/conversations?page[size]=50`, {
      headers: { Authorization: `Bearer ${key}` }
    });
    if (!r.ok) return { configured: true, conversations: [] };
    const j = await r.json().catch(() => ({}));
    const conversations = (j?.data || []).map((c) => ({
      id: c.id || null,
      status: ended(c) ? 'ended' : (c.status || 'in_progress'),
      startedAt: c.started_at || c.created_at || null,
      lastMessageAt: c.last_message_at || c.updated_at || null,
      _meta: (c.metadata && typeof c.metadata === 'object') ? c.metadata : {}
    })).filter((c) => c.id);
    return { configured: true, conversations };
  } catch {
    return { configured: true, conversations: [] };
  }
}

/* ── TENANT SCOPE ────────────────────────────────────────────────────
   ONE Lola assistant serves every salon, so the assistant's conversation
   list holds EVERY salon's calls. Before, any signed-in owner saw them all
   and could whisper into (steer) another salon's live call. A conversation
   belongs to this salon only when its Telnyx metadata names one of this
   salon's numbers (telnyx_agent_target …) or one of its own call ids
   (call_control_id / call_session_id from this tenant's calls rows).
   No proof → not shown, not steerable (fail closed). */
async function tenantScope(c, tenant) {
  const numbers = new Set([e164(tenant.phone_number || '')].filter(Boolean));
  const ids = new Set();
  try {
    const { data } = await c.from('tenant_numbers').select('phone_number').eq('tenant_id', tenant.id).limit(50);
    for (const r of (data || [])) { const n = e164(r.phone_number || ''); if (n) numbers.add(n); }
  } catch { /* table may not exist yet */ }
  try {
    const { data } = await c.from('calls').select('telnyx_call_control_id,call_session_id').eq('tenant_id', tenant.id)
      .order('created_at', { ascending: false }).limit(200);
    for (const r of (data || [])) { if (r.telnyx_call_control_id) ids.add(String(r.telnyx_call_control_id)); if (r.call_session_id) ids.add(String(r.call_session_id)); }
  } catch { /* best-effort */ }
  try {
    const { data } = await c.from('call_sessions').select('call_control_id').eq('tenant_id', tenant.id).order('created_at', { ascending: false }).limit(200);
    for (const r of (data || [])) if (r.call_control_id) ids.add(String(r.call_control_id));
  } catch { /* best-effort */ }
  return { numbers, ids };
}
function ownsConversation(conv, scope) {
  const vals = Object.values(conv?._meta || {}).filter((v) => typeof v === 'string' || typeof v === 'number').map(String);
  return vals.some((v) => scope.ids.has(v) || (v.replace(/\D/g, '').length >= 8 && scope.numbers.has(e164(v))));
}
const publicConv = ({ _meta, ...rest }) => rest;

/* This salon's conversations, proven by OUR ids: Telnyx's conversation list filters on any metadata
   field (PostgREST style — see Telnyx "List conversations"), so ask directly for the ones whose
   metadata names this salon's line or one of its own recent call ids. Merged with the assistant
   list; every row still passes ownsConversation, so isolation holds whatever Telnyx returns. */
async function scopedConversations(scope) {
  const key = telnyxKey();
  if (!key) return [];
  const asks = [];
  for (const n of [...scope.numbers].slice(0, 3)) asks.push(['telnyx_agent_target', n]);
  for (const id of [...scope.ids].slice(0, 4)) asks.push(['call_control_id', id]);
  const out = [];
  await Promise.all(asks.map(async ([field, value]) => {
    try {
      const r = await fetch(`${TELNYX}/ai/conversations?metadata->>${field}=eq.${encodeURIComponent(value)}&order=last_message_at.desc&limit=10`, { headers: { Authorization: `Bearer ${key}` } });
      if (!r.ok) return;
      const j = await r.json().catch(() => ({}));
      for (const c of (j?.data || [])) if (c && c.id) out.push({ id: c.id, status: ended(c) ? 'ended' : (c.status || 'in_progress'), startedAt: c.started_at || c.created_at || null, lastMessageAt: c.last_message_at || c.updated_at || null, _meta: (c.metadata && typeof c.metadata === 'object') ? c.metadata : {} });
    } catch { /* best-effort */ }
  }));
  return out;
}
async function myConversations(assistant, scope) {
  const [{ configured, conversations }, extra] = await Promise.all([listConversations(assistant), scopedConversations(scope)]);
  const byId = new Map();
  for (const x of [...conversations, ...extra]) if (ownsConversation(x, scope) && !byId.has(x.id)) byId.set(x.id, x);
  return { configured, conversations: [...byId.values()] };
}

async function whisper(conversationId, text) {
  const key = telnyxKey();
  const assistant = assistantId();
  const r = await fetch(
    `${TELNYX}/ai/assistants/${encodeURIComponent(assistant)}/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ role: 'system', content: text })
    }
  );
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json()).error?.message || ''; } catch { /* ignore */ }
    const err = new Error(`telnyx_rejected:${r.status}`);
    err.data = { status: r.status, detail };
    throw err;
  }
  return r.json();
}

/**
 * Take over an active call: transfer the live Telnyx leg to the owner's
 * phone via Call Control, so the owner can talk to the client directly
 * while Lola steps back. The AI leg is released by Telnyx when the
 * transfer completes; the existing end webhooks then close the calls row.
 */
async function takeoverCall({ c, tenant, body }) {
  const key = telnyxKey();
  if (!key) return { error: 'telnyx_not_configured', status: 503 };

  const callId = String(body.call_id || '').trim();
  let row = null;
  try {
    if (callId) {
      const { data } = await c.from('calls').select('*').eq('id', callId).eq('tenant_id', tenant.id).limit(1);
      row = data?.[0] || null;
    } else {
      const { data } = await c.from('calls')
        .select('*').eq('tenant_id', tenant.id)
        .in('status', ACTIVE_STATUS)
        .order('created_at', { ascending: false }).limit(1);
      row = data?.[0] || null;
    }
  } catch (e) { return { error: 'call_lookup_failed', status: 500, detail: String(e?.message || e) }; }
  if (!row || !ACTIVE_STATUS.includes(String(row.status || ''))) {
    return { error: 'no_active_call', status: 409 };
  }
  const controlId = row.telnyx_call_control_id;
  if (!controlId) {
    return { error: 'no_call_control', status: 409, detail: 'This call has no Telnyx call-control id yet — try again in a second.' };
  }

  const rawTarget = String(body.to_number || '').trim();
  const to = e164(rawTarget || tenant.operator_phone || '');
  if (!to) {
    return { error: 'no_owner_phone', status: 409, detail: 'Set your operator phone in Settings (Call handling) to take over calls.' };
  }

  const r = await fetch(`${TELNYX}/calls/${encodeURIComponent(controlId)}/actions/transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ to, from: tenant.phone_number || row.to_number || undefined })
  });
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json()).error?.message || ''; } catch { /* ignore */ }
    const err = new Error(`telnyx_rejected:${r.status}`);
    err.data = { status: r.status, detail };
    throw err;
  }
  try {
    await logMessage({ tenantId: tenant.id, role: 'owner', agent: 'lola', content: `Owner took over the call with ${row.from_number || 'the caller'} — transferred to ${to}.` });
  } catch { /* non-fatal */ }
  return { ok: true, transferred: { callId: row.id, to, callControlId: controlId } };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const c = db();
  if (!c) return res.status(503).json({ ok: false, error: 'database not configured' });
  const tenant = await resolveTenant(req);
  if (!tenant?.id) {
    const hasBearer = !!bearer(req);
    return res.status(hasBearer ? 403 : 401).json({ error: hasBearer ? 'no tenant mapped to this account' : 'Not authenticated' });
  }
  const tid = tenant.id;

  if (req.method === 'POST') {
    const body = (typeof req.body === 'string') ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
    if (String(body.action || '').trim() === 'takeover') {
      try {
        const out = await takeoverCall({ c, tenant, body });
        if (out.error) return res.status(out.status || 400).json({ ok: false, error: out.error, detail: out.detail });
        return res.status(200).json(out);
      } catch (e) {
        return res.status(e?.data?.status && e.data.status >= 400 && e.data.status < 500 ? 502 : 503)
          .json({ ok: false, error: 'takeover_failed', detail: e?.data?.detail || String(e?.message || e) });
      }
    }
    const text = String(body.text || '').trim();
    if (!text || text.length > 400) return res.status(400).json({ error: 'text (1–400 chars) is required' });
    if (!telnyxKey() || !assistantId()) return res.status(503).json({ error: 'telnyx_not_configured', ok: false });

    // Resolve the live conversation: explicit id wins, else the newest
    // non-ended conversation of the tenant's assistant.
    // Only THIS salon's conversations are steerable (see tenantScope).
    let conversationId = String(body.conversation_id || '').trim();
    const scope = await tenantScope(c, tenant);
    const { conversations: mine } = await myConversations(assistantId(), scope);
    if (conversationId) {
      if (!mine.some((x) => x.id === conversationId)) return res.status(404).json({ error: 'conversation_not_found', ok: false });
    } else {
      const live = mine.filter((x) => x.status !== 'ended');
      if (!live.length) return res.status(409).json({ error: 'no_active_conversation', ok: false });
      live.sort((a, b) => String(b.lastMessageAt || b.startedAt || '').localeCompare(String(a.lastMessageAt || a.startedAt || '')));
      conversationId = live[0].id;
    }

    try {
      await whisper(conversationId, text);
    } catch (e) {
      return res.status(e?.data?.status && e.data.status >= 400 && e.data.status < 500 ? 502 : 503)
        .json({ ok: false, error: 'whisper_failed', detail: e?.data?.detail || String(e?.message || e) });
    }
    // Best-effort audit trail: the owner's steer lands in the tenant's
    // conversation log exactly like a Lola turn would.
    try { await logMessage({ conversationId, tenantId: tid, role: 'owner', agent: 'lola', content: text }); } catch { /* non-fatal */ }
    return res.status(200).json({ ok: true, injected: { conversationId, role: 'system' } });
  }

  // GET — live call state + current conversations
  try {
    const { data = [] } = await c
      .from('calls')
      .select('id,from_number,to_number,direction,status,started_at,created_at,duration_seconds,telnyx_call_control_id,call_session_id,transcript,summary,insight_at')
      .eq('tenant_id', tid)
      .in('status', ACTIVE_STATUS)
      .order('created_at', { ascending: false })
      .limit(25);

    // Self-heal: with the call-start/ended webhooks this row normally flips
    // to completed itself — but if a webhook delivery drops, close the two
    // provably-dead shapes here (best-effort) instead of streaming forever:
    //  • insights already landed (insight_at) but the status stuck live, or
    //  • the row has outlived LIVE_MAX_MS with no end signal at all.
    const nowMs = Date.now();
    const closedIds = new Set();
    for (const x of (data || [])) {
      const live = ACTIVE_STATUS.includes(String(x.status || ''));
      if (!live) continue;
      const insightLanded = !!x.insight_at;
      const t = new Date(x.created_at || x.started_at || 0).getTime();
      const stale = Number.isFinite(t) && t > 0 && (nowMs - t) > LIVE_MAX_MS;
      if (insightLanded || stale) {
        closedIds.add(x.id);
        try { await c.from('calls').update({ status: 'completed' }).eq('id', x.id); } catch { /* non-fatal */ }
      }
    }

    const activeCallsRaw = (data || []).map((x) => {
      const startedAt = x.started_at || x.created_at || null;
      return {
        id: x.id,
        from: x.from_number || '',
        to: x.to_number || '',
        direction: x.direction || 'inbound',
        status: x.status || 'in_progress',
        startedAt,
        durationSec: Number(x.duration_seconds || 0),
        callControlId: x.telnyx_call_control_id || null,
        callSessionId: x.call_session_id || null,
        transcript: (() => {
          const t = x.transcript;
          if (typeof t === 'string') { try { return JSON.parse(t); } catch { return null; } }
          return t || null;
        })(),
        summary: x.summary || null
      };
    });

    // The select ran BEFORE the self-heal sweep — re-filter so a call that
    // was just closed this poll never renders as active.
    const activeCalls = activeCallsRaw.filter((x) => ACTIVE_STATUS.includes(x.status) && !closedIds.has(x.id));

    const assistant = assistantId();
    const scope = await tenantScope(c, tenant);
    const { configured, conversations: allConversations } = await myConversations(assistant, scope);
    // Never another salon's calls: only conversations proven to be this tenant's.
    const conversations = allConversations.filter((x) => ownsConversation(x, scope)).map(publicConv);
    const live = conversations.filter((x) => x.status !== 'ended');
    const whisperTarget = live.length ? { conversationId: live[0].id } : null;

    return res.status(200).json({
      ok: true,
      endpoint: 'live-conversations',
      tenant: tenant.name,
      telnyx_ready: configured && !!assistant,
      assistant_id: assistant || null,
      active_calls: activeCalls,
      conversations,
      whisper_target: whisperTarget,
      poll_ms: 8000
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
