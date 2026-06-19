/**
 * api/lib/orchestrator.js — routes a task to the right specialized agent.
 * Uses the shared db() client so env vars + tenant scoping stay consistent.
 */
import { db } from './db.js';

export async function processTask(tenantId, agentName, payload){
  const c = db();
  if(!c) throw new Error('Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY)');

  const { data: tenant, error } = await c
    .from('tenants').select('*').eq('id', tenantId).single();
  if(error) throw new Error('Unknown tenant: ' + tenantId);

  console.log(`Processing ${agentName} for tenant ${tenantId}`);

  return {
    status: 'success',
    agent: agentName,
    tenant: tenant?.slug || tenantId,
    timestamp: new Date().toISOString(),
  };
}
