/**
 * lib/tenant-resolver.js — Multi-tenant inbound call routing (Telnyx ↔ Tenant)
 * ════════════════════════════════════════════════════════════════════════
 * THE security boundary of the platform. Before Lola speaks a single
 * syllable — or answers a single text — the dialed number must resolve to
 * exactly ONE tenant. This module is deliberately STRICT:
 *
 *   • Never falls back to a demo tenant. An unrecognized number resolves to
 *     { status:'not_found' }, never to another salon's data. There is no
 *     demo escape hatch here — unlike auth.js's ALLOW_DEMO_TOKEN, inbound
 *     telecom routing is strict, full stop.
 *
 *   • One number → exactly one tenant. tenant_numbers.phone_number is UNIQUE;
 *     if a legacy DB lets two rows share a number, that is 'ambiguous' — a
 *     hard failure, never a guess.
 *
 *   • Disabled numbers are inert. status != 'active' → 'disabled'.
 *
 *   • Results are cached (positive + negative) with short TTLs so a webhook
 *     storm can't hammer Supabase, and a just-provisioned number becomes
 *     routable within seconds (provisioning calls invalidateRouting()).
 *
 * Resolution order (first hit wins):
 *   1. tenant_numbers  — the authoritative routing table
 *   2. tenants.phone_number — legacy single-number column
 *
 * Every inbound transport (TeXML voice, WebSocket stream, Telnyx dynamic
 * variables, SMS) MUST call resolveInboundTenant() and hard-fail when
 * status !== 'resolved'. Do NOT call getTenantByPhone() for inbound
 * routing — it carries the demo fallback this module exists to prevent.
 */

import { db, e164, getTenantByPhoneStrict } from './db.js';
import { ensureMigrations } from './migrate.js';

export const DEMO_TENANT_ID = '00000000-0000-0000-0000-000000000000';

// ── cache ──────────────────────────────────────────────────────────
// Positive entries live ~60s; negative entries ~5s so a freshly
// provisioned number (which invalidates itself) starts routing almost
// immediately even if the provision path forgets to invalidate.
const POS_TTL_MS = 60_000;
const NEG_TTL_MS = 5_000;
const MAX_CACHE = 1000;

const cache = new Map(); // phone -> { status, reason, tenant, source, expiresAt }

function cacheGet(phone) {
  const hit = cache.get(phone);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) { cache.delete(phone); return null; }
  return hit;
}

function cacheSet(phone, entry, ttlMs) {
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(phone, { ...entry, expiresAt: Date.now() + ttlMs });
}

// Drop cached entries for a specific number, or everything when no number
// is given. Provisioning calls this the moment a number is attached.
export function invalidateRouting(number) {
  const phone = e164(number);
  if (phone) cache.delete(phone);
  else cache.clear();
}

function isUsable(tenant) {
  return !!(tenant && tenant.id && tenant.id !== DEMO_TENANT_ID);
}

async function lookupByNumber(number) {
  const c = db();
  if (!c) {
    return { status: 'misconfigured', reason: 'database-not-configured', tenant: null, source: null, number };
  }
  const phone = e164(number);
  if (!phone) {
    return { status: 'not_found', reason: 'invalid-number', tenant: null, source: null, number: null };
  }

  // Self-heal the schema on cold start: a fresh deployment whose DB never ran
  // the tenant_numbers migration gets it applied here before the first lookup.
  await ensureMigrations();

  // 1. Authoritative routing table
  try {
    const { data: routes } = await c
      .from('tenant_numbers')
      .select('tenant_id,status,kind')
      .eq('phone_number', phone)
      .limit(2);
    if (routes && routes.length > 1) {
      return { status: 'ambiguous', reason: 'number-mapped-to-multiple-tenants', tenant: null, source: 'tenant_numbers', number: phone };
    }
    if (routes && routes.length === 1) {
      const route = routes[0];
      if (route.status && route.status !== 'active') {
        return { status: 'disabled', reason: `number-status:${route.status}`, tenant: null, source: 'tenant_numbers', number: phone };
      }
      const { data: t } = await c.from('tenants').select('*').eq('id', route.tenant_id).maybeSingle();
      if (isUsable(t)) return { status: 'resolved', reason: null, tenant: t, source: 'tenant_numbers', number: phone };
      return { status: 'not_found', reason: 'routing-row-without-tenant', tenant: null, source: 'tenant_numbers', number: phone };
    }
  } catch (e) {
    // tenant_numbers may not exist yet (migration pending) — fall through
    // to the legacy column rather than dropping the call.
    console.warn('[tenant-resolver] tenant_numbers query failed:', String(e?.message || e).slice(0, 200));
  }

  // 2. Legacy single-number column
  const legacy = await getTenantByPhoneStrict(phone);
  if (isUsable(legacy)) return { status: 'resolved', reason: null, tenant: legacy, source: 'tenants.phone_number', number: phone };

  return { status: 'not_found', reason: 'no-tenant-for-number', tenant: null, source: null, number: phone };
}

/**
 * Resolve which tenant an inbound call/text belongs to.
 * @param {{ to?: string, from?: string }} signals — `to` is the dialed number.
 * @returns {{ status: string, reason: string|null, tenant: object|null, source: string|null, number: string|null }}
 */
export async function resolveInboundTenant({ to } = {}) {
  const phone = e164(to);
  if (!phone) {
    return { status: 'not_found', reason: 'missing-dialed-number', tenant: null, source: null, number: null };
  }

  const cached = cacheGet(phone);
  if (cached) return { status: cached.status, reason: cached.reason, tenant: cached.tenant, source: cached.source, number: phone };

  const result = await lookupByNumber(phone);

  const ttl = result.status === 'resolved' ? POS_TTL_MS : NEG_TTL_MS;
  cacheSet(phone, result, ttl);
  return result;
}

/**
 * Deployment gate: round-trip a tenant's canonical number and confirm it
 * resolves back to THIS tenant (not another tenant, not "not_found").
 * Bypasses the cache so the gate always reflects the live DB.
 */
export async function verifyTenantRouting(tenant) {
  if (!isUsable(tenant)) return { ready: false, status: 'not_found', reason: 'no-tenant', number: null, source: null };
  const number = e164(tenant.phone_number);
  if (!number) return { ready: false, status: 'not_found', reason: 'no-number-assigned', number: null, source: null };

  const result = await lookupByNumber(number);
  const ready = result.status === 'resolved' && result.tenant?.id === tenant.id;
  return {
    ready,
    status: result.status,
    reason: ready ? null : (result.status === 'resolved' ? 'number-resolves-elsewhere' : (result.reason || 'routing-failed')),
    number,
    source: result.source
  };
}
