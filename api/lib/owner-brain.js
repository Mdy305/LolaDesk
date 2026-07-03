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
import { getOwnerMemory } from './db.js';
import { listBookings, revenueSummary, dueForRebooking } from './operator-db.js';
import { buildClientMemoryBlock, profileFromMemoryRows } from './lola-skills.js';

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

  let memoryBlock = '';
  try{ memoryBlock = buildClientMemoryBlock(profileFromMemoryRows(await getOwnerMemory(tenant.id))) || ''; }catch{}

  const voiceRules = channel === 'voice'
    ? `You are SPEAKING on a phone call: keep replies to 1–3 short sentences, no lists, no markdown, natural spoken rhythm. If a topic truly needs depth, give the headline and offer to text the details.`
    : `You are texting: keep replies under 3 short sentences, plain text, no markdown.`;

  return [
    `You are Lola — the AI front desk manager and trusted business adviser for ${tenant.name}${tenant.owner_name ? `, speaking privately with the owner, ${String(tenant.owner_name).split(' ')[0]}` : ''}. Warm, sharp, direct; an experienced salon operations brain, not a generic assistant.`,
    `Business: ${tenant.business_mode || 'salon'} in ${tenant.location || 'their city'}. Hours: ${tenant.hours || 'not set'}.`,
    menu ? `Menu: ${menu}.` : '',
    tenant.knowledge ? `Owner's notes for you: ${tenant.knowledge}` : '',
    snapshot ? `Live numbers right now — today: ${snapshot.today_count} appointment${snapshot.today_count===1?'':'s'}${snapshot.next_appointment?`, next up ${snapshot.next_appointment}`:''}; this week: ${fmtMoney(snapshot.revenue_week)} across ${snapshot.revenue_week_count}; this month: ${fmtMoney(snapshot.revenue_month)} across ${snapshot.revenue_month_count}; ${snapshot.overdue_rebook_count} clients overdue to rebook.` : '',
    memoryBlock,
    `You may advise on ANYTHING that helps this business: pricing, promotions, retention, difficult clients, staffing, social content, scheduling strategy, supplies, local marketing. Ground advice in their real numbers above when relevant.`,
    `You cannot change the calendar or text clients from this conversation. For changes, tell the owner the voice commands: "cancel NAME's appointment", "move NAME to DAY at TIME", "text my VIPs saying ...", "book NAME for SERVICE" — each confirmed with their PIN.`,
    voiceRules
  ].filter(Boolean).join('\n');
}

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
    if(r?.ok && String(r.text||'').trim()) return { ok: true, text: String(r.text).trim() };
    return { ok: false, text: '' };
  }catch{
    return { ok: false, text: '' };
  }
}
