import { db, e164 } from './db.js';

function fullName(c={}){ return [c.first_name,c.last_name].filter(Boolean).join(' ').trim() || 'Client'; }
function score({bookings=0,spent=0,lastVisit=null,conversations=0}={}){
  let s=0; if(bookings>=10)s+=35; else if(bookings>=5)s+=25; else if(bookings>=1)s+=10;
  if(Number(spent)>=2000)s+=30; else if(Number(spent)>=750)s+=20; else if(Number(spent)>0)s+=10;
  if(conversations>=10)s+=20; else if(conversations>=3)s+=12; else if(conversations>=1)s+=5;
  if(lastVisit){ const d=(Date.now()-new Date(lastVisit).getTime())/86400000; if(d<=30)s+=15; else if(d<=90)s+=8; }
  return Math.min(100,s);
}

export async function findClientByContact(tenantId, phone=null, email=null){
  const c=db(); if(!c||!tenantId)return null;
  let q=c.from('clients').select('*').eq('tenant_id',tenantId);
  if(phone) q=q.eq('phone',e164(phone)); else if(email) q=q.ilike('email',String(email).trim()); else return null;
  const {data,error}=await q.limit(1).maybeSingle(); if(error) throw error; return data||null;
}

export async function upsertClient(tenantId, data={}){
  const c=db(); if(!c||!tenantId)return null;
  let existing=null;
  if(data.id){ const r=await c.from('clients').select('*').eq('tenant_id',tenantId).eq('id',data.id).maybeSingle(); existing=r.data; }
  if(!existing && data.phone) existing=await findClientByContact(tenantId,data.phone,null);
  if(!existing && data.email) existing=await findClientByContact(tenantId,null,data.email);
  const parts=String(data.name||'').trim().split(/\s+/).filter(Boolean);
  const row={tenant_id:tenantId,updated_at:new Date().toISOString()};
  if(data.first_name||parts.length) row.first_name=data.first_name||parts.shift()||existing?.first_name||'Client';
  if(data.last_name!==undefined||parts.length) row.last_name=data.last_name!==undefined?data.last_name:(parts.join(' ')||existing?.last_name||null);
  if(data.phone) row.phone=e164(data.phone);
  if(data.email) row.email=String(data.email).trim().toLowerCase();
  if(data.notes!==undefined) row.notes=data.notes;
  if(data.preferred_service!==undefined) row.preferred_service=data.preferred_service;
  if(data.status!==undefined) row.status=data.status;
  const query=existing?.id?c.from('clients').update(row).eq('tenant_id',tenantId).eq('id',existing.id):c.from('clients').insert({...row,created_at:new Date().toISOString()});
  const {data:out,error}=await query.select().single(); if(error) throw error; return out;
}

export async function getClientMemory(clientId, tenantId, key=null){
  const c=db(); if(!c)return key?null:[];
  let q=c.from('client_memories').select('id,key,value,created_at,updated_at').eq('tenant_id',tenantId).eq('client_id',clientId).order('updated_at',{ascending:false});
  if(key) q=q.eq('key',key).limit(1);
  const {data,error}=await q; if(error) throw error;
  if(key) return data?.[0]?.value ?? null;
  return data||[];
}

export async function setClientMemory(clientId, tenantId, key, value, clientPhone=null){
  const c=db(); if(!c)return null;
  const row={tenant_id:tenantId,client_id:clientId,client_phone:clientPhone?e164(clientPhone):null,key:String(key),value,updated_at:new Date().toISOString()};
  const {data:existing}=await c.from('client_memories').select('id').eq('tenant_id',tenantId).eq('client_id',clientId).eq('key',String(key)).limit(1).maybeSingle();
  const q=existing?.id?c.from('client_memories').update(row).eq('id',existing.id):c.from('client_memories').insert({...row,created_at:new Date().toISOString()});
  const {data,error}=await q.select().single(); if(error) throw error; return data;
}

export async function rememberClientDetail(clientId, tenantId, {key,value,phone=null}){
  if(!key) throw new Error('memory key required');
  return setClientMemory(clientId,tenantId,key,value,phone);
}

