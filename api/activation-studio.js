import { bearer, getUserFromToken } from './lib/auth.js';
import { db } from './lib/db.js';
import { resolveTenantForUser } from './lib/tenant-access.js';

const ok=(id,title,ready,detail,href)=>({id,title,ready:Boolean(ready),detail,href});
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
    if(!tenant?.id) return res.status(404).json({ok:false,error:'No tenant found'});
    const c=db();
    if(!c) return res.status(503).json({ok:false,error:'Database not configured'});
    const [onboarding,clients,bookings,calls]=await Promise.all([
      c.from('tenant_onboarding').select('*').eq('tenant_id',tenant.id).maybeSingle(),
      c.from('clients').select('id',{count:'exact',head:true}).eq('tenant_id',tenant.id),
      c.from('bookings').select('id',{count:'exact',head:true}).eq('tenant_id',tenant.id),
      c.from('calls').select('id',{count:'exact',head:true}).eq('tenant_id',tenant.id)
    ]);
    const ob=onboarding.data||{};
    const checks=[
      ok('identity','Business identity',tenant.name&&tenant.location,'Name and location are known.','activation-studio.html#identity'),
      ok('knowledge','Business knowledge',tenant.website_url||ob.business?.website_url,'Website or source material is connected.','activation-studio.html#knowledge'),
      ok('booking','Booking system',tenant.booking_url||ob.booking?.booking_url,'A booking destination is configured.','activation-studio.html#booking'),
      ok('phone','Lola phone line',tenant.phone_number,'A tenant phone number is assigned.','numbers.html'),
      ok('voice','Voice engine',process.env.ELEVENLABS_API_KEY&&process.env.ELEVENLABS_VOICE_ID&&process.env.TELNYX_API_KEY,'Telnyx and ElevenLabs server credentials are present.','settings.html#voice'),
      ok('data','Live business data',(clients.count||0)+(bookings.count||0)+(calls.count||0)>0,`${clients.count||0} clients · ${bookings.count||0} bookings · ${calls.count||0} calls detected.`,'activation-studio.html#data')
    ];
    const readyCount=checks.filter(x=>x.ready).length;
    const score=Math.round(readyCount/checks.length*100);
    return res.status(200).json({ok:true,tenant:{id:tenant.id,name:tenant.name,location:tenant.location,phone_number:tenant.phone_number,booking_url:tenant.booking_url,website_url:tenant.website_url},score,can_go_live:score===100,checks,recommendation:checks.find(x=>!x.ready)||null,onboarding:ob});
  }catch(error){return res.status(error?.status||500).json({ok:false,error:String(error?.message||error)});}
}
