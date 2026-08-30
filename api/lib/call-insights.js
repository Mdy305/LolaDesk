/**
 * api/lib/call-insights.js — Telnyx post-call insights → Calls page
 * ═══════════════════════════════════════════════════════════════════
 * Telnyx AI Assistants generate post-conversation insights (summary, outcome,
 * transcript) for every LolaBrain call and deliver them as
 * `call.conversation_insights.generated` events to the insight group's webhook.
 *
 * The event payload carries only call ids (call_control_id / call_session_id /
 * call_leg_id) — no tenant. Tenant is resolved from the `call_sessions` map that
 * /api/agent-variables records at conversation start (it knows the dialed
 * number), falling back to an existing `calls` row that already carries the id.
 *
 * Exactly-once: a unique index on calls.insight_id means a redelivered event
 * (same event id) is skipped instead of double-applied.
 */

// ── parse ───────────────────────────────────────────────────────────────────
export function parseInsightsEvent(body) {
  const data = body?.data || {};
  const payload = data.payload || {};
  return {
    eventType: data.event_type || body?.event_type || '',
    eventId: data.id || null,
    occurredAt: data.occurred_at || payload.occurred_at || null,
    callControlId: payload.call_control_id || null,
    callSessionId: payload.call_session_id || null,
    callLegId: payload.call_leg_id || null,
    results: Array.isArray(payload.results)
      ? payload.results.map(r => ({ insightId: r?.insight_id || null, result: r?.result ?? null }))
      : []
  };
}

// ── classify ─────────────────────────────────────────────────────────────────
// Each insight result is a string or object. Shape-dispatch, so template order
// and ids never matter: the summary template returns { summary, outcome,
// booked, duration_seconds } and the transcript template returns
// { transcript: [{ role, content }] }.
export function classifyResults(results) {
  const out = { summary: null, outcome: null, booked: null, durationSeconds: null, transcript: null };
  for (const r of (results || [])) {
    let val = r?.result;
    if (typeof val === 'string') {
      const t = val.trim();
      if (t.startsWith('{') || t.startsWith('[')) {
        try { val = JSON.parse(t); } catch { /* keep the raw string */ }
      }
    }
    if (!val) continue;
    if (typeof val === 'object') {
      if (Array.isArray(val.transcript) && val.transcript.length) out.transcript = val.transcript;
      if (typeof val.summary === 'string') out.summary = val.summary;
      if (typeof val.outcome === 'string') out.outcome = val.outcome;
      if (typeof val.booked === 'boolean') out.booked = val.booked;
      if (Number.isFinite(Number(val.duration_seconds))) out.durationSeconds = Number(val.duration_seconds);
    } else if (typeof val === 'string') {
      if (!out.summary) out.summary = val;
    }
  }
  return out;
}

// ── persist ─────────────────────────────────────────────────────────────────
export async function persistCallInsights(client, parsed, classified) {
  if (!client) return { mode: 'ignored', reason: 'no database' };
  const { callControlId, callSessionId, callLegId, eventId, occurredAt } = parsed;
  if (!callControlId && !callSessionId) return { mode: 'ignored', reason: 'no call identifiers' };

  // Exactly-once: same event id delivered again (Telnyx retry) → already applied.
  if (eventId) {
    const dup = await client.from('calls').select('id').eq('insight_id', eventId).maybeSingle().catch(() => ({ data: null }));
    if (dup?.data?.id) return { mode: 'duplicate', callId: dup.data.id };
  }

  // Resolve tenant: session map first (conversation start), then an existing
  // calls row that already carries the id.
  let tenantId = null, fromNumber = null, toNumber = null;
  if (callControlId) {
    const sess = await client.from('call_sessions')
      .select('tenant_id,from_number,to_number')
      .eq('call_control_id', callControlId)
      .maybeSingle().catch(() => ({ data: null }));
    if (sess?.data?.tenant_id) {
      tenantId = sess.data.tenant_id;
      fromNumber = sess.data.from_number || null;
      toNumber = sess.data.to_number || null;
    }
  }

  let existing = null;
  if (!tenantId) {
    try {
      const q = client.from('calls').select('id,tenant_id,from_number,to_number');
      if (callControlId && callSessionId) q.or(`telnyx_call_control_id.eq.${callControlId},call_session_id.eq.${callSessionId}`);
      else if (callControlId) q.eq('telnyx_call_control_id', callControlId);
      else q.eq('call_session_id', callSessionId);
      const row = await q.limit(1).maybeSingle();
      if (row?.data?.id) {
        existing = row.data;
        tenantId = row.data.tenant_id;
        if (!fromNumber) fromNumber = row.data.from_number || null;
        if (!toNumber) toNumber = row.data.to_number || null;
      }
    } catch { /* fall through to ignored */ }
  }
  if (!tenantId) return { mode: 'ignored', reason: 'no tenant resolvable' };

  const patch = {};
  if (classified.summary != null) patch.summary = classified.summary;
  if (classified.outcome != null) patch.outcome = classified.outcome;
  if (classified.transcript != null) patch.transcript = classified.transcript;
  if (classified.durationSeconds != null) patch.duration_seconds = classified.durationSeconds;
  if (callSessionId) patch.call_session_id = callSessionId;
  if (callLegId) patch.call_leg_id = callLegId;
  if (eventId) patch.insight_id = eventId;
  patch.insight_at = occurredAt ? new Date(occurredAt).toISOString() : new Date().toISOString();

  let callId = null;
  try {
    if (existing?.id) {
      const { error } = await client.from('calls').update(patch).eq('id', existing.id);
      if (error) return { mode: 'error', error: String(error.message || error) };
      callId = existing.id;
    } else {
      const { data, error } = await client.from('calls').insert({
        tenant_id: tenantId,
        from_number: fromNumber,
        to_number: toNumber,
        direction: 'inbound',
        status: 'completed',
        ...patch
      }).select().maybeSingle();
      if (error) return { mode: 'error', error: String(error.message || error) };
      callId = data?.id || null;
    }
  } catch (e) {
    return { mode: 'error', error: String(e && e.message || e) };
  }

  // ── LEARN: Lola remembers every call, per caller ──
  // The insight (summary/outcome) is written to client_memories keyed by the
  // caller's number, so the NEXT call's caller_brief (agent-variables) can
  // say "last call was ..." — she literally gets better every day. Tenant-
  // scoped, never touches another salon's memory. Best-effort: a memory
  // write failure must never fail the insights webhook itself.
  if (callId && fromNumber && (classified.summary != null || classified.outcome != null)) {
    try {
      const digits = String(fromNumber).replace(/\D/g, '');
      const phoneE = digits ? '+' + digits : fromNumber;
      const memory = {
        tenant_id: tenantId,
        client_phone: phoneE,
        key: 'last_call',
        value: {
          outcome: classified.outcome || null,
          summary: classified.summary || null,
          booked: classified.booked ?? null,
          duration_seconds: classified.durationSeconds || null,
          at: new Date().toISOString()
        }
      };
      await client.from('client_memories').upsert(memory, { onConflict: 'tenant_id,client_phone,key' })
        .select().maybeSingle();
    } catch (e) {
      /* memory write is best-effort — never fail the webhook */
    }
  }

  return { mode: existing?.id ? 'updated' : 'created', callId };
}
