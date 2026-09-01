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
import { db, logMessage } from './lib/db.js';
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
    const r = await fetch(`${TELNYX}/ai/assistants/${encodeURIComponent(assistant)}/conversations?page[size]=10`, {
      headers: { Authorization: `Bearer ${key}` }
    });
    if (!r.ok) return { configured: true, conversations: [] };
    const j = await r.json().catch(() => ({}));
    const conversations = (j?.data || []).map((c) => ({
      id: c.id || null,
      status: ended(c) ? 'ended' : (c.status || 'in_progress'),
      startedAt: c.started_at || c.created_at || null,
      lastMessageAt: c.last_message_at || c.updated_at || null
    })).filter((c) => c.id);
    return { configured: true, conversations };
  } catch {
    return { configured: true, conversations: [] };
  }
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
    const text = String(body.text || '').trim();
    if (!text || text.length > 400) return res.status(400).json({ error: 'text (1–400 chars) is required' });
    if (!telnyxKey() || !assistantId()) return res.status(503).json({ error: 'telnyx_not_configured', ok: false });

    // Resolve the live conversation: explicit id wins, else the newest
    // non-ended conversation of the tenant's assistant.
    let conversationId = String(body.conversation_id || '').trim();
    if (!conversationId) {
      const { conversations } = await listConversations(assistantId());
      const live = conversations.filter((x) => x.status !== 'ended');
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
    const { configured, conversations } = await listConversations(assistant);
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
