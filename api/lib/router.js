import { getAgentByName } from './agent-topology.js';

// What each specialist lane means to Lola when the owner hands it a job.
// There are no separate worker services: every lane is Lola's own owner brain
// (lib/dashboard-brain.js — the same tools as the dashboard, signed-in salon
// only), told which hat she is wearing. The answer the owner sees is what she
// actually said and did — never a "delegated" placeholder.
const LANE_BRIEF = {
  LOLA: 'You are working as the salon’s call-center lead (calls, phone bookings, missed-call recovery).',
  OPS: 'You are working as the salon’s front-desk operations lead (bookings, client records, reminders, follow-ups).',
  GROWTH: 'You are working as the salon’s marketing lead (filling empty chairs, win-back campaigns, offers). Prefer drafting a campaign for the owner to approve over sending anything.',
  WEBSITE: 'You are working as the salon’s website lead (the booking widget and the path from website to booked).',
  REPUTATION: 'You are working as the salon’s reviews lead (asking for reviews, drafting replies).',
  CITATION: 'You are working as the salon’s listings lead (name, address and phone consistent on Google and directories).',
  PUBLICATION: 'You are working as the salon’s content lead (posts and content that bring clients in).',
};

// Injected for tests; defaults to the real owner brain.
let brain = null;
export function __setBrain(fn) { brain = fn; }
async function ownerBrain(args) {
  if (brain) return brain(args);
  const { dashboardBrainReply } = await import('./dashboard-brain.js');
  return dashboardBrainReply(args);
}

function replyText(json) {
  if (!json) return '';
  if (Array.isArray(json.content)) return json.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim();
  return String(json.text || json.reply || json.speak || '').trim();
}

/**
 * Hand a task to a specialist lane. Needs the signed-in salon (full tenant row);
 * without it nothing runs.
 *   → { status: 'done', agent, accepted_task, reply, actions?, intent? }
 *   → { status: 'unauthenticated' | 'error', error }
 */
export const delegateToAgent = async (agentName, task, tenantContext = {}, context = {}) => {
  const target = getAgentByName(agentName);
  if (!target) {
    return {
      status: 'error',
      error: `Unknown agent: ${agentName || '(empty)'}`,
      known_agents: ['lola', 'ops', 'growth', 'website', 'reputation', 'citation', 'publication']
    };
  }
  const agent = { id: target.id, key: target.key, name: target.name, service: target.service };
  if (!tenantContext || !tenantContext.id) return { status: 'unauthenticated', agent, error: 'Sign in to put Lola to work for your salon.' };

  const accepted = String(task || 'Run a quick check-in and tell me the one thing to do next.').slice(0, 1200);
  try {
    const out = await ownerBrain({
      tenant: tenantContext,
      user: context.user || null,
      req: null,
      body: {
        channel: 'dashboard',
        system: LANE_BRIEF[target.key] || '',
        messages: [{ role: 'user', content: accepted }],
      },
    });
    const json = out && out.json;
    const reply = replyText(json);
    if (!out || out.status >= 400 || !reply) {
      return { status: 'error', agent, accepted_task: accepted, error: (json && json.error && (json.error.message || json.error)) || 'Lola couldn’t finish that just now.' };
    }
    return { status: 'done', orchestrator: 'lola', agent, accepted_task: accepted, reply, intent: json.intent || null, actions: Array.isArray(json.actions) ? json.actions : [] };
  } catch (e) {
    console.error('[router] owner brain failed:', e?.message || e);
    return { status: 'error', agent, accepted_task: accepted, error: 'Lola couldn’t finish that just now.' };
  }
};
