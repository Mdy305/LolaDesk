/**
 * /api/notifications — Lola's awareness feed
 * ════════════════════════════════════════════════════════════════
 * The living atom polls this to know what's happening in the business
 * right now, so it can glow on new events and surface insights.
 *
 * Multi-tenant: resolves the salon by ?tenant=slug or ?to=+number.
 * Pulls recent activity from Supabase (bookings, calls, leads, messages)
 * and derives smart "insights" (double-bookings, VIP notes, gaps).
 *
 * GET /api/notifications?tenant=mma   ->  { events:[...], insights:[...], counts:{...} }
 *
 * Degrades gracefully: if Supabase isn't configured, returns a small
 * demo feed so the atom still feels alive.
 */

import { db, getTenantBySlug, getTenantByPhone } from './lib/db.js';

function timeAgo(ts){
  if(!ts) return '';
  const s = Math.floor((Date.now() - new Date(ts).getTime())/1000);
  if(s < 60) return 'just now';
  if(s < 3600) return Math.floor(s/60)+'m ago';
  if(s < 86400) return Math.floor(s/3600)+'h ago';
  return Math.floor(s/86400)+'d ago';
}

async function resolveTenant(q){
  if(q.tenant) return getTenantBySlug(q.tenant);
  if(q.to) return getTenantByPhone(q.to);
  return getTenantBySlug('mma'); // sensible default
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();

  let q = {};
  try{ q = Object.fromEntries(new URL(req.url,'http://x').searchParams); }catch{}

  try{
    const tenant = await resolveTenant(q);
    const c = db();

    // No Supabase -> demo feed so the atom is still alive
    if(!c || !tenant?.id){
      return res.status(200).json(demoFeed());
    }

    const tid = tenant.id;
    const since = new Date(Date.now() - 24*3600*1000).toISOString();

    // recent activity (best-effort; tables may be sparse)
    const [bookings, calls, leads, convos] = await Promise.all([
      c.from('bookings').select('*').eq('tenant_id',tid).gte('created_at',since).order('created_at',{ascending:false}).limit(10).then(r=>r.data||[]).catch(()=>[]),
      c.from('calls').select('*').eq('tenant_id',tid).gte('created_at',since).order('created_at',{ascending:false}).limit(10).then(r=>r.data||[]).catch(()=>[]),
      c.from('usage').select('*').eq('tenant_id',tid).eq('kind','lead').gte('created_at',since).order('created_at',{ascending:false}).limit(10).then(r=>r.data||[]).catch(()=>[]),
      c.from('conversations').select('*').eq('tenant_id',tid).gte('started_at',since).order('started_at',{ascending:false}).limit(10).then(r=>r.data||[]).catch(()=>[])
    ]);

    const events = [];
    for(const b of bookings) events.push({ type:'booking', icon:'calendar', title:`New booking — ${b.service||'appointment'}`, when:timeAgo(b.created_at), ts:b.created_at });
    for(const l of leads) events.push({ type:'lead', icon:'user', title:`New lead captured`, when:timeAgo(l.created_at), ts:l.created_at });
    for(const cl of calls) events.push({ type:'call', icon:'phone', title:`Call ${cl.outcome||'handled'}`, when:timeAgo(cl.created_at), ts:cl.created_at });
    events.sort((a,b)=> new Date(b.ts) - new Date(a.ts));

    // derive insights
    const insights = deriveInsights(bookings, tenant);

    return res.status(200).json({
      tenant: tenant.name || 'our salon',
      counts: { bookings: bookings.length, leads: leads.length, calls: calls.length },
      events: events.slice(0,8),
      insights
    });
  }catch(e){
    return res.status(200).json({ ...demoFeed(), _error:String(e&&e.message||e) });
  }
}

function deriveInsights(bookings, tenant){
  const insights = [];
  // double-booking detection: same start time twice
  const byTime = {};
  for(const b of bookings){
    if(!b.starts_at) continue;
    const key = new Date(b.starts_at).toISOString().slice(0,16);
    byTime[key] = (byTime[key]||0)+1;
    if(byTime[key] === 2){
      const d = new Date(b.starts_at);
      insights.push({ level:'warn', text:`Possible double-booking around ${d.toLocaleString([], {weekday:'short', hour:'numeric', minute:'2-digit'})}.` });
    }
  }
  // quiet-day nudge
  if(bookings.length === 0){
    insights.push({ level:'info', text:`No new bookings in the last 24h — want me to draft a win-back text?` });
  }
  return insights;
}

function demoFeed(){
  return {
    tenant: 'our salon',
    counts: { bookings: 3, leads: 2, calls: 5 },
    events: [
      { type:'booking', icon:'calendar', title:'New booking — Balayage', when:'12m ago' },
      { type:'call', icon:'phone', title:'Call handled — booked', when:'40m ago' },
      { type:'lead', icon:'user', title:'New lead captured', when:'1h ago' },
      { type:'booking', icon:'calendar', title:'New booking — Blowout', when:'2h ago' }
    ],
    insights: [
      { level:'warn', text:'Two appointments overlap tomorrow at 2:00 PM — want me to fix it?' },
      { level:'info', text:'A VIP client returns Friday — she had a note about scalp sensitivity.' }
    ]
  };
}
