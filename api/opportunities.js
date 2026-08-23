import { db } from './lib/db.js';
import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantAccessForUser } from './lib/tenant-access.js';

const DAY=86400000;
const money=n=>'$'+Number(n||0).toLocaleString('en-US',{maximumFractionDigits:0});

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method==='OPTIONS') return res.status(200).end();
  if(req.method!=='GET') return res.status(405).json({error:'Method not allowed'});
  try{
    const user=await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({error:'Not authenticated'});
    const access=await resolveTenantAccessForUser(user);
    const tenant=access?.tenant;
    if(!tenant?.id) return res.status(403).json({error:'No tenant mapped'});
    const c=db();
    if(!c) return res.status(200).json({tenant:tenant.name||'Your business',opportunities:[],potentialRevenue:0,attribution:{actions:0,conversions:0,revenue:0,revenueMoney:'$0'},dataUnavailable:true});

    const now=Date.now(), next7=new Date(now+7*DAY).toISOString(), since90=new Date(now-90*DAY).toISOString();
    const [clientsQ,bookingsQ,eventsQ]=await Promise.all([
      c.from('clients').select('id,first_name,last_name,phone,last_visit,preferred_service,lifetime_value,status').eq('tenant_id',tenant.id).limit(1000),
      c.from('bookings').select('id,client_id,service:services(name),price:total_amount,starts_at:start_time,created_at,status').eq('tenant_id',tenant.id).gte('start_time',since90).limit(2000),
      c.from('usage_events').select('kind,metadata,created_at').eq('tenant_id',tenant.id).in('kind',['opportunity_opened','opportunity_executed','opportunity_dismissed']).gte('created_at',since90).order('created_at',{ascending:false}).limit(500)
    ]);
    if(clientsQ.error||bookingsQ.error||eventsQ.error) throw clientsQ.error||bookingsQ.error||eventsQ.error;
    const clients=(clientsQ.data||[]).map(client=>({
      ...client,
      name:[client.first_name,client.last_name].filter(Boolean).join(' ').trim()||'Client',
      phone_number:client.phone||null,
      last_service:client.preferred_service||null,
      is_vip:String(client.status||'').toLowerCase()==='vip'||Number(client.lifetime_value||0)>=1000
    })), bookings=(bookingsQ.data||[]).map(b=>({...b,service:b.service?.name||null})), events=eventsQ.data||[];
    const futureClientIds=new Set(bookings.filter(b=>new Date(b.starts_at).getTime()>=now&&b.status!=='cancelled').map(b=>b.client_id).filter(Boolean));
    const historical=bookings.filter(b=>new Date(b.starts_at).getTime()<now&&b.status!=='cancelled');
    const avgTicket=historical.length?historical.reduce((s,b)=>s+Number(b.price||0),0)/historical.length:100;
    const opportunities=[];

    const lapsed=clients.filter(c=>c.last_visit&&!futureClientIds.has(c.id)&&(now-new Date(c.last_visit).getTime())/DAY>=60).sort((a,b)=>Number(b.lifetime_value||0)-Number(a.lifetime_value||0)).slice(0,12);
    if(lapsed.length){const estimate=Math.round(lapsed.length*avgTicket*.3);opportunities.push({id:'winback',type:'winback',priority:'high',title:`Win back ${lapsed.length} lapsed clients`,detail:'They have not returned in 60+ days and have no future booking.',potentialRevenue:estimate,clientIds:lapsed.map(c=>c.id),cta:'Draft campaign',prompt:`Draft a premium win-back campaign for these lapsed clients: ${lapsed.map(c=>c.name).join(', ')}. Keep it personal and appointment-focused.`,targetPage:'marketing.html'});}

    const vipDue=clients.filter(c=>c.is_vip&&c.last_visit&&!futureClientIds.has(c.id)&&(now-new Date(c.last_visit).getTime())/DAY>=35).sort((a,b)=>Number(b.lifetime_value||0)-Number(a.lifetime_value||0)).slice(0,8);
    if(vipDue.length){const estimate=Math.round(vipDue.length*avgTicket*.5);opportunities.push({id:'vip-rebook',type:'vip',priority:'high',title:`Rebook ${vipDue.length} VIP clients`,detail:'High-value clients are approaching or past their normal return window.',potentialRevenue:estimate,clientIds:vipDue.map(c=>c.id),cta:'Ask Lola',prompt:`Prepare personalized rebooking messages for these VIP clients: ${vipDue.map(c=>c.name).join(', ')}. Mention their last service where available and suggest the best premium next visit.`});}

    const upcoming=bookings.filter(b=>new Date(b.starts_at).getTime()>=now&&new Date(b.starts_at).getTime()<=new Date(next7).getTime()&&b.status!=='cancelled');
    const upsellable=upcoming.filter(b=>Number(b.price||0)>0).slice(0,10);
    if(upsellable.length){const estimate=Math.round(upsellable.reduce((s,b)=>s+Number(b.price||0)*.12,0));opportunities.push({id:'upsell',type:'upsell',priority:'medium',title:`Prepare add-ons for ${upsellable.length} upcoming bookings`,detail:'Lola can recommend relevant treatments or upgrades before arrival.',potentialRevenue:estimate,clientIds:upsellable.map(b=>b.client_id).filter(Boolean),cta:'Build recommendations',prompt:`Review the next ${upsellable.length} bookings and create one relevant, tasteful high-margin add-on recommendation for each client.`});}

    const latestById={};
    for(const e of events){const id=e.metadata?.opportunity_id;if(id&&!latestById[id])latestById[id]={event:e.kind.replace('opportunity_',''),at:e.created_at};}
    for(const o of opportunities){o.lifecycle=latestById[o.id]||{event:'identified',at:null};}

    const executed=events.filter(e=>e.kind==='opportunity_executed');
    const convertedBookingIds=new Set(); let attributedRevenue=0;
    for(const e of executed){const actedAt=new Date(e.created_at).getTime();const ids=new Set(e.metadata?.client_ids||[]);for(const b of bookings){if(!b.client_id||!ids.has(b.client_id)||b.status==='cancelled'||convertedBookingIds.has(b.id))continue;const created=new Date(b.created_at||b.starts_at).getTime();if(created>=actedAt&&created<=actedAt+30*DAY){convertedBookingIds.add(b.id);attributedRevenue+=Number(b.price||0);}}}
    const potentialRevenue=opportunities.reduce((s,o)=>s+Number(o.potentialRevenue||0),0);
    const attribution={actions:executed.length,conversions:convertedBookingIds.size,revenue:Math.round(attributedRevenue),revenueMoney:money(attributedRevenue)};
    return res.status(200).json({tenant:tenant.name||'Your business',averageTicket:Math.round(avgTicket),potentialRevenue,potentialRevenueMoney:money(potentialRevenue),attribution,opportunities:opportunities.slice(0,5)});
  }catch(error){
    console.error('[opportunities]',error);
    return res.status(200).json({tenant:'Your business',opportunities:[],potentialRevenue:0,potentialRevenueMoney:'$0',attribution:{actions:0,conversions:0,revenue:0,revenueMoney:'$0'},dataUnavailable:true});
  }
}
