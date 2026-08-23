import { bearer, getUserFromToken } from './lib/auth.js';
import { db } from './lib/db.js';
import { resolveTenantForUser } from './lib/tenant-access.js';

function envState(name){ return { name, configured: Boolean(process.env[name]) }; }
function ageMinutes(value){ if(!value) return null; return Math.max(0, Math.round((Date.now()-new Date(value).getTime())/60000)); }

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
  if(req.method==='OPTIONS') return res.status(200).end();
  if(req.method!=='GET') return res.status(405).json({error:'GET only'});
  try{
    const user=await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({error:'not authenticated'});
    const tenant=await resolveTenantForUser(user);
    if(!tenant) return res.status(404).json({error:'tenant not found'});
    const c=db();
    if(!c) return res.status(503).json({error:'database not configured'});
    const since=new Date(Date.now()-24*60*60*1000).toISOString();
    const [callsR,msgsR,intsR]=await Promise.all([
      c.from('calls').select('id,status,direction,created_at,duration_seconds').eq('tenant_id',tenant.id).gte('created_at',since).order('created_at',{ascending:false}).limit(100),
      c.from('messages').select('id,role,created_at').eq('tenant_id',tenant.id).gte('created_at',since).order('created_at',{ascending:false}).limit(200),
      c.from('integrations').select('provider,status,expires_at,updated_at').eq('tenant_id',tenant.id)
    ]);
    const calls=(callsR.data||[]).map(x=>({...x,outcome:x.status||null,duration_sec:x.duration_seconds||null})), messages=msgsR.data||[], integrations=intsR.data||[];
    const lastCall=calls[0]?.created_at||null, lastMessage=messages[0]?.created_at||null;
    const config=[envState('TELNYX_API_KEY'),envState('TELNYX_PUBLIC_KEY'),envState('ELEVENLABS_API_KEY'),envState('ELEVENLABS_VOICE_ID'),envState('APP_URL'),envState('SUPABASE_URL'),envState('SUPABASE_SERVICE_KEY')];
    const requiredConfigured=config.every(x=>x.configured);
    const connected=integrations.filter(x=>x.status==='connected').map(x=>x.provider);
    const failures=calls.filter(x=>['failed','missed','error'].includes(String(x.outcome||'').toLowerCase())).length;
    const answered=calls.filter(x=>!['failed','missed','error'].includes(String(x.outcome||'').toLowerCase())).length;
    const score=Math.max(0,Math.min(100,(tenant.phone_number?20:0)+(requiredConfigured?35:config.filter(x=>x.configured).length*5)+(connected.length?15:0)+(calls.length?15:0)+(messages.length?15:0)-Math.min(20,failures*5)));
    return res.status(200).json({ok:true,tenant:{name:tenant.name,phone_number:tenant.phone_number},score,status:score>=85?'live':score>=60?'degraded':'not_ready',telemetry:{calls_24h:calls.length,answered_24h:answered,failures_24h:failures,messages_24h:messages.length,last_call_at:lastCall,last_call_age_minutes:ageMinutes(lastCall),last_message_at:lastMessage,last_message_age_minutes:ageMinutes(lastMessage)},channels:{voice:Boolean(tenant.phone_number&&process.env.TELNYX_API_KEY),sms:Boolean(tenant.phone_number&&process.env.TELNYX_API_KEY),whatsapp:connected.includes('whatsapp'),dashboard_voice:Boolean(process.env.ELEVENLABS_API_KEY&&process.env.ELEVENLABS_VOICE_ID)},integrations,config,checked_at:new Date().toISOString()});
  }catch(error){ return res.status(500).json({error:String(error?.message||error)}); }
}
