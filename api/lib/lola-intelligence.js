/**
 * api/lib/lola-intelligence.js — what makes Lola feel like Jarvis
 * ════════════════════════════════════════════════════════════════
 * A chatbot waits to be asked. Jarvis NOTICES. This engine scans a
 * tenant's live data and returns ranked "observations" — the things
 * a sharp human GM would walk up and tell the owner without being
 * asked: gaps in today's book, VIPs slipping away, a slow day, an
 * unusually strong week, unhandled callbacks.
 *
 * Two consumers:
 *   · owner-brain injects the top observations into every prompt, so
 *     Lola can weave them in ("by the way, your 2pm cancelled and
 *     Maria's overdue — want me to offer her the slot?").
 *   · a future daily-briefing job can read the same function.
 *
 * Everything is best-effort and defensive: a data hiccup yields
 * fewer observations, never an error. No observation is invented —
 * each is a fact drawn from real rows, with a concrete suggested
 * action Lola can offer to take.
 */
import { db } from './db.js';
import { listBookings, revenueSummary, dueForRebooking } from './operator-db.js';

function money(n){ return '$' + Math.round(Number(n)||0).toLocaleString('en-US'); }
function startOfDay(d){ const x=new Date(d); x.setHours(0,0,0,0); return x; }

/**
 * observe(tenant) → [{ severity, kind, insight, action }]
 * severity: 'opportunity' | 'risk' | 'win' — ranked, top first.
 * insight: one sentence a human would say.
 * action: the concrete thing Lola can offer to do (or null).
 */
export async function observe(tenant){
  const out = [];
  const today = startOfDay(new Date());
  const weekStart = new Date(today); weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const lastWeekStart = new Date(weekStart); lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  const lastWeekEnd = new Date(weekStart); lastWeekEnd.setMilliseconds(-1);

  const [todayBk, thisWeek, lastWeek, due] = await Promise.all([
    listBookings(tenant.id, { from: today, to: today, limit: 50 }).catch(()=>[]),
    revenueSummary(tenant.id, { from: weekStart, to: new Date() }).catch(()=>({ total:0, count:0 })),
    revenueSummary(tenant.id, { from: lastWeekStart, to: lastWeekEnd }).catch(()=>({ total:0, count:0 })),
    dueForRebooking(tenant.id, { sinceDays: 42, limit: 50 }).catch(()=>[])
  ]);

  const now = new Date();
  const remaining = todayBk.filter(b => new Date(b.starts_at) > now && !['cancelled','no_show'].includes(String(b.status||'')));
  const cancelledToday = todayBk.filter(b => String(b.status||'') === 'cancelled');

  // ── RISK: empty or thin book today ──
  if(todayBk.length === 0){
    out.push({ severity:'risk', kind:'empty_day',
      insight: `Today's book is empty.`,
      action: due.length ? `blast your ${Math.min(due.length,50)} overdue clients a same-day opening` : `post a last-minute opening to your VIPs` });
  } else if(remaining.length > 0 && remaining.length <= 2 && now.getHours() < 15){
    out.push({ severity:'opportunity', kind:'thin_day',
      insight: `Only ${remaining.length} appointment${remaining.length===1?'':'s'} left today with hours still open.`,
      action: `text nearby overdue clients a same-day slot` });
  }

  // ── OPPORTUNITY: cancellation today + someone overdue to fill it ──
  if(cancelledToday.length && due.length){
    const who = due[0]?.name ? ` ${String(due[0].name).split(' ')[0]}` : ' a VIP';
    out.push({ severity:'opportunity', kind:'fill_cancellation',
      insight: `You had ${cancelledToday.length} cancellation${cancelledToday.length===1?'':'s'} today.`,
      action: `offer${who} — who's overdue — the open slot` });
  }

  // ── RISK: VIPs slipping ──
  const vipsDue = due.filter(c => c.is_vip);
  if(vipsDue.length){
    const names = vipsDue.slice(0,3).map(c => String(c.name||'').split(' ')[0]).filter(Boolean).join(', ');
    out.push({ severity:'risk', kind:'vip_slipping',
      insight: `${vipsDue.length} VIP${vipsDue.length===1?'':'s'} ${vipsDue.length===1?'is':'are'} overdue to rebook${names?` (${names})`:''}.`,
      action: `send them a warm personal win-back` });
  } else if(due.length >= 5){
    out.push({ severity:'opportunity', kind:'rebook_backlog',
      insight: `${due.length} clients are overdue to rebook.`,
      action: `run a win-back text to the overdue segment` });
  }

  // ── WIN or RISK: week vs last week ──
  if(lastWeek.total > 0){
    const delta = (thisWeek.total - lastWeek.total) / lastWeek.total;
    if(delta >= 0.15){
      out.push({ severity:'win', kind:'strong_week',
        insight: `This week is up ${Math.round(delta*100)}% over last (${money(thisWeek.total)} vs ${money(lastWeek.total)}).`,
        action: null });
    } else if(delta <= -0.2){
      out.push({ severity:'risk', kind:'soft_week',
        insight: `This week is down ${Math.round(Math.abs(delta)*100)}% from last (${money(thisWeek.total)} vs ${money(lastWeek.total)}).`,
        action: `fill the gap with a promo to overdue clients` });
    }
  }

  // rank: risks and opportunities before wins; keep it tight (Jarvis is brief)
  const order = { risk:0, opportunity:1, win:2 };
  out.sort((a,b) => order[a.severity] - order[b.severity]);
  return out.slice(0, 4);
}

/**
 * briefingLine(tenant) — a single spoken-ready sentence for greetings
 * and daily briefings. Returns '' if nothing noteworthy.
 */
export async function briefingLine(tenant){
  const obs = await observe(tenant).catch(()=>[]);
  if(!obs.length) return '';
  const top = obs[0];
  const tail = top.action ? ` Want me to ${top.action}?` : '';
  return `${top.insight}${tail}`;
}

/**
 * observationsBlock(tenant) — formatted for the owner-brain system
 * prompt, so the LLM can weave observations in naturally.
 */
export async function observationsBlock(tenant){
  const obs = await observe(tenant).catch(()=>[]);
  if(!obs.length) return '';
  const lines = obs.map(o => `- [${o.severity}] ${o.insight}${o.action ? ` (you can offer to: ${o.action})` : ''}`);
  return `WHAT YOU'VE NOTICED (surface the most important of these proactively when it fits — like a sharp GM would, without being asked; don't dump the whole list):\n${lines.join('\n')}`;
}
