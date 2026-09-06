/**
 * api/lib/tenant-variables.js — ONE source of truth for Lola's per-tenant
 * dynamic variables.
 * ════════════════════════════════════════════════════════════════
 * Consumed by two paths that must NEVER disagree:
 *   • /api/agent-variables — the Telnyx webhook for PHONE calls
 *     (resolves tenant by dialed number, adds caller memory)
 *   • /api/voice-session   — the dashboard orb (resolves tenant by the
 *     signed-in owner; the client sends these as its first session.update)
 *
 * One brain, one voice, one set of facts — whether she answers the phone
 * or speaks from the dashboard.
 */
import { db, tenantKnowledgePrompt } from './db.js';

const NEUTRAL_VARIABLES = {
  tenant_id: '',
  to: '', from: '',
  company_name: 'our salon',
  business_type: 'salon',
  location: '', hours: '', services: '', staff: '', marketing_context: '',
  booking_url: '', knowledge: '',
  caller_known: 'false', caller_name: '', caller_brief: ''
};

export function neutralVariables(overrides = {}) {
  return { ...NEUTRAL_VARIABLES, ...overrides };
}

/**
 * Build the full dynamic_variables object for a tenant. `scope` carries the
 * context that differs per path: the numbers involved and any pre-resolved
 * caller memory (phone path only — the orb has no caller yet).
 */
export async function buildTenantVariables(tenant, scope = {}) {
  const toNumber = scope.to || '';
  const fromNumber = scope.from || '';
  const memory = scope.memory || { caller_known: 'false', caller_name: '', caller_brief: '' };

  let services = '', staffList = '', marketingContext = '';
  try {
    const c = db();
    if (c && tenant?.id) {
      const [svcRes, stfRes, miRes] = await Promise.all([
        c.from('services').select('name,price,duration_minutes').eq('tenant_id', tenant.id).eq('is_active', true).order('name'),
        c.from('staff').select('name,role').eq('tenant_id', tenant.id).eq('is_active', true).order('name'),
        c.from('marketing_intelligence').select('kind,title,summary').eq('tenant_id', tenant.id).order('created_at', { ascending: false }).limit(5)
      ]);
      services = (svcRes.data || []).map(s => s.name + (s.price ? ' $' + s.price : '') + (s.duration_minutes ? ' (' + s.duration_minutes + 'min)' : '')).join('; ');
      staffList = (stfRes.data || []).map(s => s.name + (s.role ? ' (' + s.role + ')' : '')).join(', ');
      marketingContext = (miRes.data || []).map(m => m.kind + ': ' + (m.title || '') + (m.summary ? ' - ' + m.summary : '')).join(' | ');
    }
  } catch (e) { /* never block the voice path on catalog reads */ }

  let servicesFallback = '';
  if (!services && tenant?.services?.length) {
    servicesFallback = tenant.services.map(s => s.name + (s.price ? ' $' + s.price : '') + (s.duration ? ' (' + s.duration + ')' : '')).join('; ');
  }

  return {
    tenant_id: tenant.id || '',
    to: toNumber,
    from: fromNumber,
    company_name: tenant.name || 'our salon',
    business_type: tenant.business_mode || 'salon',
    location: tenant.location || '',
    hours: tenant.hours || '',
    services: services || servicesFallback,
    staff: staffList,
    marketing_context: marketingContext,
    booking_url: tenant.booking_url || ('https://www.loladesk.com/book.html?t=' + (tenant.slug || '')),
    website_url: tenant.website_url || '',
    gmb_url: tenant.gmb_url || tenant.google_review_url || '',
    maps_url: tenant.gmb_url || '',
    knowledge: tenantKnowledgePrompt(tenant),
    ...memory
  };
}
