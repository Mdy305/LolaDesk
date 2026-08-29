/**
 * /api/agent-variables — Telnyx Dynamic Variables Webhook
 * ONE Lola assistant serves EVERY salon. Telnyx POSTs here before
 * speaking; we resolve which tenant owns the dialed number and return
 * that salon's real data from the database.
 */
import { getClientByPhone, getClientMemory, tenantKnowledgePrompt, db } from './lib/db.js';
import { resolveInboundTenant } from './lib/tenant-resolver.js';

function pickToNumber(b){
  return b?.data?.payload?.to || b?.payload?.to || b?.to ||
    b?.data?.payload?.to_number || b?.telephony_data?.to || b?.call?.to ||
    (Array.isArray(b?.to) ? b.to[0]?.phone_number : null) || b?.To || '';
}
function pickFromNumber(b){
  return b?.data?.payload?.from || b?.payload?.from || b?.from ||
    b?.data?.payload?.from_number || b?.telephony_data?.from || b?.call?.from || b?.From || '';
}

function callerMemory(client){
  if(!client || !client.name) return { caller_known:'false', caller_name:'', caller_brief:'' };
  const bits = [];
  if(client.last_service) bits.push('last came in for ' + client.last_service);
  if(client.preferred_stylist) bits.push('usually sees ' + client.preferred_stylist);
  if(client.last_visit){
    const days = Math.floor((Date.now() - new Date(client.last_visit).getTime()) / 86400000);
    if(days > 0 && days < 400) bits.push('last visit ~' + days + ' days ago');
  }
  if(client.is_vip) bits.push('is a VIP client');
  if(client.notes) bits.push('note: ' + client.notes);
  return {
    caller_known: 'true',
    caller_name: client.name,
    caller_brief: bits.length ? client.name + ' — ' + bits.join(', ') + '.' : client.name + ' is a returning client.',
    caller_vip: client.is_vip ? 'true' : 'false',
    caller_stylist: client.preferred_stylist || ''
  };
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();

  try{
    const body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});
    const qTo = (()=>{ try{ return new URL(req.url,'http://x').searchParams.get('to'); }catch{ return null; } })();
    const toNumber = qTo || pickToNumber(body);
    const fromNumber = pickFromNumber(body);

    // ── MULTI-TENANT ROUTING (the literal "before she speaks" gate) ──
    // Telnyx calls this webhook to fetch the AI assistant's system facts
    // BEFORE the first syllable. If the dialed number can't be resolved to
    // exactly one tenant, return NEUTRAL placeholders — never the demo
    // salon's name/services, never another tenant's data.
    const routing = await resolveInboundTenant({ to: toNumber, from: fromNumber });
    const tenant = routing.status === 'resolved' ? routing.tenant : null;

    // ── POST-CALL INSIGHTS CORRELATION ──
    // The post-call insights webhook (call.conversation_insights.generated)
    // arrives with only call ids — no dialed number — so record this
    // conversation's call_control_id → tenant mapping now, while the dialed
    // number is known. Best-effort: never let this break the 1s response.
    if(tenant?.id){
      const callControlId = body?.data?.payload?.call_control_id || body?.call_control_id || null;
      if(callControlId){
        try{
          const c2 = db();
          if(c2) await c2.from('call_sessions').upsert({
            call_control_id: callControlId,
            tenant_id: tenant.id,
            from_number: fromNumber || null,
            to_number: toNumber || null
          }, { onConflict: 'call_control_id' });
        }catch(e){ /* never block the variable fetch */ }
      }
    }

    if(!tenant){
      return res.status(200).json({
        dynamic_variables: {
          tenant_id: '',
          to: toNumber || '',
          from: fromNumber || '',
          company_name: 'our salon',
          business_type: 'salon',
          location: '', hours: '', services: '', staff: '', marketing_context: '',
          booking_url: '', knowledge: '',
          caller_known: 'false', caller_name: '', caller_brief: ''
        },
        routing: { status: routing.status, reason: routing.reason || null }
      });
    }

    let memory = { caller_known:'false', caller_name:'', caller_brief:'' };
    try{
      if(tenant?.id && fromNumber){
        const client = await getClientByPhone(tenant.id, fromNumber);
        // Resolve the stylist's NAME from preferred_staff_id (the canonical
        // schema has no preferred_stylist text column).
        if(client?.preferred_staff_id){
          const c2 = db();
          const { data: st } = await c2.from('staff').select('name').eq('id', client.preferred_staff_id).maybeSingle();
          if(st?.name) client.preferred_stylist = st.name;
        }
        memory = callerMemory(client);
        // ── LOLA REMEMBERS: fold the caller's LAST call memory (written by
        // the post-call insights pipeline, keyed 'last_call') into the brief
        // so the next call repeats what happened — "last call you booked a
        // balayage". Best-effort; a memory read failure never blocks the
        // 1s dynamic-variables response.
        const mem = await getClientMemory(tenant.id, fromNumber);
        const lastCall = mem.find(m => m.key === 'last_call');
        if(lastCall?.value){
          const v = typeof lastCall.value === 'string' ? JSON.parse(lastCall.value) : lastCall.value;
          const outcome = String(v?.outcome || '').trim();
          const summary = String(v?.summary || '').trim();
          // 'booked' marker only when the outcome doesn't already say it.
          const booked = (v?.booked && outcome.toLowerCase() !== 'booked') ? 'booked' : null;
          const tail = [booked, outcome, summary].filter(Boolean).join(' · ');
          if(tail){
            memory.caller_known = 'true';
            memory.caller_brief = (memory.caller_brief ? memory.caller_brief + ' ' : '') +
              'Last call: ' + tail + '.';
          }
        }
      }
    }catch(e){}

    let services = '', staffList = '', marketingContext = '';
    try{
      const c = db();
      if(c && tenant?.id){
        const [svcRes, stfRes, miRes] = await Promise.all([
          c.from('services').select('name,price,duration_minutes').eq('tenant_id',tenant.id).eq('is_active',true).order('name'),
          c.from('staff').select('name,role').eq('tenant_id',tenant.id).eq('is_active',true).order('name'),
          c.from('marketing_intelligence').select('kind,title,summary').eq('tenant_id',tenant.id).order('created_at',{ascending:false}).limit(5)
        ]);
        services = (svcRes.data||[]).map(s => s.name + (s.price ? ' $'+s.price : '') + (s.duration_minutes ? ' ('+s.duration_minutes+'min)' : '')).join('; ');
        staffList = (stfRes.data||[]).map(s => s.name + (s.role ? ' ('+s.role+')' : '')).join(', ');
        marketingContext = (miRes.data||[]).map(m => m.kind + ': ' + (m.title||'') + (m.summary ? ' - '+m.summary : '')).join(' | ');
      }
    }catch(e){}

    if(!services && tenant?.services?.length){
      services = tenant.services.map(s => s.name + (s.price ? ' $'+s.price : '') + (s.duration ? ' ('+s.duration+')' : '')).join('; ');
    }

    const dynamic_variables = {
      tenant_id: tenant.id || '',
      to: toNumber || '',
      from: fromNumber || '',
      company_name: tenant.name || 'our salon',
      business_type: tenant.business_mode || 'salon',
      location: tenant.location || '',
      hours: tenant.hours || '',
      services: services || '',
      staff: staffList || '',
      marketing_context: marketingContext || '',
      booking_url: tenant.booking_url || ('https://www.loladesk.com/book.html?t=' + (tenant.slug||'')),
      knowledge: tenantKnowledgePrompt(tenant),
      ...memory
    };

    return res.status(200).json({ dynamic_variables });
  }catch(e){
    return res.status(200).json({
      dynamic_variables: {
        company_name: 'our salon',
        business_type: 'salon',
        services: '', staff: '', hours: '', booking_url: '', marketing_context: ''
      },
      _error: String(e)
    });
  }
}
