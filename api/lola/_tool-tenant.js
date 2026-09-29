// Shared by the /api/lola/* voice tools (not a route: "_" prefix).
// Resolves the salon from the number that was called, the same strict way
// every other inbound path does (tenant_numbers.phone_number / tenants.phone_number).
import { resolveInboundTenant } from '../lib/tenant-resolver.js';

export function verifyToolAuth(req) {
  const secret = process.env.LOLA_TOOL_SECRET;
  if (!secret) return true;
  return req.headers?.['x-lola-tool-secret'] === secret;
}
export async function tenantForCalledNumber(to) {
  if (!to) return null;
  try { const r = await resolveInboundTenant({ to }); return r.status === 'resolved' ? r.tenant : null; } catch { return null; }
}
