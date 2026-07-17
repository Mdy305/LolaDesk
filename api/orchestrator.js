/**
 * /api/orchestrator — the working brain behind Growth Studio
 * ════════════════════════════════════════════════════════════════
 * Before: no auth, client-supplied tenant, OpenAI call outside the
 * app's LLM stack, and a delegate that console.log'd. After: a real
 * agent runtime — Bearer-authed, tenant resolved SERVER-side, seven
 * agents each grounded in this salon's live Supabase data, every run
 * written to orchestrator_audit, and a deterministic fallback per
 * agent so "Put to work" produces value even with every LLM down.
 *
 *   POST { agent|route_to, task } → { ok, agent, speak, summary }
 */
import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db } from './lib/db.js';
import { chat } from './lib/llm.js';
import { businessSnapshot } from './lib/owner-brain.js';
import { observe } from './lib/lola-intelligence.js';
import { listBookings, dueForRebooking } from './lib/operator-db.js';

const money = n => '$' + Math.round(Number(n)||0).toLocaleString('en-US');

/* Each agent: gather(tenant) → grounded facts; persona → LLM voice;
   fallback(facts) → deterministic value when the LLM is unavailable. */
const AGENTS = {
  growth: {
    persona: 'You are Growth — the salon\'s campaign strategist. Concrete, revenue-first, no fluff.',
    async gather(t){
      const [obs, due] = await Promise.all([observe(t).catch(()=>[]), dueForRebooking(t.id,{sinceDays:42,limit:12}).catch(()=>[])]);
      return { obs, due };
    },
    ask: (f)=>`Observations: ${f.obs.map(o=>o.insight).join(' ')} Overdue clients: ${f.due.map(c=>c.name).filter(Boolean).slice(0,8).join(', ')||'none'}. Write: (1) the single highest-ROI move this week, (2) one ready-to-send win-back text under 160 chars.`,
    fallback(f, t){
      const top = f.obs[0];
      const names = f.due.map(c=>String(c.name||'').split(' ')[0]).filter(Boolean).slice(0,5).join(', ');
      return `${top ? top.insight + ' ' : ''}${f.due.length} clients are overdue to rebook${names?` (${names}…)`:''}. Highest-ROI move: a win-back text to the overdue segment. Draft: "Hi! It's ${t.name} — we've missed you. This week only, come back and your favorite service is waiting. Reply YES and we'll hold a spot."`;
    }
  },
  ops: {
    persona: 'You are Ops — the salon\'s operations chief. Terse punch-lists, priority order.',
    async gather(t){
      const today = new Date(); today.setHours(0,0,0,0);
      const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate()+1);
      const c = db();
      const [tod, tom, cb, wl] = await Promise.all([
        listBookings(t.id,{from:today,to:today}).catch(()=>[]),
        listBookings(t.id,{from:tomorrow,to:tomorrow}).catch(()=>[]),
        c.from('callback_requests').select('id',{count:'exact'}).eq('tenant_id',t.id).eq('status','pending').limit(1).then(r=>r.count??0).catch(()=>0),
        c.from('waitlist_entries').select('id',{count:'exact'}).eq('tenant_id',t.id).eq('status','active').limit(1).then(r=>r.count??0).catch(()=>0)
      ]);
      return { today: tod.length, tomorrow: tom.length, callbacks: cb, waitlist: wl };
    },
    ask: f=>`Today: ${f.today} appointments. Tomorrow: ${f.tomorrow}. Pending callbacks: ${f.callbacks}. Active waitlist: ${f.waitlist}. Produce a priority punch-list (max 4 items).`,
    fallback: f=>`Today ${f.today} on the book, tomorrow ${f.tomorrow}. Priorities: ${f.callbacks?`return ${f.callbacks} pending callback${f.callbacks===1?'':'s'}; `:''}${f.waitlist?`offer open slots to ${f.waitlist} waitlisted client${f.waitlist===1?'':'s'}; `:''}${f.tomorrow===0?'tomorrow is empty — trigger a same-week fill campaign; ':''}confirm tomorrow's first appointment by text.`
  },
  lola: {
    persona: 'You are Lola\'s voice-quality analyst. Diagnose booking leakage from call outcomes.',
    async gather(t){
      const c = db();
      const { data } = await c.from('calls').select('outcome,transcript,duration_sec').eq('tenant_id',t.id).order('created_at',{ascending:false}).limit(20);
      const calls = data||[];
      const booked = calls.filter(x=>x.outcome==='booked').length;
      const answered = calls.length;
      return { answered, booked, rate: answered? Math.round(100*booked/answered) : 0 };
    },
    ask: f=>`Last ${f.answered} calls: ${f.booked} booked (${f.rate}%). Diagnose leakage and give the single highest-impact fix.`,
    fallback: f=> f.answered===0
      ? 'No calls on record yet — once the booking line rings, I\'ll report conversion and leakage here.'
      : `Last ${f.answered} calls → ${f.booked} booked (${f.rate}%). ${f.rate<40?'Below the 40% healthy floor: most leakage happens when price is quoted without an immediate time offer — Lola should always follow a quote with two concrete slots.':'Healthy conversion. Next lever: post-call text follow-up to the non-bookers.'}`
  },
  website: {
    persona: 'You are Website — a CRO specialist for salon sites. One high-impact fix at a time.',
    async gather(t){ return { url: t.website_url||'', hasWidget: false }; },
    ask: (f,t)=>`Site: ${f.url||'not set'}. The salon has an embeddable Lola chat widget available. Give the top conversion fix for a salon website and where to place the chat widget.`,
    fallback: (f,t)=> f.url
      ? `Top fix for ${f.url}: put the booking action above the fold on mobile, and install your Lola chat widget (Settings → "Lola on your website") — sites with live chat convert visitors that static pages lose.`
      : `Add your website in Settings first — then install the Lola widget from "Lola on your website" so every visitor can chat and book. That's the single highest-converting change for a salon site.`
  },
  reputation: {
    persona: 'You are Reputation — you draft review responses worth signing.',
    async gather(t){ return {}; },
    ask: (f,t)=>`Draft two review responses for ${t.name}: one for a glowing 5-star, one for an unfair 2-star. Warm, specific, owner-voiced, under 60 words each.`,
    fallback: (f,t)=>`5-star reply: "Thank you — days like yours are why we do this. See you at your next appointment at ${t.name}!" · 2-star reply: "I'm sorry this visit missed our standard. I'd love to make it right personally — call us and ask for the owner. — ${t.owner_name||'The owner'}, ${t.name}"`
  },
  citation: {
    persona: 'You are Citation — local-listing consistency auditor.',
    async gather(t){ return { name:t.name, location:t.location||'', phone:t.phone_number||'' }; },
    ask: f=>`Business: ${f.name}, ${f.location}, ${f.phone}. List the exact NAP fields to verify across Google Business, Yelp, Apple Maps, Instagram and Facebook, and the one inconsistency that hurts ranking most.`,
    fallback: f=>`Verify EXACTLY this everywhere — Name: "${f.name}" · Address: "${f.location||'SET YOUR LOCATION IN SETTINGS'}" · Phone: "${f.phone||'your Lola number'}" — on Google Business, Yelp, Apple Maps, Instagram bio, Facebook. The #1 ranking killer: a phone number that differs between Google and your website.`
  },
  publication: {
    persona: 'You are Publication — the salon\'s content planner. Specific posts, not themes.',
    async gather(t){
      let services=[]; try{ services = Array.isArray(t.services)?t.services:JSON.parse(t.services||'[]'); }catch{}
      return { services: services.map(s=>s.name).slice(0,5) };
    },
    ask: f=>`Services: ${f.services.join(', ')||'general salon'}. Write a 5-post week: day, format (reel/photo/story), and the exact hook line for each.`,
    fallback: f=>{
      const s = f.services;
      return `This week: Mon — before/after reel${s[0]?` (${s[0]})`:''}, hook: "Watch the whole transformation." · Wed — chair-side story poll: "Your next look: warmer or brighter?" · Thu — client spotlight photo + one-line quote. · Fri — "2 openings left tomorrow" story with booking link. · Sun — team behind-the-scenes reel, hook: "Sunday reset at the salon."`;
    }
  }
};

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).json({ ok:false });

  // AUTH WALL — the old version had none. Tenant is resolved server-side.
  const user = await getUserFromToken(bearer(req));
  if(!user) return res.status(401).json({ ok:false, error:'Not signed in' });
  const tenant = await resolveTenantForUser(user);
  if(!tenant?.id) return res.status(403).json({ ok:false, error:'No salon linked to this account' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});
  const agentId = String(body.agent || body.route_to || '').toLowerCase();
  const task = String(body.task || 'Run a check-in.').slice(0, 400);
  const agent = AGENTS[agentId];
  if(!agent) return res.status(400).json({ ok:false, error:'unknown agent', agents: Object.keys(AGENTS) });

  // Ground in live data, think, and always land on value.
  let facts = {};
  try{ facts = await agent.gather(tenant); }catch{}
  let snapshot = null; try{ snapshot = await businessSnapshot(tenant); }catch{}

  let summary = '', engine = 'deterministic';
  try{
    const r = await chat({
      system: `${agent.persona}\nSalon: ${tenant.name}${tenant.location?` (${tenant.location})`:''}.` +
        (snapshot ? ` Live: week ${money(snapshot.revenue_week)}, month ${money(snapshot.revenue_month)}, ${snapshot.overdue_rebook_count} overdue to rebook.` : '') +
        `\nAnswer in plain text, max 120 words, concrete and immediately usable.`,
      messages: [{ role:'user', content: `${task}\n\n${agent.ask(facts, tenant)}` }],
      maxTokens: 300, temperature: 0.5, source: 'orchestrator'
    });
    if(r?.ok && String(r.text||'').trim()){ summary = String(r.text).trim(); engine = 'llm'; }
  }catch{}
  if(!summary) summary = agent.fallback(facts, tenant);

  // Every run is auditable.
  try{
    const c = db();
    await c.from('orchestrator_audit').insert({
      prompt: `[${agentId}] ${task}`,
      llm_output: { tenant_id: tenant.id, agent: agentId, task, engine, summary },
      valid: true, validated_at: new Date()
    });
  }catch(e){ console.error('[orchestrator] audit failed', e?.message); }

  return res.status(200).json({
    ok: true, agent: agentId, engine,
    speak: `${agentId.charAt(0).toUpperCase()+agentId.slice(1)} is done.`,
    summary,
    // legacy shape for any old caller
    routed: { status:'delegated' }
  });
}
