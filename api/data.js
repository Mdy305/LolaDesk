/**
 * /api/data — unified read API for every dashboard page
 * ════════════════════════════════════════════════════════════════
 * One endpoint, many resources, always tenant-scoped. The frontend
 * lola-data.js calls this so clients/calls/inbox/revenue/team/etc.
 * all show the salon's REAL data instead of hardcoded mockups.
 *
 * GET /api/data?resource=clients&tenant=<slug>
 *   resources: overview | clients | calls | inbox | bookings |
 *              revenue | team | agents | marketing
 *
 * Auth: pass Authorization: Bearer <token> (preferred) OR ?tenant=slug.
 * Degrades to a small demo set if Supabase is empty, so the UI is never blank.
 */
import { db, getTenantBySlug, getTenantIntegrations } from './lib/db.js';
import { getUserFromToken, bearer } from './lib/auth.js';
import { listProviders } from './lib/aggregator.js';
import { getUsageStatus } from './lib/usage.js';

function ago(ts){
  if(!ts) return '';
  const s=Math.floor((Date.now()-new Date(ts).getTime())/1000);
  if(s<60)return 'just now'; if(s<3600)return Math.floor(s/60)+'m ago';
  if(s<86400)return Math.floor(s/3600)+'h ago'; return Math.floor(s/86400)+'d ago';
}
function money(n){ return '$'+Number(n||0).toLocaleString('en-US',{maximumFractionDigits:0}); }

