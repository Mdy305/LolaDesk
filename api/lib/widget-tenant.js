// Resolve a tenant from a widget request. Public endpoints have no bearer token,
// so we identify tenant via one of:
//   1) ?tenant=<slug or uuid> query param
//   2) X-Lola-Tenant header
//   3) Referer / Origin subdomain (e.g. mma-salon.loladesk.com)
import { db } from './db.js';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function subdomainFromOrigin(origin) {
  if (!origin) return null;
  try {
    const u = new URL(origin);
    const parts = u.hostname.split('.');
    // e.g. mma-salon.loladesk.com → 'mma-salon'
    if (parts.length >= 3 && parts.slice(-2).join('.') === 'loladesk.com') return parts[0];
  } catch {}
  return null;
}

export async function resolveTenantFromRequest(req) {
  const c = db();
  const q = req.query || {};
  const raw = String(q.tenant || req.headers?.['x-lola-tenant'] || '').trim();

  // Try UUID first.
  if (raw && UUID_RX.test(raw)) {
    const { data } = await c.from('tenants').select('id, name, slug, phone_e164').eq('id', raw).maybeSingle();
    if (data) return data;
  }

  // Try slug.
  if (raw) {
    const { data } = await c.from('tenants').select('id, name, slug, phone_e164').eq('slug', raw).maybeSingle();
    if (data) return data;
  }

  // Try subdomain of referer/origin.
  const sub = subdomainFromOrigin(req.headers?.origin || req.headers?.referer);
  if (sub) {
    const { data } = await c.from('tenants').select('id, name, slug, phone_e164').eq('slug', sub).maybeSingle();
    if (data) return data;
  }

  return null;
}
