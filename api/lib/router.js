export const delegateToAgent = async (agentName, task, tenantContext) => {
  const agents = {
    'LOLA': 'voice-handler-service',
    'OPS': 'booking-crm-service',
    'GROWTH': 'seo-marketing-service',
    'WEBSITE': 'cro-widget-service',
    'REPUTATION': 'review-management-service',
    'CITATION': 'nap-consistency-service',
    'PUBLICATION': 'content-syndication-service'
  };

  const target = agents[agentName];
  // Logic to call the specific worker service/function
  console.log(`Delegating ${task} to ${target} for tenant ${tenantContext.id}`); 
  return { status: "delegated", agent: target };
};
