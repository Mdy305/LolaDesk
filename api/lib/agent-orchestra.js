import { chat } from './llm.js';
import { executeSkill } from './orchestrator.js';

export const AGENTS = Object.freeze({
  booking: {
    label: 'Booking',
    skills: ['check_availability','book_appointment','confirm_booking','reschedule_appointment','cancel_appointment'],
    pattern: /\b(book|booking|appointment|schedule|reschedule|move|cancel|confirm|availability|opening|slot|calendar)\b/i
  },
  crm: {
    label: 'CRM',
    skills: ['capture_lead','confirm_booking'],
    pattern: /\b(client|customer|lead|profile|history|preference|notes?|membership|birthday|phone|email)\b/i
  },
  marketing: {
    label: 'Marketing',
    skills: ['handle_recovery','capture_lead'],
    pattern: /\b(marketing|campaign|promotion|offer|follow.?up|review|win.?back|reactivat|lapsed|lead)\b/i
  },
  operations: {
    label: 'Operations',
    skills: ['list_services','get_pricing','escalate'],
    pattern: /\b(revenue|operation|task|inventory|staff|team|report|kpi|performance|service menu|pricing)\b/i
  },
  communications: {
    label: 'Communications',
    skills: ['escalate','capture_lead'],
    pattern: /\b(call|text|sms|whatsapp|email|message|contact|notify|send|reply)\b/i
  },
  knowledge: {
    label: 'Knowledge',
    skills: ['list_services','get_pricing','recommend_service'],
    pattern: /\b(price|pricing|cost|service|menu|recommend|policy|hours|location|address|deposit|faq)\b/i
  },
  execution: {
    label: 'Execution',
    skills: [],
    pattern: /\b(do it|execute|complete|handle|take care|make it happen|run it)\b/i
  }
});

const CONSEQUENTIAL = new Set(['book_appointment','reschedule_appointment','cancel_appointment']);

function textOf(messages){
  const m=[...(messages||[])].reverse().find(x=>x?.role==='user');
  return typeof m?.content==='string' ? m.content.trim() : '';
}

function routeAgents(text){
  const routed=[];
  for(const [id,a] of Object.entries(AGENTS)) if(a.pattern.test(text)) routed.push(id);
  if(!routed.length) routed.push('knowledge');
  if(routed.length>1 && !routed.includes('execution')) routed.push('execution');
  return [...new Set(routed)].slice(0,4);
}

function parseDate(text){
  const t=text.toLowerCase();
  const d=new Date();
  if(/\btomorrow\b/.test(t)) d.setDate(d.getDate()+1);
  else if(/\btoday\b/.test(t)){}
  else {
    const iso=t.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    if(iso) return iso[1];
    return null;
  }
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function parseTime(text){
  const m=text.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i)||text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  return m ? m[0].replace(/\s+/g,'') : null;
}

function serviceFrom(text,tenant){
  const services=Array.isArray(tenant?.services)?tenant.services:[];
  const lower=text.toLowerCase();
  const found=services.find(s=>lower.includes(String(s?.name||s).toLowerCase()));
  if(found) return found.name||found;
  const m=lower.match(/\b(balayage|highlights?|haircut|cut|blowout|keratin|botox|extensions?|facial|massage|manicure|pedicure)\b/);
  return m?.[1]||null;
}

