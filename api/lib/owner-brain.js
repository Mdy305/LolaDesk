/**
 * api/lib/owner-brain.js — Lola's full conversational brain for OWNERS
 * ════════════════════════════════════════════════════════════════════
 * The Jarvis line's deterministic grammar handles the closed commands
 * (day / revenue / cancel / move / broadcast / book) fast and offline.
 * Everything ELSE an owner might ask — "should I raise my balayage
 * price?", "how do I handle a no-show client?", "write me an Instagram
 * caption for the new lash service", "why was Tuesday slow?" — lands
 * here: the real LLM, grounded in a LIVE snapshot of THEIR business
 * so answers are about their salon, not salons in general.
 *
 * Grounding assembled per turn (all best-effort, cheap queries):
 *   · identity: salon name, owner, mode, location, hours, services+prices
 *   · owner's "teach Lola" knowledge notes
 *   · today's schedule (count + next appointment)
 *   · revenue this week and this month
 *   · rebooking radar (how many clients are overdue)
 *   · accumulated owner memory (client_memories under 'owner')
 *
 * Used by BOTH owner channels — the Jarvis voice line and texting the
 * Jarvis number — so the owner has one continuous adviser everywhere.
 * Voice replies are asked to stay tight (they're spoken aloud).
 */
import { chat } from './llm.js';
import { getOwnerMemory, setOwnerMemory } from './db.js';
import { listBookings, revenueSummary, dueForRebooking } from './operator-db.js';
import { buildClientMemoryBlock, profileFromMemoryRows } from './lola-skills.js';
import { observationsBlock, briefingLine } from './lola-intelligence.js';
import { businessSnapshot as liveSetup, situation as liveDay, chiefOfStaffStyle, within } from './owner-awareness.js';

function fmtMoney(n){ return '$' + (Math.round((Number(n)||0)*100)/100).toLocaleString('en-US'); }

export async function businessSnapshot(tenant){
  const today = new Date(); today.setHours(0,0,0,0);
  const weekStart = new Date(today); weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const [todayRows, week, month, due] = await Promise.all([
    listBookings(tenant.id, { from: today, to: today }).catch(()=>[]),
    revenueSummary(tenant.id, { from: weekStart, to: new Date() }).catch(()=>({ total:0, count:0 })),
    revenueSummary(tenant.id, { from: monthStart, to: new Date() }).catch(()=>({ total:0, count:0 })),
    dueForRebooking(tenant.id, { sinceDays: 42 }).catch(()=>[])
  ]);
  const next = todayRows.find(b => new Date(b.starts_at) > new Date());
  return {
    today_count: todayRows.length,
    next_appointment: next ? `${new Date(next.starts_at).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})} ${next.service||''}` : null,
    revenue_week: week.total, revenue_week_count: week.count,
    revenue_month: month.total, revenue_month_count: month.count,
    overdue_rebook_count: due.length
  };
}

export async function buildOwnerSystemPrompt(tenant, { channel = 'voice' } = {}){
  let services = [];
  try{ services = Array.isArray(tenant.services) ? tenant.services : JSON.parse(tenant.services||'[]'); }catch{}
  const menu = services.map(s => `${s.name}${s.price?` ($${s.price})`:''}${s.duration?` ${s.duration}`:''}`).join('; ');

  let snapshot = null;
  try{ snapshot = await businessSnapshot(tenant); }catch{}
  // The live setup (menu, team, hours, Google — what onboarding synced) and the day in salon time.
  const setup = await within(2500, liveSetup(tenant), null);
  const day = setup ? await within(3000, liveDay(tenant, { snap: setup }), null) : null;

  let memoryBlock = '';
  try{ memoryBlock = buildClientMemoryBlock(profileFromMemoryRows(await getOwnerMemory(tenant.id))) || ''; }catch{}

  // What a sharp GM would have noticed since you last talked.
  let noticed = '';
  try{ noticed = await observationsBlock(tenant); }catch{}

  // Strategic memory: the running thread of what this owner is working
  // on (goals, decisions, preferences) — so Lola picks up the campaign,
  // not just the last message. Stored under the 'strategy' owner key.
  let strategy = '';
  try{
    const rows = await getOwnerMemory(tenant.id);
    const row = (rows||[]).find(r => r.key === 'strategy');
    if(row?.value?.notes) strategy = `THE OWNER'S RUNNING CONTEXT (things you've been helping with — reference naturally): ${row.value.notes}`;
  }catch{}

  const voiceRules = channel === 'voice'
    ? `You are SPEAKING on a phone call: 1–3 short sentences, no lists, no markdown. Contractions always; vary your openers; mirror the owner's energy; say numbers like a person ("three ninety-five"). Refer back to earlier in the conversation — that's what listening sounds like. If a topic truly needs depth, give the headline and offer to text the details.`
    : `You are texting: keep replies under 3 short sentences, plain text, no markdown.`;

  return [
    chiefOfStaffStyle(tenant),
    `You are Lola — not an assistant, but the person who runs ${tenant.name}: its front desk manager and head of marketing, speaking privately with the owner${tenant.owner_name ? `, ${String(tenant.owner_name).split(' ')[0]}` : ''}. You have the judgment of a operator who's run salons for fifteen years and the recall of someone who never forgets a client or a number. Warm, sharp, decisive. You don't hedge; you have opinions and you back them with the numbers below.`,
    setup ? setup.prompt : `Business: ${tenant.business_mode || 'salon'} in ${tenant.location || 'their city'}. Hours: ${tenant.hours || 'not set'}.`,
    setup ? '' : (menu ? `Menu: ${menu}.` : ''),
    day ? day.prompt : '',
    tenant.knowledge ? `Owner's notes for you: ${tenant.knowledge}` : '',
    snapshot && !day ? `Live numbers right now — today: ${snapshot.today_count} appointment${snapshot.today_count===1?'':'s'}${snapshot.next_appointment?`, next up ${snapshot.next_appointment}`:''}; this week: ${fmtMoney(snapshot.revenue_week)} across ${snapshot.revenue_week_count}; this month: ${fmtMoney(snapshot.revenue_month)} across ${snapshot.revenue_month_count}; ${snapshot.overdue_rebook_count} clients overdue to rebook.` : '',
    noticed,
    strategy,
    memoryBlock,
    `You advise on and drive ANYTHING that grows this business: pricing, promotions, retention, difficult clients, staffing, social content, scheduling strategy, supplies, local marketing. Always ground advice in the real numbers above. When you spot something important in what you've noticed, bring it up yourself — a great manager doesn't wait to be asked.`,
    `You have NOT done anything in this conversation: nothing is booked, blocked, moved, cancelled or texted unless the owner already confirmed it in a command. Never say or imply you did ("done", "I've blocked", "I sent", "I cancelled"). To ACT on the calendar or message clients, give the exact command and offer to run it once they confirm: "block Thursday afternoon for maintenance", "remove the Thursday block", "cancel NAME's appointment", "move NAME to DAY at TIME", "text my VIPs saying ...", "book NAME for SERVICE", "revenue locked in next week". ${channel === 'voice' ? 'On the phone they confirm with their PIN and the word confirm.' : 'By text: they send the command, you reply with the plan, and it runs when they reply YES.'} Frame it as you taking the action ("I can block Thursday afternoon — want me to?"), not as homework for them.`,
    voiceRules
  ].filter(Boolean).join('\n');
}

