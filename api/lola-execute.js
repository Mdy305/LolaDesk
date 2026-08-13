import crypto from 'node:crypto';
import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantAccessForUser } from './lib/tenant-access.js';
import { executeLolaAction, resolveExecutionTenant } from './lib/lola-executor.js';

function bodyOf(req){ if(!req.body)return {}; if(typeof req.body==='string'){try{return JSON.parse(req.body||'{}')}catch{return {}}} return req.body; }
function safeEqual(a,b){
  if(!a||!b)return false;
  const aa=Buffer.from(String(a)),bb=Buffer.from(String(b));
  return aa.length===bb.length && crypto.timingSafeEqual(aa,bb);
}

export default async function handler(req,res){
  const origin=process.env.APP_ORIGIN||'https://www.loladesk.com';
  res.setHeader('Access-Control-Allow-Origin',origin);
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization,x-lola-number,x-lola-execution-secret');
  if(req.method==='OPTIONS') return res.status(204).end();
  if(req.method!=='POST') return res.status(405).json({ok:false,error:'method_not_allowed'});

  const body=bodyOf(req), action=String(body.action||body.tool||'').trim();
  if(!action) return res.status(400).json({ok:false,error:'action_required'});

  try{
    let tenant=null, actor='lola';
    const user=await getUserFromToken(bearer(req));
    if(user){
      const access=await resolveTenantAccessForUser(user);
      tenant=access?.tenant||null;
      actor=`user:${user.id}`;
    }else{
      const expected=process.env.LOLA_EXECUTION_SECRET;
      const supplied=req.headers['x-lola-execution-secret'];
      if(!expected || !safeEqual(supplied,expected)) return res.status(401).json({ok:false,error:'not_authenticated'});
      tenant=await resolveExecutionTenant({...body,to:body.to||req.headers['x-lola-number']});
      actor=body.actor||'lola-machine';
    }

    if(!tenant?.id) return res.status(403).json({ok:false,error:'tenant_not_mapped'});
    const result=await executeLolaAction({
      action,tenant,input:body.input||body,
      channel:body.channel||'lola',
      conversationId:body.conversation_id||null,
      actor
    });
    return res.status(200).json(result);
  }catch(error){
    console.error('[lola-execute]',error);
    return res.status(500).json({ok:false,error:'execution_route_failed'});
  }
}
