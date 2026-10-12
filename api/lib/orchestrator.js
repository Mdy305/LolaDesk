/**
 * api/lib/orchestrator.js — Core Memory & Skills Engine
 * ════════════════════════════════════════════════════════════════
 * This module bridges the Telnyx Lola Brain with the Supabase backend.
 * It manages Long-Term Memory (LTM) for clients and safely routes
 * tool executions (skills) scoped strictly to the active tenant.
 */

import { db, e164 } from './db.js';
import { bookingGateResponse, BLOCKED_BOOKING_ACTIONS } from './billing-gate.js';

/**
 * Fetch a client's long-term memory (LTM) context for Lola — the SAME story every channel uses
 * (lib/client-brain clientStory): name, visits, last + next visit, usual stylist, spend, formulas,
 * saved memories. Tenant-scoped; `tenant` may be the tenant row or its id.
 */
export async function injectCallerMemory(tenant, clientPhone) {
  const c = db();
  const t = tenant && typeof tenant === 'object' ? tenant : (tenant ? { id: tenant } : null);
  if (!c || !t?.id || !clientPhone) return '';
  try {
    const phone = e164(clientPhone);
    const { data: client } = await c.from('clients').select('*').eq('tenant_id', t.id).eq('phone', phone).maybeSingle();
    if (!client) return 'First-time caller/texter. Get their name.';
    const { clientStory } = await import('./client-brain.js');
    const story = await clientStory(c, t, client);
    const lines = [];
    if (client.opted_out || client.sms_opt_out) lines.push('CRITICAL: This client has opted out of texts. Do not text them.');
    lines.push(story.brief ? `Client: ${story.brief}.` : `Client: ${story.name || 'name unknown'} (no visits yet).`);
    if (story.profile?.preferences?.length) lines.push('Preferences: ' + story.profile.preferences.slice(-3).join('; ') + '.');
    if (story.profile?.allergies?.length) lines.push('Allergies / sensitivities: ' + story.profile.allergies.join('; ') + '.');
    return lines.join('\n');
  } catch (e) {
    console.error('[orchestrator] Error injecting memory:', e?.message || e);
    return '';
  }
}

/**
 * Extract takeaways from a completed conversation and save them
 * permanently to the client's profile in Supabase (this salon's client only).
 */
export async function saveConversationMemory(tenantId, clientPhone, summaryText) {
  const c = db();
  if (!c || !tenantId || !clientPhone || !summaryText) return;

  try {
    const phone = e164(clientPhone);
    const { data: client } = await c
      .from('clients')
      .select('id, notes')
      .eq('tenant_id', tenantId)
      .eq('phone', phone)
      .maybeSingle();

    if (!client) return;

    // Append new notes to existing notes
    const newNotes = client.notes ? `${client.notes}\n- ${summaryText}` : `- ${summaryText}`;

    await c
      .from('clients')
      .update({ notes: newNotes })
      .eq('id', client.id)
      .eq('tenant_id', tenantId);

  } catch (e) {
    console.error('[orchestrator] Error saving memory:', e);
  }
}

/**
 * Execute a skill safely by wrapping the tool call and injecting
 * database validations (e.g. ensuring tenant scoping).
 */
export async function executeSkill(tenant, clientPhone, toolName, payload, skillsRegistry) {
  if (!tenant || !tenant.id) {
    throw new Error('Tenant is required to execute skills.');
  }
  
  if (!skillsRegistry[toolName]) {
    throw new Error(`Skill ${toolName} not found in registry.`);
  }

  // Trial-to-paid gate: expired/suspended tenants cannot create new bookings
  // through the legacy skill layer either. Cancels stay open so clients are
  // never stranded. The legacy layer is caller-facing, so callers get the
  // graceful decline (never reveals billing state).
  if (BLOCKED_BOOKING_ACTIONS.has(toolName)) {
    const gate = bookingGateResponse(tenant, 'voice');
    if (gate) return gate;
  }

  console.log(`[orchestrator] Executing skill '${toolName}' for tenant ${tenant.slug}`);
  
  try {
    // We pass the tenant and the enhanced payload to the skill
    const result = await skillsRegistry[toolName](tenant, payload);
    return result;
  } catch (error) {
    console.error(`[orchestrator] Skill ${toolName} failed:`, error);
    throw error;
  }
}