export async function updateClientFromConversation(clientId, tenantId, info={}){
  const c=db(); if(!c||!clientId)return {success:false};
  const now=new Date().toISOString();
  const summary={intent:info.intent||null,mood:info.mood||null,summary:info.summary||null,channel:info.channel||null,at:now};
  await setClientMemory(clientId,tenantId,'last_conversation',summary,info.phone||null);
  if(info.mood){ await c.from('client_mood_history').insert({client_id:clientId,tenant_id:tenantId,mood:info.mood,context:{intent:info.intent||null,channel:info.channel||null}}); }
  if(info.photoAnalysis){ await c.from('photo_analyses').insert({client_id:clientId,tenant_id:tenantId,analysis_data:info.photoAnalysis,photo_url:info.photoUrl||null,risk_level:info.photoAnalysis.riskLevel||info.photoAnalysis.risk_level||null,requires_consultation:!!(info.photoAnalysis.requiresConsultation||info.photoAnalysis.requires_consultation)}); }
  await c.from('usage_events').insert({tenant_id:tenantId,kind:'crm_touch',units:1,metadata:{client_id:clientId,intent:info.intent||null,mood:info.mood||null,channel:info.channel||null}});
  return {success:true};
}

export async function getClientInsights(clientId, tenantId){
  const c=db(); if(!c||!clientId)return null;
  const [{data:client,error:ce},{data:bookings,error:be},{data:conversations,error:coe},memories]=await Promise.all([
    c.from('clients').select('*').eq('tenant_id',tenantId).eq('id',clientId).maybeSingle(),
    c.from('bookings').select('id,start_time,end_time,status,total_amount,service_id,staff_id').eq('tenant_id',tenantId).eq('client_id',clientId).order('start_time',{ascending:false}),
    c.from('conversations').select('id,channel,status,ai_summary,created_at').eq('tenant_id',tenantId).eq('client_id',clientId).order('created_at',{ascending:false}).limit(25),
    getClientMemory(clientId,tenantId)
  ]);
  if(ce) throw ce; if(be) throw be; if(coe) throw coe; if(!client)return null;
  const valid=(bookings||[]).filter(b=>!['cancelled','canceled'].includes(String(b.status||'').toLowerCase()));
  const completed=valid.filter(b=>['completed','confirmed'].includes(String(b.status||'').toLowerCase()));
  const spent=completed.reduce((s,b)=>s+Number(b.total_amount||0),0);
  const lastVisit=valid.find(b=>new Date(b.start_time).getTime()<=Date.now())?.start_time || client.last_visit || null;
  return {
    ...client,
    name:fullName(client),
    total_bookings:valid.length,
    total_spent:spent,
    total_conversations:(conversations||[]).length,
    last_booking_date:valid[0]?.start_time||null,
    last_visit:lastVisit,
    is_vip:Number(client.lifetime_value||spent)>=1000 || valid.length>=5,
    engagement_score:score({bookings:valid.length,spent,lastVisit,conversations:(conversations||[]).length}),
    memories:memories||[],
    recent_bookings:valid.slice(0,10),
    recent_conversations:conversations||[]
  };
}

export async function getVIPClients(tenantId){
  const c=db(); if(!c)return [];
  const {data,error}=await c.from('clients').select('*').eq('tenant_id',tenantId).order('lifetime_value',{ascending:false}).limit(100); if(error) throw error;
  return (data||[]).filter(x=>Number(x.lifetime_value||0)>=1000 || String(x.status||'').toLowerCase()==='vip');
}

export async function getClientsForFollowUp(tenantId, limit=50){
  const c=db(); if(!c)return [];
  const cutoff=new Date(Date.now()-30*86400000).toISOString();
  const {data,error}=await c.from('clients').select('*').eq('tenant_id',tenantId).or(`last_visit.lt.${cutoff},last_visit.is.null`).order('last_visit',{ascending:true,nullsFirst:true}).limit(limit); if(error) throw error;
  return data||[];
}

export async function getClientsBySegment(tenantId, segment='all'){
  const c=db(); if(!c)return [];
  let q=c.from('clients').select('*').eq('tenant_id',tenantId);
  if(segment==='high_value') q=q.gte('lifetime_value',1000);
  else if(segment==='inactive') q=q.lt('last_visit',new Date(Date.now()-60*86400000).toISOString());
  else if(segment==='new') q=q.gte('created_at',new Date(Date.now()-30*86400000).toISOString());
  else if(segment==='vip') q=q.or('status.eq.vip,lifetime_value.gte.1000');
  const {data,error}=await q.order('updated_at',{ascending:false}).limit(100); if(error) throw error; return data||[];
}

export async function updateClientPreferences(clientId,tenantId,preferences={}){
  const current=(await getClientMemory(clientId,tenantId,'preferences'))||{};
  return setClientMemory(clientId,tenantId,'preferences',{...current,...preferences});
}

export default {findClientByContact,upsertClient,getClientMemory,setClientMemory,rememberClientDetail,updateClientFromConversation,getClientInsights,getVIPClients,getClientsForFollowUp,getClientsBySegment,updateClientPreferences};