function nameFrom(text){
  const m=text.match(/\b(?:for|client|customer)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  return m?.[1]||null;
}

function phoneFrom(text){
  const m=text.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  return m?.[0]||null;
}

function chooseSkill(text,tenant){
  const t=text.toLowerCase();
  const base={service:serviceFrom(text,tenant),date:parseDate(text),time:parseTime(text),client_name:nameFrom(text),client_phone:phoneFrom(text)};
  if(/\b(cancel)\b/.test(t)) return {name:'cancel_appointment',args:{client_phone:base.client_phone}};
  if(/\b(reschedule|move|change.*appointment)\b/.test(t)) return {name:'reschedule_appointment',args:{client_phone:base.client_phone,new_date:base.date,new_time:base.time}};
  if(/\b(confirm.*booking|confirm.*appointment|am i booked)\b/.test(t)) return {name:'confirm_booking',args:{client_phone:base.client_phone,client_name:base.client_name}};
  if(/\b(availability|opening|slot|free|available)\b/.test(t)) return {name:'check_availability',args:{service:base.service,date:base.date}};
  if(/\b(book|schedule|rebook)\b/.test(t)) return {name:'book_appointment',args:base};
  if(/\b(price|pricing|cost|how much)\b/.test(t)) return {name:'get_pricing',args:{service:base.service}};
  if(/\b(recommend|what should|best service)\b/.test(t)) return {name:'recommend_service',args:{goal:text}};
  if(/\b(service|menu|offer)\b/.test(t)) return {name:'list_services',args:{}};
  if(/\b(win.?back|lapsed|recovery|come back)\b/.test(t)) return {name:'handle_recovery',args:{client_name:base.client_name}};
  if(/\b(lead|interested|follow.?up)\b/.test(t)) return {name:'capture_lead',args:{client_name:base.client_name,client_phone:base.client_phone,service_requested:base.service}};
  if(/\b(message|escalate|human|manager|team)\b/.test(t)) return {name:'escalate',args:{message:text,client_name:base.client_name,client_phone:base.client_phone}};
  return null;
}

function needsConfirmation(skill,args,text){
  if(!CONSEQUENTIAL.has(skill)) return false;
  if(/\b(confirm|yes|do it|go ahead|proceed|make it|book it|cancel it|move it)\b/i.test(text)) return false;
  if(skill==='book_appointment') return !(args?.service&&args?.date&&args?.time&&args?.client_name);
  if(skill==='reschedule_appointment') return !(args?.new_date&&args?.new_time);
  return true;
}

function planSummary(routes,skill){
  return {agents:routes.map(id=>({id,label:AGENTS[id].label})),skill:skill?.name||null};
}

export async function runAgentOrchestra({tenant,messages,skillsRegistry,memoryBlock='',channel='dashboard_voice',confirmed=false}){
  const userText=textOf(messages);
  const routes=routeAgents(userText);
  const chosen=chooseSkill(userText,tenant);
  const plan=planSummary(routes,chosen);

  if(chosen && skillsRegistry?.[chosen.name]){
    if(!confirmed && needsConfirmation(chosen.name,chosen.args,userText)){
      return {
        ok:true,
        executed:false,
        needs_confirmation:true,
        content:`I can handle that. Confirm the final details${chosen.args?.date?` for ${chosen.args.date}`:''}${chosen.args?.time?` at ${chosen.args.time}`:''}, and I’ll execute it.`,
        orchestration:plan,
        pending:{skill:chosen.name,args:chosen.args}
      };
    }
    const output=await executeSkill(tenant,chosen.args?.client_phone||null,chosen.name,chosen.args,skillsRegistry);
    const success=!(output?.error||output?.booked===false||output?.rescheduled===false||output?.cancelled===false||output?.captured===false);
    return {
      ok:success,
      executed:true,
      content:output?.speak || (success?'Done.':'I could not complete that action.'),
      result:output,
      orchestration:plan
    };
  }

  const orchestraPrompt=`You are Lola, the single conductor and voice of LolaDesk. Internal specialists are silent: Booking, CRM, Marketing, Operations, Communications, Knowledge, and Execution. Never expose internal agent names unless asked for diagnostics. Merge their expertise into one decisive answer. Use tenant facts only. Never claim an action happened unless an execution result proves success. Keep voice answers concise.\nActive internal routes: ${routes.join(', ')}.\n${memoryBlock}`;
  const result=await chat({system:orchestraPrompt,messages,maxTokens:650,temperature:0.45});
  if(!result.ok) return {ok:false,executed:false,content:'My action systems are temporarily degraded. I can still help with bookings, availability, services, and pricing.',orchestration:plan,error:result.error};
  return {ok:true,executed:false,content:String(result.text||'').trim(),orchestration:plan,provider:result.provider,model:result.model};
}
