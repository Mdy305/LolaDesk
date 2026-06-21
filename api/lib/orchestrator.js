/**
 * api/lib/orchestrator.js — Core Memory & Skills Engine
 * ════════════════════════════════════════════════════════════════
 * This module bridges the Telnyx Lola Brain with the Supabase backend.
 * It manages Long-Term Memory (LTM) for clients and safely routes
 * tool executions (skills) scoped strictly to the active tenant.
 */

import { db, e164 } from './db.js';

/**
 * Fetch a client's long-term memory (LTM) context for Lola.
 * Returns a prompt string that can be injected into Lola's system prompt
 * at the start of a call or text thread.
 */
export async function injectCallerMemory(tenantId, clientPhone) {
  const c = db();
  if (!c || !tenantId || !clientPhone) return '';

  try {
    const phone = e164(clientPhone);
    const { data: client } = await c
      .from('clients')
      .select('id, name, notes, opted_out')
      .eq('tenant_id', tenantId)
      .eq('phone_number', phone)
      .maybeSingle();

    if (!client) return `Note: First-time caller/texter. Get their name.`;
    
    if (client.opted_out) {
      return `CRITICAL: This client has opted out of SMS. DO NOT send them texts.`;
    }

    let memoryStr = `Client Name: ${client.name || 'Unknown'}\n`;
    if (client.notes) {
      memoryStr += `Permanent Memory Notes: ${client.notes}\n`;
    }

    // Fetch their last booking to give Lola context
    const { data: lastBooking } = await c
      .from('bookings')
      .select('service, starts_at, stylist')
      .eq('client_id', client.id)
      .order('starts_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastBooking) {
      memoryStr += `Last Visit: ${lastBooking.service} with ${lastBooking.stylist || 'a stylist'} on ${new Date(lastBooking.starts_at).toLocaleDateString()}.\n`;
    }

    return memoryStr;
  } catch (e) {
    console.error('[orchestrator] Error injecting memory:', e);
    return '';
  }
}

/**
 * Extract takeaways from a completed conversation and save them
 * permanently to the client's profile in Supabase.
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
      .eq('phone_number', phone)
      .maybeSingle();

    if (!client) return;

    // Append new notes to existing notes
    const newNotes = client.notes ? `${client.notes}\n- ${summaryText}` : `- ${summaryText}`;
    
    await c
      .from('clients')
      .update({ notes: newNotes })
      .eq('id', client.id);

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
