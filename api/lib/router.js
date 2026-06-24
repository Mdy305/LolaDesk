import { getAgentByName } from './agent-topology.js';

export const delegateToAgent = async (agentName, task, tenantContext = {}, context = {}) => {
  const target = getAgentByName(agentName);
  if(!target){
    return {
      status: 'error',
      error: `Unknown agent: ${agentName || '(empty)'}`,
      known_agents: ['lola','ops','growth','website','reputation','citation','publication']
    };
  }

  const tenantId = tenantContext.id || tenantContext.slug || 'unknown-tenant';
  const payload = {
    task: task || 'No task specified',
    tenant: {
      id: tenantContext.id || null,
      slug: tenantContext.slug || null,
      name: tenantContext.name || null
    },
    context: context || {}
  };

  // Placeholder handoff for external worker services.
  console.log(`[router] Delegating "${payload.task}" to ${target.service} (${target.key}) for tenant ${tenantId}`);
  return {
    status: 'delegated',
    orchestrator: 'control-plane',
    agent: {
      id: target.id,
      key: target.key,
      name: target.name,
      service: target.service
    },
    accepted_task: payload.task
  };
};