async function resolveTenant(req, q){
  // prefer the authenticated owner's tenant
  try{
    const u = await getUserFromToken(bearer(req));
    if(u){ const c=db(); if(c){ const {data}=await c.from('tenants').select('*').eq('owner_email',u.email).limit(1); if(data&&data[0])return data[0]; } }
  }catch(e){}
  if(q.tenant) return getTenantBySlug(q.tenant);
  return getTenantBySlug('mma');
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method==='OPTIONS') return res.status(200).end();

  let q={}; try{ q=Object.fromEntries(new URL(req.url,'http://x').searchParams); }catch{}
  const resource=q.resource||'overview';

  try{
    const tenant=await resolveTenant(req,q);
    const c=db();
    if(!c || !tenant?.id) return res.status(200).json(demo(resource, tenant));
    const tid=tenant.id;

    switch(resource){
      case 'clients': {
        const { data=[] } = await c.from('clients').select('*').eq('tenant_id',tid).order('updated_at',{ascending:false}).limit(200);
        return res.status(200).json({ tenant:tenant.name, clients:(data||[]).map(x=>({
          id:x.id, name:x.name||'Unknown', phone:x.phone_number||'', email:x.email||'',
          vip:!!x.is_vip, lastService:x.last_service||'', lastVisit:x.last_visit||'',
          stylist:x.preferred_stylist||'', ltv:Number(x.lifetime_value||0), notes:x.notes||'', tags:x.tags||[]
        })) });
      }
      case 'calls': {
        const { data=[] } = await c.from('calls').select('*').eq('tenant_id',tid).order('created_at',{ascending:false}).limit(100);
        return res.status(200).json({ tenant:tenant.name, calls:(data||[]).map(x=>({
          id:x.id, from:x.from_number||x.caller||'', when:ago(x.created_at),
          outcome:x.outcome||'handled', durationSec:x.duration_seconds||x.duration||0,
          summary:x.summary||'', booked:!!x.booked
        })) });
      }
      case 'inbox': {
        const { data=[] } = await c.from('conversations').select('*').eq('tenant_id',tid).order('started_at',{ascending:false}).limit(60);
        return res.status(200).json({ tenant:tenant.name, threads:(data||[]).map(x=>({
          id:x.id, channel:x.channel||'sms', who:x.client_name||x.from_number||'Client',
          when:ago(x.started_at||x.created_at), preview:x.last_message||x.summary||'', unread:!!x.unread
        })) });
      }
      case 'bookings': {
        const { data=[] } = await c.from('bookings').select('*').eq('tenant_id',tid).order('starts_at',{ascending:true}).limit(200);
        return res.status(200).json({ tenant:tenant.name, bookings:(data||[]).map(x=>({
          id:x.id, service:x.service||'Appointment', client:x.client_name||'Client',
          stylist:x.stylist||'', startsAt:x.starts_at, price:Number(x.price||0), status:x.status||'confirmed'
        })) });
      }
      case 'revenue': {
        const { data=[] } = await c.from('bookings').select('price,starts_at,service,stylist').eq('tenant_id',tid).limit(1000);
        const rows=data||[];
        const total=rows.reduce((s,r)=>s+Number(r.price||0),0);
        // by month
        const byMonth={}; for(const r of rows){ const m=(r.starts_at||'').slice(0,7); if(!m)continue; byMonth[m]=(byMonth[m]||0)+Number(r.price||0); }
        // by service
        const byService={}; for(const r of rows){ const k=r.service||'Other'; byService[k]=(byService[k]||0)+Number(r.price||0); }
        return res.status(200).json({ tenant:tenant.name, total, money:money(total),
          months:Object.entries(byMonth).sort().map(([m,v])=>({month:m,value:v})),
          services:Object.entries(byService).sort((a,b)=>b[1]-a[1]).map(([name,value])=>({name,value})),
          bookingCount:rows.length });
      }
      case 'team': {
        const team=Array.isArray(tenant.team)?tenant.team:[];
        return res.status(200).json({ tenant:tenant.name, team:team.length?team:[{name:tenant.owner_name||'Owner',role:'Owner'}] });
      }
      case 'agents': {
        // the 8 skills Lola runs, with live on/off
        return res.status(200).json({ tenant:tenant.name, agents:[
          {id:'reception',name:'Reception',desc:'Answers every call, books appointments',on:true},
          {id:'pricing',name:'Pricing & Services',desc:'Quotes accurate prices and durations',on:true},
          {id:'recommend',name:'Recommender',desc:'Suggests the right service',on:true},
          {id:'recovery',name:'Recovery',desc:'Saves bookings, wins back clients',on:true},
          {id:'leadcapture',name:'Lead Capture',desc:'Never loses a caller',on:true},
          {id:'availability',name:'Availability',desc:'Reads the live calendar',on:true},
          {id:'escalation',name:'Escalation',desc:'Hands off to a human when needed',on:true},
          {id:'memory',name:'Client Memory',desc:'Recognizes returning clients',on:true}
        ]});
      }
      case 'integrations': {
        // Real connection status per provider, decrypted in-memory only
        // long enough to know IF a token exists — never returned to the client.
        const connected = await getTenantIntegrations(tid); // status:'connected' by default
        const connectedByProvider = Object.fromEntries(connected.map(i => [i.provider, i]));
        const providers = listProviders().map(p => {
          const row = connectedByProvider[p.id];
          return {
            id: p.id, name: p.name, description: p.description,
            status: row ? 'connected' : p.status,                 // 'connected' | 'available' | 'pending_partner_approval' | 'needs_credentials'
            connectedAt: row?.created_at || null,
            metadata: row?.metadata ? { shop: row.metadata.shop || null } : null // never leak tokens, only safe display fields
          };
        });
        return res.status(200).json({ tenant: tenant.name, tenantSlug: tenant.slug, providers });
      }
      case 'marketing': {
        const { data=[] } = await c.from('clients').select('last_visit,is_vip').eq('tenant_id',tid).limit(1000);
        const rows=data||[];
        const now=Date.now();
        const lapsed=rows.filter(r=>r.last_visit && (now-new Date(r.last_visit))/86400000>60).length;
        const vips=rows.filter(r=>r.is_vip).length;
        return res.status(200).json({ tenant:tenant.name,
          segments:[
            {id:'winback',name:'Win-back',count:lapsed,desc:"Haven't visited in 60+ days"},
            {id:'vip',name:'VIP',count:vips,desc:'Your best clients'},
            {id:'all',name:'All clients',count:rows.length,desc:'Everyone'}
          ]});
      }
      case 'overview':
      default: {
        const since=new Date(Date.now()-30*86400000).toISOString();
        const [cl,ca,bk,usage]=await Promise.all([
          c.from('clients').select('id',{count:'exact',head:true}).eq('tenant_id',tid).then(r=>r.count||0).catch(()=>0),
          c.from('calls').select('id',{count:'exact',head:true}).eq('tenant_id',tid).gte('created_at',since).then(r=>r.count||0).catch(()=>0),
          c.from('bookings').select('price').eq('tenant_id',tid).gte('starts_at',since).then(r=>r.data||[]).catch(()=>[]),
          getUsageStatus(tid, tenant.plan).catch(()=>null)
        ]);
        const rev=bk.reduce((s,r)=>s+Number(r.price||0),0);
        return res.status(200).json({ tenant:tenant.name,
          kpis:{ clients:cl, calls30:ca, bookings30:bk.length, revenue30:rev, revenue30Money:money(rev) },
          usage });
      }
    }
  }catch(e){
    return res.status(200).json({ ...demo(resource), _error:String(e&&e.message||e) });
  }
}

