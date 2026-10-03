// Shared by the /api/lola/* voice tools (not a route: "_" prefix).
// Resolves the salon from the number that was called, the same strict way
// every other inbound path does (tenant_numbers.phone_number / tenants.phone_number).
import { resolveInboundTenant } from '../lib/tenant-resolver.js';
import { toolKeyOk } from '../lib/tool-key.js';

const queryOf = (req) => {
  const q = { ...(req?.query || {}) };
  try { for (const [k, v] of new URL(req?.url || '', 'http://x').searchParams) if (q[k] == null) q[k] = v; } catch (_) {}
  return q;
};

/**
 * Who is calling a voice tool?
 *   'signed'  — LolaDesk's own Telnyx wiring: the signed k=… on the tool URL (api/lib/tool-key.js),
 *               or the legacy x-lola-tool-secret header when LOLA_TOOL_SECRET is configured.
 *   'refused' — LOLA_TOOL_SECRET is configured and the request carries neither proof (legacy strict mode).
 *   'public'  — no secret configured and no valid key: public skills only, NEVER client data.
 * The old helper returned true whenever LOLA_TOOL_SECRET was unset, so anyone could read a caller's
 * history by POSTing the salon's public number and a client's phone.
 */
export function toolAuth(req, purpose = 'tools') {
  const q = queryOf(req);
  const secret = process.env.LOLA_TOOL_SECRET;
  const header = req?.headers?.['x-lola-tool-secret'];
  if (secret && header && header === secret) return 'signed';
  if (toolKeyOk(q.k, purpose)) return 'signed';
  return secret ? 'refused' : 'public';
}
/** Back-compat boolean: false only when the request must be refused outright. */
export function verifyToolAuth(req) { return toolAuth(req) !== 'refused'; }

/**
 * The caller's own line as Telnyx saw it — only for a signed request, never a website visitor,
 * and preferring the number Telnyx put on the URL over anything the model typed in the body.
 */
export function verifiedCaller(req, body = {}) {
  if (toolAuth(req) !== 'signed') return null;
  const q = queryOf(req);
  const real = (v) => v && !/\{\{/.test(String(v)) && String(v).replace(/\D/g, '').length >= 8;
  const web = /web/i.test(String(q.ch || body.telnyx_conversation_channel || ''));
  if (web) return null;
  const from = real(q.from) ? q.from : (body.from_number || body.from || body.From);
  return real(from) ? String(from) : null;
}

export async function tenantForCalledNumber(to) {
  if (!to) return null;
  try { const r = await resolveInboundTenant({ to }); return r.status === 'resolved' ? r.tenant : null; } catch { return null; }
}