// "I've blocked…", "I just cancelled…", "Done — I texted…" — words only a tool result may say.
const CLAIMED_ACTION = /\b(?:i(?:'ve| have| just| already)?|done[,!.:—–-]*\s*(?:i(?:'ve)?)?|all set[,!.:—–-]*\s*(?:i(?:'ve)?)?)\s+(?:blocked|cancell?ed|moved|rescheduled|texted|sent|messaged|removed|unblocked|marked|launched)\b/i;

/**
 * answerOwner — one call: grounded system prompt + recent history + the
 * owner's question → Lola's reply. Returns { ok, text }.
 */
export async function answerOwner(tenant, history, userText, { channel = 'voice' } = {}){
  try{
    const system = await buildOwnerSystemPrompt(tenant, { channel });
    const messages = [
      ...(Array.isArray(history) ? history.slice(-10) : []),
      { role: 'user', content: String(userText||'') }
    ];
    const r = await chat({ system, messages, maxTokens: channel === 'voice' ? 220 : 300, temperature: 0.6, source: 'owner' });
    if(r?.ok && String(r.text||'').trim()){
      // This brain has no hands: a reply that claims a change happened is replaced with an honest offer.
      if(CLAIMED_ACTION.test(String(r.text))){
        return { ok: true, text: channel === 'voice'
          ? "I haven't changed anything yet. Tell me exactly what to do, like block Thursday afternoon, and I'll set it up for your PIN."
          : "I haven't changed anything yet. Text me the exact command, like \"block Thursday afternoon\", and I'll do it when you reply YES.", guarded: true };
      }
      // Strategic memory: quietly keep a rolling note of what the owner is
      // working on, so the NEXT conversation continues the thread instead
      // of starting cold. Best-effort, fire-and-forget.
      updateStrategy(tenant, userText, r.text).catch(()=>{});
      return { ok: true, text: String(r.text).trim() };
    }
    return { ok: false, text: '' };
  }catch{
    return { ok: false, text: '' };
  }
}

// Roll the owner's latest exchange into a compact running-context note.
// Capped so the prompt stays lean; newest context wins.
async function updateStrategy(tenant, userText, reply){
  const u = String(userText||'').trim();
  if(u.length < 8) return; // ignore trivial "yes"/"ok" turns
  let prev = '';
  try{
    const rows = await getOwnerMemory(tenant.id);
    prev = (rows||[]).find(r => r.key === 'strategy')?.value?.notes || '';
  }catch{}
  const stamp = new Date().toISOString().slice(0,10);
  const entry = `(${stamp}) ${u.slice(0,160)}`;
  // keep the last ~6 distinct threads
  const merged = [entry, ...prev.split(' · ').filter(Boolean)]
    .filter((v,i,a) => a.indexOf(v) === i)
    .slice(0, 6)
    .join(' · ');
  await setOwnerMemory(tenant.id, 'strategy', { notes: merged, updated: stamp });
}

// Re-export so voice/SMS greetings can open with a proactive line.
export { briefingLine };
