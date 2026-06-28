const AGENTS = [
  {
    id: 'lola',
    key: 'LOLA',
    emoji: '🎧',
    name: 'LOLA',
    lane: 'Voice / Calls',
    title: 'Call Center AI',
    service: 'voice-handler-service',
    description: 'Handles inbound voice calls, phone bookings, and live call recovery.'
  },
  {
    id: 'ops',
    key: 'OPS',
    emoji: '🧑‍💼',
    name: 'Ops AI',
    lane: 'Bookings / CRM',
    title: 'Front Desk AI',
    service: 'booking-crm-service',
    description: 'Runs bookings, CRM workflows, reminders, and operational follow-ups.'
  },
  {
    id: 'growth',
    key: 'GROWTH',
    emoji: '📈',
    name: 'Growth AI',
    lane: 'SEO / GMB',
    title: 'Growth Engine',
    service: 'seo-marketing-service',
    description: 'Optimizes discoverability, local rankings, and growth campaigns.'
  },
  {
    id: 'website',
    key: 'WEBSITE',
    emoji: '🌐',
    name: 'Website AI',
    lane: 'Widget / CRO',
    title: 'Website Agent',
    service: 'cro-widget-service',
    description: 'Improves site conversion, booking widgets, and on-site UX flows.'
  },
  {
    id: 'reputation',
    key: 'REPUTATION',
    emoji: '⭐',
    name: 'Reputation AI',
    lane: 'Reviews',
    title: 'Review Agent',
    service: 'review-management-service',
    description: 'Drives review volume, response quality, and reputation recovery.'
  },
  {
    id: 'citation',
    key: 'CITATION',
    emoji: '🗺️',
    name: 'Citation AI',
    lane: 'Directory Consistency',
    title: 'Citation Agent',
    service: 'nap-consistency-service',
    description: 'Maintains NAP consistency and listing accuracy across directories.'
  },
  {
    id: 'publication',
    key: 'PUBLICATION',
    emoji: '📰',
    name: 'Publication AI',
    lane: 'Content Distribution',
    title: 'Publication Agent',
    service: 'content-syndication-service',
    description: 'Publishes and syndicates content to increase authority and demand.'
  }
];

const AGENT_ALIASES = {
  lola: 'LOLA',
  voice: 'LOLA',
  calls: 'LOLA',
  'call center': 'LOLA',
  ops: 'OPS',
  operations: 'OPS',
  'front desk': 'OPS',
  bookings: 'OPS',
  growth: 'GROWTH',
  seo: 'GROWTH',
  gmb: 'GROWTH',
  website: 'WEBSITE',
  web: 'WEBSITE',
  cro: 'WEBSITE',
  reputation: 'REPUTATION',
  reviews: 'REPUTATION',
  review: 'REPUTATION',
  citation: 'CITATION',
  citations: 'CITATION',
  listing: 'CITATION',
  publication: 'PUBLICATION',
  content: 'PUBLICATION',
  publishing: 'PUBLICATION'
};

export function listControlPlaneAgents(){
  return AGENTS.map(a => ({ ...a }));
}

export function normalizeAgentName(input){
  if(!input) return null;
  const raw = String(input).trim();
  if(!raw) return null;
  const upper = raw.toUpperCase();
  const direct = AGENTS.find(a => a.key === upper || a.id.toUpperCase() === upper);
  if(direct) return direct.key;
  const mapped = AGENT_ALIASES[raw.toLowerCase()];
  return mapped || null;
}

export function getAgentByName(input){
  const key = normalizeAgentName(input);
  if(!key) return null;
  return AGENTS.find(a => a.key === key) || null;
}

export function summarizeTopology(){
  return {
    orchestrator: {
      id: 'orchestrator',
      emoji: '🧠',
      name: 'Orchestrator',
      title: 'Control Plane',
      description: 'Routes work to specialized agents and keeps cross-agent state coherent.'
    },
    agents: listControlPlaneAgents()
  };
}
