/**
 * /api/agent-variables — Telnyx Dynamic Variables Webhook
 * ONE Lola assistant serves EVERY salon. Telnyx POSTs here before
 * speaking; we resolve which tenant owns the dialed number and return
 * that salon's real data from the database.
 */
import { getClientByPhone, getClientMemory, db } from './lib/db.js';
import { buildTenantVariables } from './lib/tenant-variables.js';
import { resolveInboundTenant } from './lib/tenant-resolver.js';
import { clientStory, welcomeBack } from './lib/client-brain.js';
import { discloseGreeting } from './lib/legal.js';

// Her first words on this call: a returning client is welcomed by name with their last visit;
// everyone hears that the call may be recorded and that she's an AI.
export function greetingFor(salon, story){
  const hi = story && story.known ? welcomeBack(story, { salon, voice: true }) : '';
  return discloseGreeting(hi || `Thanks for calling ${salon || 'the salon'}! This is Lola. How can I help you today?`);
}

function pickToNumber(b){
  // Telnyx AI Assistant dynamic-variables payloads name the numbers
  // telnyx_agent_target (the salon line) and telnyx_end_user_target (the caller).
  return b?.data?.payload?.telnyx_agent_target || b?.telnyx_agent_target || b?.data?.payload?.to || b?.payload?.to || b?.to ||
    b?.data?.payload?.to_number || b?.telephony_data?.to || b?.call?.to ||
    (Array.isArray(b?.to) ? b.to[0]?.phone_number : null) || b?.To || '';
}
function pickFromNumber(b){
  return b?.data?.payload?.telnyx_end_user_target || b?.telnyx_end_user_target || b?.data?.payload?.from || b?.payload?.from || b?.from ||
    b?.data?.payload?.from_number || b?.telephony_data?.from || b?.call?.from || b?.From || '';
}

function callerMemory(client){
  if(client && !client.name) client.name = [client.first_name, client.last_name].filter(Boolean).join(' ').trim();
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
      // The assistant event family carries the session ids under
      // data.payload.* (same shape as call.conversation.ended / the
      // insights webhook). Parse defensively — call_control_id is the
      // authoritative correlation key; the session id, when present, rides
      // along and backfills at call end if this webhook lacked it.
      const callSessionId = body?.data?.payload?.call_session_id || body?.data?.call_session_id || body?.call_session_id || null;
      const callLegId = body?.data?.payload?.call_leg_id || body?.data?.call_leg_id || body?.call_leg_id || null;
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

        // LIVE CALL ROW: persist the calls row at conversation start so the
        // operator dashboard's Lola Live panel streams this call WHILE Lola
        // is talking — not only after post-call insights land. Best-effort,
        // exactly like call_sessions: a DB hiccup here must never break the
        // 1s dynamic-variables response Telnyx is waiting on.
        try{
          const c3 = db();
          if(c3){
            const existing = await c3.from('calls')
              .select('id,status,call_session_id')
              .eq('telnyx_call_control_id', callControlId)
              .maybeSingle()
              .catch(() => ({ data: null }));
            if(existing?.data?.id){
              // Same call reconnecting (Telnyx retries the variable fetch)
              // → bring the row back to live and backfill a session id if
              // this request carries one the row never got.
              const patch = { status: 'in_progress' };
              if(callSessionId) patch.call_session_id = callSessionId;
              if(callLegId) patch.call_leg_id = callLegId;
              await c3.from('calls').update(patch).eq('id', existing.data.id);
            } else {
              await c3.from('calls').insert({
                tenant_id: tenant.id,
                from_number: fromNumber || null,
                to_number: toNumber || null,
                direction: 'inbound',
                status: 'in_progress',
                telnyx_call_control_id: callControlId,
                call_session_id: callSessionId || null,
                call_leg_id: callLegId || null
              });
            }
          }
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
          caller_known: 'false', caller_name: '', caller_brief: '',
          lola_greeting: greetingFor('', null)
        },
        routing: { status: routing.status, reason: routing.reason || null }
      });
    }

    let memory = { caller_known:'false', caller_name:'', caller_brief:'' };
    let story = null;
    try{
      if(tenant?.id && fromNumber){
        const client = await getClientByPhone(tenant.id, fromNumber);
        try{ story = client ? await clientStory(db(), tenant, client) : null; }catch(_){}
        // Resolve the stylist's NAME from preferred_staff_id (the canonical
        // schema has no preferred_stylist text column).
        if(client?.preferred_staff_id){
          const c2 = db();
          const { data: st } = await c2.from('staff').select('name').eq('id', client.preferred_staff_id).maybeSingle();
          if(st?.name) client.preferred_stylist = st.name;
        }
        memory = callerMemory(client);
        if(story?.brief){ memory.caller_known = 'true'; memory.caller_brief = story.brief + '.'; }
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

    // ONE source of truth: the same builder the dashboard orb uses, so the
    // phone path and the orb path can never disagree on Lola's facts.
    const dynamic_variables = await buildTenantVariables(tenant, {
      to: toNumber,
      from: fromNumber,
      memory
    });

    dynamic_variables.lola_greeting = greetingFor(tenant.name, story);
    return res.status(200).json({ dynamic_variables });
  }catch(e){
    return res.status(200).json({
      dynamic_variables: {
        company_name: 'our salon',
        business_type: 'salon',
        services: '', staff: '', hours: '', booking_url: '', marketing_context: '',
        lola_greeting: greetingFor('', null)
      },
      _error: String(e)
    });
  }
}
