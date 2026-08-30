import { getUserFromToken, bearer } from './lib/auth.js';
import { db } from './lib/db.js';
import { resolveTenantForUser } from './lib/tenant-access.js';

const PROVIDERS = ['square','boulevard','fresha','vagaro','mindbody','booksy','shopify','google_calendar','google_gmb','cal_platform'];

function state(id, name, status, detail, action, metadata={}){
  return { id, name, status, detail, action, metadata };
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
  if(req.method==='OPTIONS') return res.status(204).end();
  if(req.method!=='GET') return res.status(405).json({ok:false,error:'GET only'});
  try{
    const user=await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({ok:false,error:'Not authenticated'});
    const tenant=await resolveTenantForUser(user);
    if(!tenant?.id) return res.status(404).json({ok:false,error:'No tenant mapped to this account'});
    const client=db();
    if(!client) return res.status(503).json({ok:false,error:'Database not configured'});

    const {data:rows,error}=await client.from('integrations')
      .select('provider,status,expires_at,metadata,updated_at')
      .eq('tenant_id',tenant.id);
    if(error) throw error;
    const byProvider=new Map((rows||[]).map(row=>[row.provider,row]));
    const now=Date.now();
    const bookingProvider=String(tenant.booking_provider||tenant.booking_platform||'').toLowerCase();
    const bookingUrl=String(tenant.booking_url||'').trim();

    const integrations=[];
    const voiceReady=Boolean(tenant.phone_number&&process.env.TELNYX_API_KEY);
    integrations.push(state('voice','Voice & Text',voiceReady?'healthy':'blocked',voiceReady?`Live on ${tenant.phone_number}`:(tenant.phone_number?'Telnyx server connection is missing':'No Lola phone number is assigned'),voiceReady?'test':'open_numbers',{phone:tenant.phone_number||null}));

    const whatsappRow=byProvider.get('whatsapp');
    const whatsappReady=Boolean(whatsappRow?.status==='connected' || tenant.whatsapp_enabled);
    integrations.push(state('whatsapp','WhatsApp',whatsappReady?'healthy':'not_connected',whatsappReady?'Connected and available for tenant messaging':'Not connected for this tenant',whatsappReady?'test':'connect'));

    for(const id of PROVIDERS){
      const row=byProvider.get(id);
      const expired=row?.expires_at&&new Date(row.expires_at).getTime()<=now;
      const selected=id===bookingProvider;
      let status='not_connected',detail='Available to connect',action='connect';
      if(row?.status==='connected'&&!expired){status='healthy';detail=`Connected${row.updated_at?` · checked ${new Date(row.updated_at).toLocaleDateString('en-US')}`:''}`;action='test';}
      else if(expired){status='attention';detail='Authorization expired — reconnect required';action='reconnect';}
      else if(row?.status&&row.status!=='connected'){status='attention';detail=`Connection status: ${row.status}`;action='reconnect';}
      else if(selected&&bookingUrl){status='link_only';detail='Booking link saved; live calendar sync is not connected';action='connect';}
      const nameMap={google_calendar:'Google Calendar',google_gmb:'Google reviews (GMB)',mindbody:'Mindbody',cal_platform:'Cal.com (White-Label)'};
      integrations.push(state(id,nameMap[id]||id.charAt(0).toUpperCase()+id.slice(1),status,detail,action,row?.metadata||{}));
    }

    const knowledgeReady=Boolean(tenant.website_url || (Array.isArray(tenant.services)&&tenant.services.length));
    integrations.push(state('website','Website Knowledge',knowledgeReady?'healthy':'attention',knowledgeReady?'Lola has a business knowledge source':'Add a website or service menu so Lola can answer accurately',knowledgeReady?'refresh':'open_activation',{website:tenant.website_url||null}));

    const critical=integrations.filter(item=>['voice','website'].includes(item.id)||(item.id===bookingProvider));
    const blockers=critical.filter(item=>!['healthy'].includes(item.status));
    const healthy=integrations.filter(item=>item.status==='healthy').length;
    const score=Math.round((healthy/integrations.length)*100);

    return res.status(200).json({ok:true,tenant:{id:tenant.id,slug:tenant.slug,name:tenant.name},score,healthy,total:integrations.length,blockers:blockers.map(x=>x.id),integrations,checked_at:new Date().toISOString()});
  }catch(error){
    return res.status(500).json({ok:false,error:String(error?.message||error)});
  }
}