// ── demo fallback so the UI is never empty during setup ──
function demo(resource, tenant){
  const name=tenant?.name||'Your Salon';
  const D={
    clients:{tenant:name,clients:[
      {name:'Sarah Chen',phone:'+13055551234',vip:true,lastService:'Balayage',lastVisit:'2026-05-02',stylist:'Michelle',ltv:2840,notes:'Wedding in July',tags:['vip','color']},
      {name:'Maria Lopez',phone:'+13055555678',vip:false,lastService:'Keratin',lastVisit:'2026-04-18',stylist:'Alice',ltv:1350,notes:'',tags:['treatment']},
      {name:'Jen Park',phone:'+13055559012',vip:false,lastService:'Cut & Gloss',lastVisit:'2026-03-30',stylist:'Samantha',ltv:680,notes:'Prefers mornings',tags:[]}
    ]},
    calls:{tenant:name,calls:[
      {from:'+13055551234',when:'12m ago',outcome:'booked',durationSec:142,summary:'Booked balayage for Friday',booked:true},
      {from:'+13055555678',when:'1h ago',outcome:'handled',durationSec:88,summary:'Asked about keratin pricing',booked:false},
      {from:'+13055559012',when:'3h ago',outcome:'booked',durationSec:201,summary:'Rescheduled to next week',booked:true}
    ]},
    inbox:{tenant:name,threads:[
      {channel:'sms',who:'Sarah Chen',when:'20m ago',preview:'Perfect, see you Friday!',unread:true},
      {channel:'sms',who:'Maria Lopez',when:'2h ago',preview:'What times do you have?',unread:false}
    ]},
    bookings:{tenant:name,bookings:[
      {service:'Balayage',client:'Sarah Chen',stylist:'Michelle',startsAt:'2026-06-20T14:00:00',price:395,status:'confirmed'},
      {service:'Blowout',client:'Jen Park',stylist:'Samantha',startsAt:'2026-06-18T10:00:00',price:95,status:'confirmed'}
    ]},
    revenue:{tenant:name,total:18450,money:'$18,450',
      months:[{month:'2026-03',value:5200},{month:'2026-04',value:6100},{month:'2026-05',value:7150}],
      services:[{name:'Balayage',value:7900},{name:'Keratin',value:4500},{name:'Extensions',value:3200},{name:'Cut & Gloss',value:2850}],
      bookingCount:62},
    team:{tenant:name,team:[{name:'Meddy',role:'Owner · Colorist'},{name:'Michelle',role:'Stylist'},{name:'Alice',role:'Stylist'},{name:'Samantha',role:'Stylist'}]},
    agents:{tenant:name,agents:[
      {id:'reception',name:'Reception',desc:'Answers every call, books appointments',on:true},
      {id:'memory',name:'Client Memory',desc:'Recognizes returning clients',on:true},
      {id:'recovery',name:'Recovery',desc:'Saves bookings, wins back clients',on:true}
    ]},
    marketing:{tenant:name,segments:[
      {id:'winback',name:'Win-back',count:14,desc:"Haven't visited in 60+ days"},
      {id:'vip',name:'VIP',count:8,desc:'Your best clients'},
      {id:'all',name:'All clients',count:165,desc:'Everyone'}
    ]},
    integrations:{tenant:name, tenantSlug:'demo', providers: listProviders().map(p=>({ ...p, connectedAt:null, metadata:null }))},
    overview:{tenant:name,kpis:{clients:165,calls30:48,bookings30:62,revenue30:18450,revenue30Money:'$18,450'},
      usage:{plan:'pro',planName:'Pro',quotas:{voice_call:600,sms_sent:2500,ai_token:8000},
        usage:{voice_call:210,sms_sent:980,ai_token:3100},
        percentages:{voice_call:35,sms_sent:39,ai_token:39},
        mostUsedKind:'sms_sent',mostUsedPercent:39,mostUsedLabel:'texts sent',
        nearLimit:false,overLimit:false}}
  };
  return D[resource]||D.overview;
}
