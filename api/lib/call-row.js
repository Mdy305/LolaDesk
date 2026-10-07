/**
 * api/lib/call-row.js — ONE calls row per phone call.
 * ════════════════════════════════════════════════════════════════════
 * Several webhooks learn about the same call: the dynamic-variables fetch at
 * the start (agent-variables), Call Control events (telnyx-webhook) and the
 * post-call insights (call-insights). Each one used to insert its own row.
 * They all go through upsertCallRow now: look the call up by its
 * telnyx_call_control_id, then by call_session_id, update it when found,
 * insert it otherwise.
 *
 * Canonical columns only: status / recording_url (transcript text) /
 * duration_seconds / telnyx_call_control_id. `outcome`, `transcript`,
 * `telnyx_call_id` and `duration_sec` are GENERATED aliases in schema.sql —
 * writing them makes Postgres refuse the whole statement.
 */
const GENERATED = ['outcome', 'transcript', 'telnyx_call_id', 'duration_sec'];
export const stripGenerated = (row) => { const o = { ...(row || {}) }; for (const k of GENERATED) delete o[k]; return o; };

const settle = (p) => Promise.resolve(p).then((r) => r, () => ({ data: null, error: { message: 'query failed' } }));

/** The existing row for this call (optionally within one salon), or null. */
export async function findCallRow(c, { tenantId = null, callControlId = null, callSessionId = null, select = '*' } = {}) {
  if (!c) return null;
  const tries = [];
  if (callControlId) tries.push(['telnyx_call_control_id', callControlId]);
  if (callSessionId) tries.push(['call_session_id', callSessionId]);
  for (const [col, val] of tries) {
    let q = c.from('calls').select(select).eq(col, String(val));
    if (tenantId) q = q.eq('tenant_id', tenantId);
    const r = await settle(q.order('created_at', { ascending: true }).limit(1));
    const row = Array.isArray(r?.data) ? r.data[0] : r?.data;
    if (row?.id) return row;
  }
  return null;
}

/**
 * Update-or-insert the call's row. `patch` is applied to an existing row; `insert` (merged with patch)
 * creates one. → { id, mode:'updated'|'created'|'error', row?, error? }
 */
export async function upsertCallRow(c, { tenantId, callControlId = null, callSessionId = null, patch = {}, insert = {} } = {}) {
  if (!c || !tenantId || (!callControlId && !callSessionId)) return { id: null, mode: 'error', error: 'missing ids' };
  const existing = await findCallRow(c, { tenantId, callControlId, callSessionId });
  if (existing?.id) {
    const p = stripGenerated(patch);
    if (callControlId && !existing.telnyx_call_control_id) p.telnyx_call_control_id = callControlId;
    if (callSessionId && !existing.call_session_id) p.call_session_id = callSessionId;
    if (Object.keys(p).length) {
      const { error } = await settle(c.from('calls').update(p).eq('id', existing.id));
      if (error) return { id: existing.id, mode: 'error', error: String(error.message || error), row: existing };
    }
    return { id: existing.id, mode: 'updated', row: { ...existing, ...p } };
  }
  const row = stripGenerated({ tenant_id: tenantId, direction: 'inbound', ...insert, ...patch,
    ...(callControlId ? { telnyx_call_control_id: callControlId } : {}), ...(callSessionId ? { call_session_id: callSessionId } : {}) });
  const { data, error } = await settle(c.from('calls').insert(row).select().maybeSingle());
  if (error) return { id: null, mode: 'error', error: String(error.message || error) };
  return { id: data?.id || null, mode: 'created', row: data || row };
}
